import { getShape, score } from '../../../public/game/engine.js';

const VERSION = 2;
const nonnegative = value => Number.isInteger(value) && value >= 0;
const empty = board => Array.isArray(board) && board.length === 8 &&
  board.every(row => Array.isArray(row) && row.length === 8 && row.every(cell => cell === -1));

function transition(before, after) {
  if (after.moves !== before.moves + 1 || !nonnegative(before.lines) || !nonnegative(after.lines)) return null;
  const lines = after.lines - before.lines;
  if (lines < 0 || lines > 16 || !Array.isArray(before.tray) || before.tray.length !== 3 ||
      !Array.isArray(after.tray) || after.tray.length !== 3) return null;
  let slot;
  if (after.round === before.round + 1) {
    const remaining = before.tray.map((id, i) => id !== -1 ? i : -1).filter(i => i >= 0);
    if (remaining.length !== 1 || after.tray.some(id => !getShape(id))) return null;
    [slot] = remaining;
  } else if (after.round === before.round) {
    const consumed = before.tray.map((id, i) => id !== -1 && after.tray[i] === -1 ? i : -1).filter(i => i >= 0);
    if (consumed.length !== 1) return null;
    [slot] = consumed;
    if (before.tray.some((id, i) => i !== slot && id !== after.tray[i])) return null;
  } else return null;
  const shape = getShape(before.tray[slot]);
  return shape ? { placement: shape.cells.length, lines, clearScreen: lines > 0 && empty(after.board), round: before.round } : null;
}

function advance(combo, misses, clearLines) {
  if (clearLines > 0) return { combo: combo + 1, misses: 0 };
  misses += 1;
  return { combo: misses >= 3 ? 0 : combo, misses };
}

/**
 * Upgrade this web game's retained snapshots, without replaying generation or
 * changing any board, shape, colour, seed or turn. A complete move-zero history
 * permits exact baseline rescoring. Truncated/invalid history keeps every
 * accumulated score instead of inventing events which were not retained.
 * The caller owns persistence and should apply returned changed rows atomically.
 */
export function migrateRecord(row, nowIso = new Date().toISOString()) {
  const current = JSON.parse(row.stateJson);
  const history = JSON.parse(row.historyJson);
  if (!Array.isArray(history)) throw new Error('Invalid saved game history');
  const states = [...history, current];
  if (states.every(state => state.scoreRulesVersion === VERSION && nonnegative(state.unEliminateTimes))) {
    return { row, changed: false, mode: 'unchanged', fromScore: current.score, toScore: current.score };
  }
  const fromScore = current.score;
  const steps = states.slice(1).map((after, i) => transition(states[i], after));
  const first = states[0];
  const complete = first.moves === 0 && first.score === 0 && first.lines === 0 && empty(first.board) &&
    current.moves === history.length && steps.every(Boolean);
  const mode = complete ? 'recalculated' : 'carried-forward';
  let combo = complete ? 0 : (nonnegative(first.combo) ? first.combo : 0);
  let misses = complete ? 0 : (nonnegative(first.unEliminateTimes) ? first.unEliminateTimes : 0);
  let total = 0;
  let lastBreakdown = null;
  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const oldScore = state.score;
    if (i > 0) {
      const step = steps[i - 1];
      if (step) {
        ({ combo, misses } = advance(combo, misses, step.lines));
        const allClear = step.clearScreen && step.round > 5 ? 300 : 0;
        const points = score(step.placement, step.lines, combo, allClear);
        if (complete) total += points;
        lastBreakdown = { points, clearScreen: step.clearScreen, clearScreenBonus: allClear,
          scoreBreakdown: { placement: step.placement, elimination: points - step.placement - allClear, allClear } };
      } else {
        combo = nonnegative(state.combo) ? state.combo : 0;
        misses = nonnegative(state.unEliminateTimes) ? state.unEliminateTimes : 0;
        lastBreakdown = null;
      }
    }
    if (complete) state.score = total;
    state.combo = combo;
    state.unEliminateTimes = misses;
    state.scoreRulesVersion = VERSION;
    state.scoreMigration = { mode, previousScore: oldScore, fromVersion: 1 };
  }
  let lastMove = row.lastMoveJson ? JSON.parse(row.lastMoveJson) : null;
  // A carried-forward score does not establish the old move's correct new
  // breakdown, so do not expose an invented points event for that migration.
  if (!complete) lastMove = null;
  else if (lastMove && lastBreakdown) lastMove = { ...lastMove, ...lastBreakdown };
  const next = { ...row, version: row.version + 1, stateJson: JSON.stringify(current), historyJson: JSON.stringify(history),
    lastMoveJson: lastMove ? JSON.stringify(lastMove) : null, lastRequestId: null, lastRequestAction: null,
    updatedAt: nowIso };
  return { row: next, changed: true, mode, fromScore, toScore: current.score };
}
