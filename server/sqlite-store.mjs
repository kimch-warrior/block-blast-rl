import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrateRecord } from '../app/api/_lib/score-migration.js';

function fromSql(row) {
  if (!row) return null;
  return {
    id: row.id, ownerId: row.owner_id, version: row.version,
    stateJson: row.state_json, historyJson: row.history_json,
    lastMoveJson: row.last_move_json, lastRequestId: row.last_request_id,
    lastRequestAction: row.last_request_action, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createSqliteStore(dataDir = process.env.DATA_DIR || 'data') {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(resolve(directory, 'game.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  // This local server owns this schema. Hosted D1 migrations are not used here.
  db.exec(`CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    state_json TEXT NOT NULL,
    history_json TEXT NOT NULL DEFAULT '[]',
    last_move_json TEXT,
    last_request_id TEXT,
    last_request_action TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO games (id,owner_id,version,state_json,history_json,last_move_json,last_request_id,last_request_action,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const find = db.prepare('SELECT * FROM games WHERE id = ? AND owner_id = ?');
  const update = db.prepare('UPDATE games SET version=?,state_json=?,history_json=?,last_move_json=?,last_request_id=?,last_request_action=?,updated_at=? WHERE id=? AND owner_id=? AND version=?');
  const health = db.prepare('SELECT 1 AS ok');
  const getActive = db.prepare("SELECT value FROM meta WHERE key = 'activeGameId'");
  const setActive = db.prepare("INSERT INTO meta (key,value) VALUES ('activeGameId',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  // Upgrade scores and undo snapshots together before accepting any requests.
  // No geometry, generated pieces or active-game identity is changed.
  const scoreMigrations = [];
  try {
    db.exec('BEGIN IMMEDIATE');
    const migratedAt = new Date().toISOString();
    for (const record of db.prepare('SELECT * FROM games').all()) {
      const previous = fromSql(record);
      const migration = migrateRecord(previous, migratedAt);
      if (!migration.changed) continue;
      const next = migration.row;
      const result = update.run(next.version, next.stateJson, next.historyJson, next.lastMoveJson,
        next.lastRequestId, next.lastRequestAction, next.updatedAt, next.id, next.ownerId, previous.version);
      if (result.changes !== 1) throw new Error('Score migration version conflict');
      scoreMigrations.push({ id: next.id, mode: migration.mode, fromScore: migration.fromScore, toScore: migration.toScore });
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } finally { db.close(); }
    throw error;
  }
  let closed = false;
  return {
    scoreMigrations,
    async insert(row) {
      insert.run(row.id, row.ownerId, row.version, row.stateJson, row.historyJson,
        row.lastMoveJson, row.lastRequestId, row.lastRequestAction, row.createdAt, row.updatedAt);
    },
    async find(id, ownerId) { return fromSql(find.get(id, ownerId)); },
    async update(row, expectedVersion) {
      const result = update.run(row.version, row.stateJson, row.historyJson, row.lastMoveJson,
        row.lastRequestId, row.lastRequestAction, row.updatedAt, row.id, row.ownerId, expectedVersion);
      return result.changes === 1;
    },
    health() { return health.get().ok === 1; },
    getActiveGameId() { return getActive.get()?.value ?? null; },
    setActiveGameId(id) { setActive.run(id); },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
