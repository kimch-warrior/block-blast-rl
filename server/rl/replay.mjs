import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createGame, isGameOver, place } from '../../public/game/engine.js';
import { ENGINE_RULES_VERSION, SCORE_RULES_VERSION } from './protocol.mjs';
import { decodeGameRow, historyError, SCHEMA_VERSION, stateDigest, validateIdentifier } from './history-format.mjs';

function mismatch(message) {
  throw historyError(422, 'REPLAY_MISMATCH', message);
}

function equal(actual, expected, description) {
  if (!isDeepStrictEqual(actual, expected)) mismatch(`재생 검증 실패: ${description}`);
}

/** Reconstruct a recorded game. steps can be a streaming SQLite iterator. */
export function replayGameRecord(game, steps) {
  if (game.schemaVersion !== SCHEMA_VERSION || game.engineRulesVersion !== ENGINE_RULES_VERSION ||
      game.scoreRulesVersion !== SCORE_RULES_VERSION) {
    throw historyError(409, 'UNSUPPORTED_RULES', '현재 엔진으로 재생할 수 없는 기록 형식 또는 규칙 버전입니다.');
  }
  if (!Number.isInteger(game.initialGameSeed)) mismatch('최초 게임 생성 시드가 없습니다.');
  const execution = game.execution;
  if (!execution || !Number.isSafeInteger(execution.maxEpisodeSteps) || execution.maxEpisodeSteps < 1 ||
      !['reject', 'transition'].includes(execution.invalidActionMode)) mismatch('실행 조건이 올바르지 않습니다.');

  // Use the exact argument captured at creation, never a reconstructed episode
  // seed or the evolving RNG state stored in state.seed.
  let state = createGame(game.initialGameSeed);
  equal(state, game.initialState, '최초 상태');
  let attemptCount = 0;
  let placementCount = 0;
  let terminated = isGameOver(state);
  let truncated = false;

  for (const step of steps) {
    if (terminated || truncated) mismatch('종료된 게임에 후속 행동이 있습니다.');
    equal(step.sessionId, game.sessionId, '세션 식별자');
    equal(step.gameId, game.gameId, '게임 식별자');
    equal(step.step, attemptCount, '행동 순서');
    if (!Number.isInteger(step.action) || step.action < 0 || step.action >= 192) mismatch('행동 번호');
    const slot = Math.floor(step.action / 64);
    const y = Math.floor((step.action % 64) / 8);
    const x = step.action % 8;
    equal(step.slot, slot, '블록 슬롯');
    equal(step.x, x, 'x=col 좌표');
    equal(step.y, y, 'y=row 좌표');
    equal(step.blockId, state.tray[slot], '배치 전 블록 ID');

    const move = place(state, slot, y, x);
    equal(step.actionValid, Boolean(move), '배치 가능 여부');
    if (!move && execution.invalidActionMode !== 'transition') mismatch('reject 모드의 불법 행동');
    if (move) {
      state = move.state;
      placementCount++;
    }
    attemptCount++;
    terminated = isGameOver(state);
    truncated = !terminated && attemptCount >= execution.maxEpisodeSteps;

    if (step.attemptCount !== undefined) equal(step.attemptCount, attemptCount, '행동의 누적 시도 수');
    if (step.placementCount !== undefined) equal(step.placementCount, placementCount, '행동의 누적 배치 수');
    if (step.terminated !== undefined) equal(step.terminated, terminated, '행동의 게임 종료 플래그');
    if (step.truncated !== undefined) equal(step.truncated, truncated, '행동의 횟수 제한 플래그');
    equal(step.scoreDelta, move?.points ?? 0, '점수 증가량');
    equal(step.scoreAfter, state.score, '누적 점수');
    equal(step.comboAfter, state.combo, '콤보');
    equal(step.clearedRows, move?.clearedRows ?? [], '소거 행');
    equal(step.clearedCols, move?.clearedCols ?? [], '소거 열');
    equal(step.refilled, move?.refilled ?? false, '블록 보충 여부');
    equal(step.trayAfter, state.tray, '다음 트레이');
    if (step.colorsAfter !== undefined) equal(step.colorsAfter, state.colors, '트레이 색상');
    if (step.scoreBreakdown !== undefined) equal(step.scoreBreakdown,
      move?.scoreBreakdown ?? { placement: 0, elimination: 0, allClear: 0 }, '점수 구성');
    if (step.clearScreen !== undefined) equal(step.clearScreen, move?.clearScreen ?? false, '전체 비우기');
    if (step.clearScreenBonus !== undefined) equal(step.clearScreenBonus, move?.clearScreenBonus ?? 0, '전체 비우기 점수');
    if (step.stateHashAfter !== undefined) equal(step.stateHashAfter, stateDigest(state), '상태 해시');
  }

  equal(attemptCount, game.attemptCount, '전체 시도 수');
  equal(placementCount, game.placementCount, '실제 배치 수');
  equal(state, game.finalState ?? game.latestState, '최종 보드·점수·콤보·난수 상태');
  if (game.endReason === 'game_over' && !terminated) mismatch('게임 오버 종료 이유');
  if (game.endReason === 'max_episode_steps' && !truncated) mismatch('시도 제한 종료 이유');
  equal(Boolean(game.terminated), terminated, '게임 종료 플래그');
  equal(Boolean(game.truncated), truncated, '횟수 제한 플래그');

  return {
    valid: true,
    sessionId: game.sessionId,
    gameId: game.gameId,
    attemptCount,
    placementCount,
    state,
    terminated,
    truncated,
    stateHash: stateDigest(state),
  };
}

/**
 * A replay worker reads one consistent canonical snapshot without acquiring
 * the writer/recovery store. Streaming avoids retaining the whole action list.
 */
export function replayStoredGame(recordsDir, sessionId, gameId) {
  validateIdentifier(sessionId);
  validateIdentifier(gameId);
  const db = new DatabaseSync(join(resolve(recordsDir), 'history.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;');
    if (!db.prepare('SELECT 1 FROM rl_sessions WHERE session_id=?').get(sessionId)) {
      throw historyError(404, 'RL_HISTORY_SESSION_NOT_FOUND', '저장된 세션을 찾을 수 없습니다.');
    }
    const row = db.prepare('SELECT * FROM rl_games WHERE session_id=? AND game_id=?').get(sessionId, gameId);
    if (!row) throw historyError(404, 'RL_HISTORY_GAME_NOT_FOUND', '저장된 게임을 찾을 수 없습니다.');
    const iterable = db.prepare('SELECT data_json FROM rl_steps WHERE session_id=? AND game_id=? ORDER BY step').iterate(sessionId, gameId);
    function* steps() { for (const entry of iterable) yield JSON.parse(entry.data_json); }
    const result = replayGameRecord(decodeGameRow(row), steps());
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}
