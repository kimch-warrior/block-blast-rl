import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameService, ApiError } from '../app/api/_lib/service.js';
import { migrateRecord } from '../app/api/_lib/score-migration.js';
import { createGame, place } from '../public/game/engine.js';

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async insert(row) { rows.set(row.id, structuredClone(row)); },
    async find(id, ownerId) { const row = rows.get(id); return row?.ownerId === ownerId ? structuredClone(row) : null; },
    async update(row, expected) {
      const previous = rows.get(row.id);
      if (!previous || previous.ownerId !== row.ownerId || previous.version !== expected) return false;
      rows.set(row.id, structuredClone(row)); return true;
    },
  };
}
function setup() {
  const store = memoryStore();
  let id = 0;
  return { store, api: createGameService(store, { makeId: () => `game-${++id}`, now: () => '2026-11-01T14:00:00.000Z' }) };
}
const firstMove = game => {
  const available = game.legalMoves.find(m => m.positions.length);
  return { slot: available.slot, ...available.positions[0] };
};

test('create/get uses an owner-scoped persisted snapshot', async () => {
  const { api } = setup();
  const game = await api.create('owner-a', { seed: 123 });
  assert.equal(game.version, 1);
  assert.equal(game.state.board.length, 8);
  assert.equal(game.state.tray.length, 3);
  assert.deepEqual(await api.get('owner-a', game.id), game);
  await assert.rejects(api.get('owner-b', game.id), e => e instanceof ApiError && e.status === 404);
});

test('a placement advances the shared state, and undo restores the complete prior state', async () => {
  const { api } = setup();
  const game = await api.create('a', { seed: 42 });
  const next = await api.command('a', game.id, 'place', { version: 1, ...firstMove(game) });
  assert.equal(next.version, 2);
  assert.equal(next.state.moves, 1);
  assert.equal(next.canUndo, true);
  assert.equal(next.lastMove.points, next.state.score);
  const restored = await api.command('a', game.id, 'undo', { version: 2 });
  assert.equal(restored.version, 3);
  assert.deepEqual(restored.state, game.state);
  assert.equal(restored.canUndo, false);
});

test('stale versions and concurrent writes cannot overwrite a successful move', async () => {
  const { api } = setup();
  const game = await api.create('a', { seed: 321 });
  const command = { version: 1, ...firstMove(game) };
  const results = await Promise.allSettled([
    api.command('a', game.id, 'place', command), api.command('a', game.id, 'place', command),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const conflict = results.find(r => r.status === 'rejected').reason;
  assert.equal(conflict.status, 409);
  assert.equal(conflict.snapshot.version, 2);
  assert.equal((await api.get('a', game.id)).state.moves, 1);
});

test('retrying a request ID is idempotent; reusing it for a different action conflicts', async () => {
  const { api } = setup();
  const game = await api.create('a', { seed: 123 });
  const command = { version: 1, requestId: 'move-1', ...firstMove(game) };
  const next = await api.command('a', game.id, 'place', command);
  assert.deepEqual(await api.command('a', game.id, 'place', command), next);
  await assert.rejects(api.command('a', game.id, 'reset', { version: 2, requestId: 'move-1' }), e => e.status === 409 && e.code === 'REQUEST_ID_CONFLICT');
  assert.equal((await api.get('a', game.id)).state.moves, 1);
});

test('bad input or an impossible placement never mutates the persisted board', async () => {
  const { api } = setup();
  const game = await api.create('a', { seed: 11 });
  await assert.rejects(api.command('a', game.id, 'place', { version: 1, slot: 3, row: 0, col: 0 }), e => e.status === 400);
  await assert.rejects(api.command('a', game.id, 'place', { version: 1, slot: 0, row: 7, col: 7 }), e => e.status === 422);
  assert.deepEqual(await api.get('a', game.id), game);
  await assert.rejects(api.create('a', { seed: 0 }), e => e.status === 400);
});

test('reset shares the ID, advances version, and drops undo history', async () => {
  const { api } = setup();
  const game = await api.create('a', { seed: 8 });
  const next = await api.command('a', game.id, 'place', { version: 1, ...firstMove(game) });
  const fresh = await api.command('a', game.id, 'reset', { version: 2, seed: 8 });
  assert.equal(fresh.id, game.id);
  assert.equal(fresh.version, 3);
  assert.deepEqual(fresh.state, game.state);
  assert.equal(fresh.canUndo, false);
  await assert.rejects(api.command('a', game.id, 'undo', { version: 3 }), e => e.code === 'NO_UNDO');
});

function legacyThreeLineGame() {
  let state = createGame(191);
  state.tray = [4, 4, 4]; // Eight 3-cell columns complete three rows together.
  delete state.unEliminateTimes;
  delete state.scoreRulesVersion;
  const history = [];
  let lastMove;
  for (let col = 0; col < 8; col++) {
    const slot = state.tray.findIndex(id => id !== -1);
    history.push(structuredClone(state));
    const result = place(state, slot, 0, col);
    assert.ok(result);
    const lines = result.clearedRows.length + result.clearedCols.length;
    const oldCombo = lines ? state.combo + 1 : 0;
    const oldPoints = 3 + 10 * lines * Math.max(1, oldCombo);
    state = { ...result.state, score: state.score + oldPoints, combo: oldCombo };
    if (result.refilled) state.tray = [4, 4, 4];
    delete state.unEliminateTimes;
    delete state.scoreRulesVersion;
    lastMove = { slot, row: 0, col, points: oldPoints, clearedRows: result.clearedRows,
      clearedCols: result.clearedCols, refilled: result.refilled };
  }
  return { id: 'legacy-game', ownerId: 'a', version: 9, stateJson: JSON.stringify(state),
    historyJson: JSON.stringify(history), lastMoveJson: JSON.stringify(lastMove), lastRequestId: 'old-command',
    lastRequestAction: 'old-signature', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:01:00.000Z' };
}

test('full retained history is rescored without changing the board, tray, seed or turns', () => {
  const row = legacyThreeLineGame();
  const before = JSON.parse(row.stateJson);
  assert.equal(before.score, 54);
  const originalRow = structuredClone(row);
  const migration = migrateRecord(row, '2026-11-01T01:00:00.000Z');
  assert.equal(migration.changed, true);
  assert.equal(migration.mode, 'recalculated');
  assert.equal(migration.row.version, 10);
  assert.equal(migration.row.lastRequestId, null);
  const after = JSON.parse(migration.row.stateJson);
  assert.equal(after.score, 84); // 24 placed cells + 60 for a triple clear.
  assert.equal(after.combo, 1);
  assert.equal(after.unEliminateTimes, 0);
  assert.equal(after.scoreRulesVersion, 2);
  for (const field of ['board', 'tray', 'colors', 'seed', 'moves', 'lines', 'round']) {
    assert.deepEqual(after[field], before[field], field);
  }
  const lastMove = JSON.parse(migration.row.lastMoveJson);
  assert.equal(lastMove.points, 63);
  assert.deepEqual(lastMove.scoreBreakdown, { placement: 3, elimination: 60, allClear: 0 });
  assert.equal(lastMove.clearScreen, true);
  assert.equal(lastMove.clearScreenBonus, 0);
  assert.ok(JSON.parse(migration.row.historyJson).every(s => s.scoreRulesVersion === 2));
  assert.equal(migrateRecord(migration.row).changed, false);
  assert.deepEqual(row, originalRow, 'migration does not mutate the caller row');
});

test('truncated or unverifiable old history preserves scores instead of inventing missing events', () => {
  for (const invalid of [false, true]) {
    const row = legacyThreeLineGame();
    const history = JSON.parse(row.historyJson);
    if (invalid) history[3].tray = [1, 1, 1];
    else history.shift();
    row.historyJson = JSON.stringify(history);
    const migration = migrateRecord(row);
    assert.equal(migration.mode, 'carried-forward');
    const after = JSON.parse(migration.row.stateJson);
    assert.equal(after.score, JSON.parse(row.stateJson).score);
    assert.equal(after.scoreRulesVersion, 2);
    assert.equal(after.scoreMigration.mode, 'carried-forward');
    assert.deepEqual(after.board, JSON.parse(row.stateJson).board);
    assert.deepEqual(JSON.parse(migration.row.historyJson).map(s => s.score), history.map(s => s.score));
    assert.equal(migration.row.lastMoveJson, null);
  }
});

test('migrated history stays consistent through stale requests, undo and a new placement', async () => {
  const { api, store } = setup();
  const migration = migrateRecord(legacyThreeLineGame());
  store.rows.set(migration.row.id, migration.row);
  const game = await api.get('a', migration.row.id);
  assert.equal(game.state.score, 84);
  await assert.rejects(api.command('a', game.id, 'place', { version: 9, ...firstMove(game) }),
    error => error.status === 409 && error.snapshot.version === 10);
  const undone = await api.command('a', game.id, 'undo', { version: game.version });
  assert.equal(undone.state.moves, 7);
  assert.equal(undone.state.score, 21);
  assert.equal(undone.state.scoreRulesVersion, 2);
  assert.equal(undone.state.unEliminateTimes, 7);
  const slot = undone.state.tray.findIndex(id => id !== -1);
  const replaced = await api.command('a', game.id, 'place', { version: undone.version, slot, row: 0, col: 7 });
  assert.equal(replaced.state.score, 84);
  assert.deepEqual(replaced.lastMove.scoreBreakdown, { placement: 3, elimination: 60, allClear: 0 });
  assert.equal(replaced.lastMove.clearScreen, true);
});
