import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGame } from '../public/game/engine.js';
import { createSqliteStore } from '../server/sqlite-store.mjs';

test('SQLite startup upgrades scores once and preserves active game, board and generated pieces', async () => {
  const prefix = resolve(join(tmpdir(), 'block-blast-score-'));
  const directory = await mkdtemp(prefix);
  let store;
  try {
    store = createSqliteStore(directory);
    const state = createGame(32);
    delete state.scoreRulesVersion;
    delete state.unEliminateTimes;
    const row = { id:'legacy-startup', ownerId:'local-player', version:4,
      stateJson:JSON.stringify(state), historyJson:'[]', lastMoveJson:null,
      lastRequestId:'old-request', lastRequestAction:'old-action',
      createdAt:'2026-11-01T00:00:00Z', updatedAt:'2026-11-01T00:00:00Z' };
    await store.insert(row); store.setActiveGameId(row.id); store.close();
    store = createSqliteStore(directory);
    assert.equal(store.scoreMigrations.length, 1);
    assert.equal(store.scoreMigrations[0].mode, 'recalculated');
    assert.equal(store.getActiveGameId(), row.id);
    const saved = await store.find(row.id, row.ownerId), next = JSON.parse(saved.stateJson);
    assert.equal(saved.version, 5);
    assert.equal(saved.lastRequestId, null);
    assert.equal(next.scoreRulesVersion, 2);
    assert.equal(next.unEliminateTimes, 0);
    for (const key of ['board','tray','colors','seed','score','moves','lines','round']) assert.deepEqual(next[key], state[key]);
    store.close(); store = createSqliteStore(directory);
    assert.equal(store.scoreMigrations.length, 0);
    assert.equal((await store.find(row.id, row.ownerId)).version, 5);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(prefix), 'cleanup is confined to the owned temporary directory');
    await rm(directory, {recursive:true,force:true});
  }
});
