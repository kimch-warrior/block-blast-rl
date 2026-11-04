import { parentPort, threadId } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { createGame, placements, place, EMPTY } from '../../public/game/engine.js';
import { ACTION_COUNT, episodeSeed, rulesVersions } from './protocol.mjs';
import { SCHEMA_VERSION, stateDigest } from './history-format.mjs';

const sessions = new Map();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const emptyScore = () => ({ placement: 0, elimination: 0, allClear: 0 });

function getEnv(sessionId, envId) {
  const env = sessions.get(sessionId)?.get(envId);
  if (!env) fail(404, 'RL_ENV_NOT_FOUND', 'RL 환경을 찾을 수 없습니다.');
  return env;
}

function maskFor(state) {
  const mask = Array(ACTION_COUNT).fill(0);
  for (let slot = 0; slot < 3; slot++) {
    if (state.tray[slot] === -1) continue;
    for (const { row, col } of placements(state.board, state.tray[slot])) mask[slot * 64 + row * 8 + col] = 1;
  }
  return mask;
}

function observation(state) {
  return {
    board: state.board.map(row => row.map(cell => Number(cell !== EMPTY))),
    tray: state.tray.slice(), score: state.score, combo: state.combo,
    unEliminateTimes: state.unEliminateTimes, round: state.round, moves: state.moves,
  };
}

function resultFor(env, reward = 0, move = null, actionValid = null) {
  return {
    envId: env.envId, episodeId: env.episodeId, gameId: env.gameId, version: env.version,
    observation: observation(env.state), actionMask: env.actionMask, reward,
    terminated: env.terminated, truncated: env.truncated,
    info: {
      ...rulesVersions, scoreDelta: reward, actionValid,
      invalidActionReason: actionValid === false ? 'illegal_placement' : null,
      episodeSteps: env.episodeSteps, placementCount: env.placementCount, lines: env.state.lines,
      clearedRows: move?.clearedRows ?? [], clearedCols: move?.clearedCols ?? [],
      refilled: move?.refilled ?? false, scoreBreakdown: move?.scoreBreakdown ?? emptyScore(),
      terminalReason: env.terminated ? 'no_legal_moves' : env.truncated ? 'max_episode_steps' : null,
    },
  };
}

function snapshotFor(env) {
  // Legal positions are reconstructed from the committed mask by the parent.
  return {
    id: `${env.sessionId}-${env.envId}`, sessionId: env.sessionId, gameId: env.gameId,
    envId: env.envId, episodeId: env.episodeId, version: env.version, state: env.state,
    gameOver: env.terminated, canUndo: false, lastMove: env.lastMove, updatedAt: env.updatedAt,
  };
}

function headerFor(env) {
  return {
    schemaVersion: SCHEMA_VERSION, sessionId: env.sessionId, gameId: env.gameId, envId: env.envId,
    episodeId: env.episodeId, baseSeed: env.sessionBaseSeed, gameBaseSeed: env.baseSeed,
    initialGameSeed: env.initialGameSeed, initialState: env.initialState,
    ...rulesVersions,
    execution: { maxEpisodeSteps: env.maxEpisodeSteps, invalidActionMode: env.invalidActionMode },
    policyMetadata: env.policyMetadata, startedAt: env.startedAt, endedAt: null,
  };
}

function endFor(env, endReason) {
  return {
    sessionId: env.sessionId, gameId: env.gameId, endReason,
    endedAt: new Date().toISOString(), finalState: env.state,
    attemptCount: env.episodeSteps, placementCount: env.placementCount,
    terminated: env.terminated, truncated: env.truncated,
  };
}

function terminalEnd(env) {
  return env.terminated ? endFor(env, 'game_over')
    : env.truncated ? endFor(env, 'max_episode_steps') : null;
}

function newEnv(sessionId, envId, baseSeed, maxEpisodeSteps, previous = null,
  explicitSeed = false, invalidActionMode = previous?.invalidActionMode ?? 'reject',
  sessionBaseSeed = previous?.sessionBaseSeed ?? baseSeed, policyMetadata = previous?.policyMetadata ?? {}) {
  const episodeId = previous ? previous.episodeId + 1 : 0;
  const startedAt = new Date().toISOString();
  // Capture the exact argument now, before createGame advances its RNG stream.
  const initialGameSeed = episodeSeed(baseSeed, envId, explicitSeed ? 0 : episodeId);
  const state = createGame(initialGameSeed);
  const actionMask = maskFor(state);
  return {
    sessionId, envId, baseSeed, sessionBaseSeed, maxEpisodeSteps, invalidActionMode,
    episodeId, gameId: randomUUID(), initialGameSeed, initialState: structuredClone(state),
    policyMetadata, startedAt, state, actionMask,
    version: previous ? previous.version + 1 : 1,
    episodeSteps: 0, placementCount: 0, terminated: !actionMask.some(Boolean), truncated: false,
    lastMove: null, updatedAt: startedAt,
  };
}

function envelope(changes, { starts = [], steps = [], ends = [] } = {}) {
  return {
    results: changes.map(change => change.result ?? resultFor(change.env)),
    snapshots: changes.map(change => snapshotFor(change.env)), starts, steps, ends,
  };
}

function stepRecord(previous, env, action, requestId, actionValid, move) {
  const slot = Math.floor(action / 64), y = Math.floor((action % 64) / 8), x = action % 8;
  return {
    sessionId: env.sessionId, gameId: env.gameId, envId: env.envId, episodeId: env.episodeId,
    step: previous.episodeSteps, requestId, action, slot, blockId: previous.state.tray[slot], x, y,
    actionValid, scoreDelta: env.state.score - previous.state.score,
    scoreAfter: env.state.score, comboAfter: env.state.combo,
    clearedRows: move?.clearedRows ?? [], clearedCols: move?.clearedCols ?? [],
    refilled: move?.refilled ?? false, trayAfter: env.state.tray.slice(), colorsAfter: env.state.colors.slice(),
    scoreBreakdown: move?.scoreBreakdown ?? emptyScore(),
    clearScreen: move?.clearScreen ?? false, clearScreenBonus: move?.clearScreenBonus ?? 0,
    attemptCount: env.episodeSteps, placementCount: env.placementCount,
    terminated: env.terminated, truncated: env.truncated, appliedAt: env.updatedAt,
    stateHashAfter: stateDigest(env.state),
    stateAfter: env.state,
  };
}

function perform(message) {
  const { op, sessionId } = message;
  if (op === 'create') {
    const envs = new Map();
    for (const envId of message.envIds) {
      envs.set(envId, newEnv(sessionId, envId, message.seed, message.maxEpisodeSteps,
        null, false, message.invalidActionMode, message.seed, message.policyMetadata));
    }
    sessions.set(sessionId, envs);
    const changes = [...envs.values()].map(env => ({ env }));
    return envelope(changes, { starts: changes.map(({ env }) => headerFor(env)),
      ends: changes.map(({ env }) => terminalEnd(env)).filter(Boolean) });
  }
  if (op === 'delete') {
    sessions.delete(sessionId);
    return envelope([]);
  }
  if (op === 'reset') {
    const ends = [];
    const changes = message.envIds.map(envId => {
      const previous = getEnv(sessionId, envId);
      if (!previous.terminated && !previous.truncated) ends.push(endFor(previous, 'manual_reset'));
      return { env: newEnv(sessionId, envId, message.seed ?? previous.baseSeed,
        previous.maxEpisodeSteps, previous, message.seed !== undefined) };
    });
    for (const { env } of changes) sessions.get(sessionId).set(env.envId, env);
    return envelope(changes, { starts: changes.map(({ env }) => headerFor(env)), ends });
  }
  if (op === 'step') {
    const entries = message.actions.map(({ envId, action }) => {
      const previous = getEnv(sessionId, envId);
      if (action !== null && (previous.terminated || previous.truncated)) fail(422, 'RL_ENV_DONE', '종료된 환경을 먼저 reset해야 합니다.');
      if (action !== null && (!Number.isInteger(action) || action < 0 || action >= ACTION_COUNT)) fail(400, 'INVALID_ACTION', 'action은 0~191 정수 또는 null이어야 합니다.');
      if (action !== null && !previous.actionMask[action] && previous.invalidActionMode === 'reject') fail(422, 'ILLEGAL_ACTION', '현재 환경에서 사용할 수 없는 action입니다.');
      return { previous, action };
    });
    const steps = [], ends = [];
    const changes = entries.map(({ previous, action }) => {
      if (action === null) return { env: previous, result: resultFor(previous) };
      const episodeSteps = previous.episodeSteps + 1;
      let env, move = null;
      const actionValid = previous.actionMask[action] === 1;
      if (!actionValid) {
        env = { ...previous, episodeSteps, version: previous.version + 1,
          truncated: episodeSteps >= previous.maxEpisodeSteps, lastMove: null,
          updatedAt: new Date().toISOString() };
      } else {
        const slot = Math.floor(action / 64), row = Math.floor((action % 64) / 8), col = action % 8;
        move = place(previous.state, slot, row, col);
        if (!move) fail(500, 'RL_ENGINE_ERROR', '검증된 action을 적용하지 못했습니다.');
        const actionMask = maskFor(move.state), terminated = !actionMask.some(Boolean);
        const lastMove = { slot, row, col, points: move.points, clearedRows: move.clearedRows,
          clearedCols: move.clearedCols, refilled: move.refilled, clearScreen: move.clearScreen,
          clearScreenBonus: move.clearScreenBonus, scoreBreakdown: move.scoreBreakdown };
        env = { ...previous, state: move.state, actionMask, episodeSteps, terminated,
          placementCount: previous.placementCount + 1,
          truncated: !terminated && episodeSteps >= previous.maxEpisodeSteps,
          version: previous.version + 1, lastMove, updatedAt: new Date().toISOString() };
      }
      steps.push(stepRecord(previous, env, action, message.commandRequestId, actionValid, move));
      const end = terminalEnd(env);
      if (end) ends.push(end);
      return { env, result: resultFor(env, env.state.score - previous.state.score, move, actionValid) };
    });
    for (const { env } of changes) sessions.get(sessionId).set(env.envId, env);
    return envelope(changes, { steps, ends });
  }
  fail(400, 'RL_UNKNOWN_OPERATION', '알 수 없는 RL worker 작업입니다.');
}

parentPort.on('message', message => {
  try {
    parentPort.postMessage({ requestId: message.requestId, result: perform(message), threadId });
  } catch (error) {
    parentPort.postMessage({ requestId: message.requestId, error: {
      status: error.status ?? 500, code: error.code ?? 'RL_WORKER_ERROR',
      message: error.message ?? 'RL worker 작업에 실패했습니다.',
    } });
  }
});
