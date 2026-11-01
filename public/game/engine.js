import { SHAPES, getShape } from './shapes.js';

export { SHAPES, getShape };
export const SIZE = 8;
export const EMPTY = -1;

// This is an independent web reconstruction of the observed rules and
// board-aware selection ideas. It does not reproduce the original live service.
const FULL_ROW = 255;
const safeSeed = seed => (Math.floor(Math.abs(Number(seed))) || 1) % 2147483646 + 1;
const randomSource = seed => {
  let current = safeSeed(seed);
  return {
    next() {
      current = current * 16807 % 2147483647;
      return (current - 1) / 2147483646;
    },
    get seed() { return current; },
  };
};

const bitRows = board => board.map(row => row.reduce((mask, cell) => (mask << 1) | Number(cell !== EMPTY), 0));
const popcount = value => {
  value -= (value >>> 1) & 0x55;
  value = (value & 0x33) + ((value >>> 2) & 0x33);
  return (value + (value >>> 4)) & 0x0f;
};

function fitsMasks(rows, shape, row, col) {
  if (!shape || !Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 ||
      row + shape.height > SIZE || col + shape.width > SIZE) return false;
  const shift = SIZE - shape.width - col;
  return shape.rowMasks.every((mask, y) => !(rows[row + y] & (mask << shift)));
}

function simulate(rows, shape, row, col) {
  const next = rows.slice();
  const shift = SIZE - shape.width - col;
  shape.rowMasks.forEach((mask, y) => { next[row + y] |= mask << shift; });
  const clearedRows = [];
  const clearedCols = [];
  for (let y = 0; y < SIZE; y++) if (next[y] === FULL_ROW) clearedRows.push(y);
  for (let x = 0; x < SIZE; x++) {
    const bit = 1 << (7 - x);
    if (next.every(mask => mask & bit)) clearedCols.push(x);
  }
  // Detect both directions before clearing: crossing lines disappear together.
  const clearMask = clearedCols.reduce((mask, x) => mask | (1 << (7 - x)), 0);
  for (let y = 0; y < SIZE; y++) next[y] &= ~clearMask;
  for (const y of clearedRows) next[y] = 0;
  return { rows: next, clearedRows, clearedCols };
}

function edgeCount(rows) {
  let edges = 0;
  for (let y = 0; y < SIZE; y++) {
    // Internal boundaries plus the outer silhouette measure fragmentation.
    edges += popcount(rows[y] ^ ((rows[y] << 1) & FULL_ROW));
    edges += popcount(rows[y] ^ (rows[y - 1] ?? 0));
  }
  return edges + popcount(rows[7]);
}

export function canPlace(board, shapeId, row, col) {
  if (!Array.isArray(board) || board.length !== SIZE) return false;
  const shape = getShape(shapeId);
  if (!shape || !Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 ||
      row + shape.height > SIZE || col + shape.width > SIZE) return false;
  return shape.cells.every(({ x, y }) => board[row + y]?.[col + x] === EMPTY);
}

export function placements(board, shapeId) {
  const shape = getShape(shapeId);
  if (!shape) return [];
  const places = [];
  for (let row = 0; row <= SIZE - shape.height; row++) {
    for (let col = 0; col <= SIZE - shape.width; col++) {
      if (canPlace(board, shapeId, row, col)) places.push({ row, col });
    }
  }
  return places;
}

/**
 * Select a three-piece tray by following one complete legal simulated sequence.
 * Candidates combine random sampling, line clears and a fragmentation measure.
 * The chosen route exists, but a player can still lose by making other moves.
 */
export function generateTray(board, scoreValue = 0, seed = 1) {
  const random = randomSource(seed);
  let rows = bitRows(board);
  const tray = [];
  for (let slot = 0; slot < 3; slot++) {
    const occupied = rows.reduce((sum, mask) => sum + popcount(mask), 0);
    const beforeEdges = edgeCount(rows);
    const selected = new Set([1]);
    // Samples avoid exhaustive searches while retaining variety across all 51 IDs.
    while (selected.size < 15) selected.add(SHAPES[Math.floor(random.next() * SHAPES.length)].id);
    const candidates = [];
    for (const id of selected) {
      const shape = getShape(id);
      let best = null;
      for (let row = 0; row <= SIZE - shape.height; row++) {
        for (let col = 0; col <= SIZE - shape.width; col++) {
          if (!fitsMasks(rows, shape, row, col)) continue;
          const trial = simulate(rows, shape, row, col);
          const cleared = trial.clearedRows.length + trial.clearedCols.length;
          const evaluation = cleared * 16 + (beforeEdges - edgeCount(trial.rows)) * 0.3;
          if (!best || evaluation > best.evaluation ||
              (evaluation === best.evaluation && random.next() < 0.25)) {
            best = { id, rows: trial.rows, evaluation, cleared, size: shape.cells.length };
          }
        }
      }
      if (best) candidates.push(best);
    }
    // Single-square ID 1 guarantees at least one candidate whenever a cell is free.
    if (!candidates.length) {
      while (tray.length < 3) tray.push(1);
      break;
    }
    const help = occupied > 39 || scoreValue < 500;
    let chosen;
    if (help && random.next() < 0.76) {
      candidates.sort((a, b) => b.evaluation - a.evaluation || b.size - a.size);
      const top = candidates.slice(0, Math.min(3, candidates.length));
      chosen = top[Math.floor(random.next() * top.length)];
    } else {
      // A larger-shape preference keeps sparse boards interesting.
      const varied = candidates.filter(candidate => candidate.size >= 3);
      const pool = varied.length ? varied : candidates;
      chosen = pool[Math.floor(random.next() * pool.length)];
    }
    tray.push(chosen.id);
    rows = chosen.rows;
  }
  return { tray, seed: random.seed };
}

export function createGame(seed = Date.now()) {
  const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
  const generated = generateTray(board, 0, seed);
  const random = randomSource(generated.seed);
  return {
    board,
    tray: generated.tray,
    colors: [0, 1, 2].map(() => Math.floor(random.next() * 7) + 1),
    score: 0,
    combo: 0,
    unEliminateTimes: 0,
    scoreRulesVersion: 2,
    moves: 0,
    lines: 0,
    round: 1,
    seed: random.seed,
  };
}

export function isGameOver(state) {
  return !state.tray.some(id => id !== -1 && placements(state.board, id).length > 0);
}

/**
 * Baseline Classic scoring recovered from Block Blast 10.9.3:
 * ClassScoreInfo.computeComboAndEliminateTimesScore (decoded class bundle
 * lines 27661-27695), plus ClassScore_Proxy (28445-28511).
 * Tutorial and remotely activated score modifiers are intentionally excluded.
 */
export function score(cellCount, lineCount, combo = 1, allClearBonus = 0) {
  const multiplier = Math.max(1, combo || 1);
  const elimination = lineCount === 1 ? 10 * multiplier :
    lineCount > 1 ? 10 * multiplier * lineCount * (lineCount - 1) : 0;
  return cellCount + elimination + allClearBonus;
}

export function place(state, slot, row, col) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) return null;
  const id = state.tray[slot];
  const shape = getShape(id);
  if (!shape || !canPlace(state.board, id, row, col)) return null;
  const simulation = simulate(bitRows(state.board), shape, row, col);
  const board = state.board.map(r => r.slice());
  for (const { x, y } of shape.cells) board[row + y][col + x] = state.colors[slot];
  for (const y of simulation.clearedRows) board[y].fill(EMPTY);
  for (const x of simulation.clearedCols) for (let y = 0; y < SIZE; y++) board[y][x] = EMPTY;
  const clearedCount = simulation.clearedRows.length + simulation.clearedCols.length;
  // The original baseline preserves a combo through two non-clearing moves;
  // the third consecutive non-clear breaks it. A clear resets the gap counter.
  const unEliminateTimes = clearedCount ? 0 : (state.unEliminateTimes ?? 0) + 1;
  const combo = clearedCount ? state.combo + 1 : unEliminateTimes >= 3 ? 0 : state.combo;
  const clearScreen = clearedCount > 0 && board.every(line => line.every(cell => cell === EMPTY));
  // The unlock check uses the round in which this move started, before refill.
  const clearScreenBonus = clearScreen && state.round > 5 ? 300 : 0;
  const placementScore = shape.cells.length;
  const points = score(placementScore, clearedCount, combo, clearScreenBonus);
  const scoreBreakdown = { placement: placementScore,
    elimination: points - placementScore - clearScreenBonus, allClear: clearScreenBonus };
  let tray = state.tray.map((current, i) => i === slot ? -1 : current);
  let colors = state.colors.slice();
  let nextSeed = state.seed;
  const refilled = tray.every(current => current === -1);
  if (refilled) {
    const generated = generateTray(board, state.score + points, state.seed);
    tray = generated.tray;
    const random = randomSource(generated.seed);
    colors = [0, 1, 2].map(() => Math.floor(random.next() * 7) + 1);
    nextSeed = random.seed;
  }
  const nextState = {
    ...state,
    board,
    tray,
    colors,
    score: state.score + points,
    combo,
    unEliminateTimes,
    scoreRulesVersion: 2,
    moves: state.moves + 1,
    lines: state.lines + clearedCount,
    round: state.round + Number(refilled),
    seed: nextSeed,
  };
  return { state: nextState, clearedRows: simulation.clearedRows, clearedCols: simulation.clearedCols,
    points, scoreBreakdown, clearScreen, clearScreenBonus, refilled, gameOver: isGameOver(nextState) };
}
