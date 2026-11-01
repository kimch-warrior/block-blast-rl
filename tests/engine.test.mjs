import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, canPlace, place, placements, generateTray, isGameOver, score, SHAPES } from '../public/game/engine.js';

const emptyBoard = () => Array.from({ length: 8 }, () => Array(8).fill(-1));

test('all 51 rendering shapes fit an empty board and reject bounds and overlap', () => {
  for (const shape of SHAPES) {
    const board = emptyBoard();
    assert.equal(canPlace(board, shape.id, 0, 0), true);
    assert.equal(canPlace(board, shape.id, -1, 0), false);
    assert.equal(canPlace(board, shape.id, 0, 9 - shape.width), false);
    const { x, y } = shape.cells[0];
    board[y][x] = 0; // Zero is occupied too.
    assert.equal(canPlace(board, shape.id, 0, 0), false);
  }
});

test('a crossing row and column clear simultaneously and the input is unchanged', () => {
  const state = createGame(123);
  state.tray = [1, 1, 1];
  for (let i = 1; i < 8; i++) { state.board[0][i] = 2; state.board[i][0] = 3; }
  const before = structuredClone(state);
  const result = place(state, 0, 0, 0);
  assert.deepEqual(result.clearedRows, [0]);
  assert.deepEqual(result.clearedCols, [0]);
  assert.equal(result.state.lines, 2);
  assert.equal(result.points, 21);
  assert.equal(result.clearScreen, true);
  assert.equal(result.clearScreenBonus, 0);
  assert.deepEqual(result.scoreBreakdown, { placement: 1, elimination: 20, allClear: 0 });
  assert.deepEqual(result.state.board, emptyBoard());
  assert.deepEqual(state, before);
  assert.deepEqual(result.state.tray, [-1, 1, 1]);
});

test('baseline Classic scoring scales three and four cleared lines nonlinearly', () => {
  assert.equal(createGame(1).scoreRulesVersion, 2);
  assert.equal(createGame(1).unEliminateTimes, 0);
  assert.equal(score(4, 0, 0), 4);
  assert.equal(score(4, 1, 1), 14);
  assert.equal(score(4, 2, 1), 24);
  assert.equal(score(4, 3, 1), 64);
  assert.equal(score(4, 4, 1), 124);
  assert.equal(score(4, 3, 2), 124);
  assert.equal(score(4, 4, 2), 244);
});

test('actual three- and four-row clears use the baseline multi-line bonus', () => {
  for (const [id, height, expected] of [[4, 3, 63], [7, 4, 124]]) {
    const state = createGame(143);
    state.tray = [id, 1, 1];
    for (let row = 0; row < height; row++) for (let col = 1; col < 8; col++) state.board[row][col] = 2;
    const result = place(state, 0, 0, 0);
    assert.deepEqual(result.clearedRows, Array.from({ length: height }, (_, i) => i));
    assert.equal(result.points, expected);
    assert.equal(result.state.combo, 1);
    assert.equal(result.state.scoreRulesVersion, 2);
    assert.equal(result.clearScreenBonus, 0);
  }
});

test('all-clear bonus starts after round five and is checked before set refill', () => {
  for (const [round, expectedBonus] of [[5, 0], [6, 300]]) {
    const state = createGame(99);
    state.round = round;
    state.tray = [1, -1, -1];
    for (let col = 1; col < 8; col++) state.board[0][col] = 2;
    const result = place(state, 0, 0, 0);
    assert.equal(result.refilled, true);
    assert.equal(result.state.round, round + 1);
    assert.equal(result.clearScreen, true);
    assert.equal(result.clearScreenBonus, expectedBonus);
    assert.equal(result.points, 11 + expectedBonus);
    assert.deepEqual(result.scoreBreakdown, { placement: 1, elimination: 10, allClear: expectedBonus });
  }
  const state = createGame(99);
  state.round = 6;
  state.tray = [1, 1, 1];
  for (let col = 1; col < 8; col++) state.board[0][col] = 2;
  state.board[7][7] = 3;
  const result = place(state, 0, 0, 0);
  assert.equal(result.clearScreen, false);
  assert.equal(result.clearScreenBonus, 0);
  assert.equal(result.points, 11);
});

test('combos survive one or two non-clears, reset the gap on clear, and break on the third', () => {
  for (const gap of [1, 2, 3]) {
    let state = createGame(82);
    state.combo = 2;
    state.tray = [1, 1, 1];
    const before = structuredClone(state);
    for (let move = 0; move < gap; move++) {
      const result = place(state, move, 7, move);
      assert.equal(result.state.unEliminateTimes, move + 1);
      assert.equal(result.state.combo, move < 2 ? 2 : 0);
      state = result.state;
    }
    assert.deepEqual(before.unEliminateTimes, 0);
    // Prepare the same one-line completion after each gap, leaving other cells
    // occupied so this tests combo scoring independently of an all-clear bonus.
    state.tray = [1, 1, 1];
    for (let col = 1; col < 8; col++) state.board[0][col] = 2;
    const result = place(state, 0, 0, 0);
    const expectedCombo = gap < 3 ? 3 : 1;
    assert.equal(result.state.combo, expectedCombo);
    assert.equal(result.state.unEliminateTimes, 0);
    assert.equal(result.points, 1 + 10 * expectedCombo);
  }
});

test('consumed slots cannot be placed; only the third move refills the tray', () => {
  let state = createGame(7);
  state.tray = [1, 1, 1];
  let result = place(state, 0, 0, 0);
  assert.equal(result.refilled, false);
  assert.equal(place(result.state, 0, 0, 1), null);
  result = place(result.state, 1, 0, 1);
  assert.equal(result.refilled, false);
  result = place(result.state, 2, 0, 2);
  assert.equal(result.refilled, true);
  assert.equal(result.state.round, 2);
  assert.equal(result.state.tray.length, 3);
  assert.ok(result.state.tray.every(id => id > 0));
});

test('game over checks remaining pieces rather than just remaining space', () => {
  const state = createGame(1);
  state.board = Array.from({ length: 8 }, () => Array(8).fill(1));
  state.board[0][0] = -1;
  state.tray = [9, -1, -1];
  assert.equal(isGameOver(state), true);
  state.tray[0] = 1;
  assert.equal(isGameOver(state), false);
});

test('equal seeds and positions produce identical games', () => {
  assert.deepEqual(createGame(12009), createGame(12009));
  let a = createGame(73), b = createGame(73);
  for (let move = 0; move < 12; move++) {
    const slot = a.tray.findIndex(id => id !== -1 && placements(a.board, id).length);
    assert.notEqual(slot, -1);
    const { row, col } = placements(a.board, a.tray[slot])[0];
    a = place(a, slot, row, col).state;
    b = place(b, slot, row, col).state;
    assert.deepEqual(a, b);
  }
});

function canFinishTray(state) {
  if (state.tray.every(id => id === -1)) return true;
  for (let slot = 0; slot < 3; slot++) {
    if (state.tray[slot] === -1) continue;
    for (const { row, col } of placements(state.board, state.tray[slot])) {
      const result = place(state, slot, row, col);
      if (result.refilled || canFinishTray(result.state)) return true;
    }
  }
  return false;
}

test('generated trays have a full legal placement sequence on crowded boards', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const state = createGame(seed);
    state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) =>
      ((x * 13 + y * 7 + seed) % 11) < 6 ? 1 : -1));
    const generated = generateTray(state.board, 1200, seed);
    state.tray = generated.tray;
    state.seed = generated.seed;
    assert.equal(canFinishTray(state), true, `seed ${seed}`);
  }
});
