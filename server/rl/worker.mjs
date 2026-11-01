import { parentPort, threadId } from 'node:worker_threads';
import { createGame, placements, place, EMPTY } from '../../public/game/engine.js';
import { ACTION_COUNT, episodeSeed, rulesVersions } from './protocol.mjs';

const sessions = new Map();
const fail = (status, code, message) => {
  throw Object.assign(new Error(message), { status, code });
};

function getEnv(sessionId, envId) {
  const env = sessions.get(sessionId)?.get(envId);
  if (!env) fail(404, 'RL_ENV_NOT_FOUND', 'RL 환경을 찾을 수 없습니다.');
  return env;
}

function maskFor(state) {
  const mask = Array(ACTION_COUNT).fill(0);
  for (let slot = 0; slot < 3; slot++) {
    if (state.tray[slot] === -1) continue;
    for (const { row, col } of placements(state.board, state.tray[slot])) {
      mask[slot * 64 + row * 8 + col] = 1;
    }
  }
  return mask;
}

function observation(state) {
  return {
    board: state.board.map(row => row.map(cell => Number(cell !== EMPTY))),
    tray: state.tray.slice(),
    score: state.score,
    combo: state.combo,
    unEliminateTimes: state.unEliminateTimes,
    round: state.round,
    moves: state.moves,
  };
}

function resultFor(env, reward = 0, move = null, actionValid = null) {
  return {
    envId: env.envId,
    episodeId: env.episodeId,
    version: env.version,
    observation: observation(env.state),
    actionMask: env.actionMask,
    reward,
    terminated: env.terminated,
    truncated: env.truncated,
    info: {
      ...rulesVersions,
      scoreDelta: reward,
      actionValid,
      invalidActionReason: actionValid === false ? 'illegal_placement' : null,
      episodeSteps: env.episodeSteps,
      lines: env.state.lines,
      clearedRows: move?.clearedRows ?? [],
      clearedCols: move?.clearedCols ?? [],
      refilled: move?.refilled ?? false,
      scoreBreakdown: move?.scoreBreakdown ?? { placement: 0, elimination: 0, allClear: 0 },
      terminalReason: env.terminated ? 'no_legal_moves' : env.truncated ? 'max_episode_steps' : null,
    },
  };
}

function newEnv(envId, baseSeed, maxEpisodeSteps, previous = null, explicitSeed = false,
  invalidActionMode = previous?.invalidActionMode ?? 'reject') {
  const episodeId = previous ? previous.episodeId + 1 : 0;
  const state = createGame(episodeSeed(baseSeed, envId, explicitSeed ? 0 : episodeId));
  const actionMask = maskFor(state);
  return {
    envId, baseSeed, maxEpisodeSteps, invalidActionMode, episodeId, state, actionMask,
    version: previous ? previous.version + 1 : 1,
    episodeSteps: 0,
    terminated: !actionMask.some(Boolean),
    truncated: false,
    lastMove: null,
    updatedAt: new Date().toISOString(),
  };
}

function perform(message) {
  const { op, sessionId } = message;
  if (op === 'create') {
    const envs = new Map();
    for (const envId of message.envIds) {
      envs.set(envId, newEnv(envId, message.seed, message.maxEpisodeSteps, null, false, message.invalidActionMode));
    }
    sessions.set(sessionId, envs);
    return [...envs.values()].map(env => resultFor(env));
  }
  if (op === 'delete') {
    sessions.delete(sessionId);
    return { deleted: true };
  }
  if (op === 'reset') {
    const changes = message.envIds.map(envId => {
      const previous = getEnv(sessionId, envId);
      return newEnv(envId, message.seed ?? previous.baseSeed, previous.maxEpisodeSteps, previous, message.seed !== undefined);
    });
    // Calculate the entire local batch before replacing any environment.
    const results = changes.map(env => resultFor(env));
    for (const env of changes) sessions.get(sessionId).set(env.envId, env);
    return results;
  }
  if (op === 'step') {
    // The coordinator validates the complete cross-worker batch first. This
    // second check also makes an individual worker's batch transactional.
    const entries = message.actions.map(({ envId, action }) => {
      const previous = getEnv(sessionId, envId);
      if (action !== null && (previous.terminated || previous.truncated)) {
        fail(422, 'RL_ENV_DONE', '종료된 환경을 먼저 reset해야 합니다.');
      }
      if (action !== null && (!Number.isInteger(action) || action < 0 || action >= ACTION_COUNT)) {
        fail(400, 'INVALID_ACTION', 'action은 0~191 정수 또는 null이어야 합니다.');
      }
      if (action !== null && !previous.actionMask[action] && previous.invalidActionMode === 'reject') {
        fail(422, 'ILLEGAL_ACTION', '현재 환경에서 사용할 수 없는 action입니다.');
      }
      return { previous, action };
    });
    const changes = entries.map(({ previous, action }) => {
      if (action === null) return { env: previous, result: resultFor(previous) };
      if (!previous.actionMask[action]) {
        const episodeSteps = previous.episodeSteps + 1;
        const env = {
          ...previous, episodeSteps, version: previous.version + 1,
          truncated: !previous.terminated && episodeSteps >= previous.maxEpisodeSteps,
          lastMove: null, updatedAt: new Date().toISOString(),
        };
        return { env, result: resultFor(env, 0, null, false) };
      }
      const slot = Math.floor(action / 64);
      const row = Math.floor((action % 64) / 8);
      const col = action % 8;
      const move = place(previous.state, slot, row, col);
      if (!move) fail(500, 'RL_ENGINE_ERROR', '검증된 action을 적용하지 못했습니다.');
      const actionMask = maskFor(move.state);
      const terminated = !actionMask.some(Boolean);
      const episodeSteps = previous.episodeSteps + 1;
      const lastMove = {
        slot, row, col, points: move.points,
        clearedRows: move.clearedRows, clearedCols: move.clearedCols,
        refilled: move.refilled, clearScreen: move.clearScreen,
        clearScreenBonus: move.clearScreenBonus, scoreBreakdown: move.scoreBreakdown,
      };
      const env = {
        ...previous, state: move.state, actionMask, episodeSteps, terminated,
        truncated: !terminated && episodeSteps >= previous.maxEpisodeSteps,
        version: previous.version + 1,
        lastMove, updatedAt: new Date().toISOString(),
      };
      return { env, result: resultFor(env, move.state.score - previous.state.score, move, true) };
    });
    for (const { env } of changes) sessions.get(sessionId).set(env.envId, env);
    return changes.map(change => change.result);
  }
  if (op === 'snapshot') {
    const env = getEnv(sessionId, message.envId);
    return {
      id: `${sessionId}-${env.envId}`,
      version: env.version,
      state: env.state,
      gameOver: env.terminated,
      canUndo: false,
      legalMoves: env.state.tray.map((id, slot) => ({
        slot, id, positions: id === -1 ? [] : placements(env.state.board, id),
      })),
      lastMove: env.lastMove,
      updatedAt: env.updatedAt,
    };
  }
  fail(400, 'RL_UNKNOWN_OPERATION', '알 수 없는 RL worker 작업입니다.');
}

parentPort.on('message', message => {
  try {
    parentPort.postMessage({ requestId: message.requestId, result: perform(message), threadId });
  } catch (error) {
    parentPort.postMessage({ requestId: message.requestId, error: {
      status: error.status ?? 500,
      code: error.code ?? 'RL_WORKER_ERROR',
      message: error.message ?? 'RL worker 작업에 실패했습니다.',
    } });
  }
});
