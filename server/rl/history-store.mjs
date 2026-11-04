import { DatabaseSync } from 'node:sqlite';
import {
  appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { decodeGameRow, END_REASONS, historyError, SCHEMA_VERSION, stateDigest, validateIdentifier } from './history-format.mjs';

// One backend process owns a records directory. The main coordinator is the
// single writer; simulation workers never open this store. This guard also
// prevents an accidental second application in the same process from treating
// the first application's live sessions as interrupted.
const openDirectories = new Set();
const clone = value => structuredClone(value);
const fail = (status, code, message) => { throw historyError(status, code, message); };

function pagination(options = {}, defaultLimit = 50) {
  const limit = options?.limit ?? defaultLimit;
  const offset = options?.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
      !Number.isSafeInteger(offset) || offset < 0) {
    fail(400, 'INVALID_PAGINATION', 'limit는 1~1000, offset은 0 이상의 정수여야 합니다.');
  }
  return { limit, offset };
}

function page(items, total, { limit, offset }) {
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

function syncDirectory(path) {
  // Directory fsync is supported on Linux (including Docker). Windows does
  // not allow opening directory handles this way; regular files are still
  // explicitly flushed there.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureDirectory(path) {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('History directory is not a regular directory');
    return;
  }
  ensureDirectory(dirname(path));
  mkdirSync(path);
  syncDirectory(dirname(path));
}

function atomicWrite(path, contents) {
  ensureDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function appendFlushed(path, records) {
  if (!records.length) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error('History file cannot be a symbolic link');
  const fd = openSync(path, 'a', 0o600);
  try {
    appendFileSync(fd, records.map(record => JSON.stringify(record) + '\n').join(''), 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function removeFile(path) {
  if (!existsSync(path)) return;
  if (lstatSync(path).isDirectory()) throw new Error('History file path is a directory');
  unlinkSync(path);
  syncDirectory(dirname(path));
}

/**
 * SQLite is the canonical commit journal. JSONL/JSON exports are flushed before
 * the SQLite COMMIT, so an acknowledged operation exists in both. A durable
 * pending manifest names any exports which may contain uncommitted bytes after
 * a crash. Startup restores those files from SQLite before serving history.
 */
export function createHistoryStore(recordsDir) {
  const directory = resolve(recordsDir);
  ensureDirectory(directory);
  const key = realpathSync(directory);
  if (openDirectories.has(key)) fail(503, 'RL_RECORDING_IN_USE', '이 기록 폴더는 이미 사용 중입니다.');
  openDirectories.add(key);
  let db;
  let closed = false;

  try {
    db = new DatabaseSync(join(directory, 'history.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS rl_sessions (
        session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        status TEXT NOT NULL, data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rl_games (
        session_id TEXT NOT NULL REFERENCES rl_sessions(session_id), game_id TEXT NOT NULL,
        env_id INTEGER NOT NULL, episode_id INTEGER NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT, header_json TEXT NOT NULL,
        latest_state_json TEXT NOT NULL, final_state_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, placement_count INTEGER NOT NULL DEFAULT 0,
        terminated INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(session_id,game_id)
      );
      CREATE INDEX IF NOT EXISTS rl_games_order ON rl_games(session_id,started_at,game_id);
      CREATE TABLE IF NOT EXISTS rl_steps (
        session_id TEXT NOT NULL, game_id TEXT NOT NULL, step INTEGER NOT NULL,
        request_id TEXT NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY(session_id,game_id,step),
        FOREIGN KEY(session_id,game_id) REFERENCES rl_games(session_id,game_id)
      );
      CREATE TABLE IF NOT EXISTS rl_requests (
        scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        response_blob BLOB NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(scope,request_id)
      );
    `);
    const pendingDirectory = join(directory, '.pending');
    ensureDirectory(pendingDirectory);

    const sessionRow = sessionId => db.prepare('SELECT * FROM rl_sessions WHERE session_id=?').get(sessionId);
    const gameRow = (sessionId, gameId) => db.prepare('SELECT * FROM rl_games WHERE session_id=? AND game_id=?').get(sessionId, gameId);
    const rowsOfSteps = (sessionId, gameId) => db.prepare('SELECT data_json FROM rl_steps WHERE session_id=? AND game_id=? ORDER BY step').all(sessionId, gameId).map(row => JSON.parse(row.data_json));
    const sessionPath = sessionId => join(directory, 'sessions', validateIdentifier(sessionId), 'session.json');
    const gamePath = (sessionId, gameId, extension) => join(directory, 'sessions', validateIdentifier(sessionId), 'games', validateIdentifier(gameId) + extension);

    function ensureOpen() {
      if (closed) fail(503, 'RL_RECORDING_CLOSED', '기록 저장소가 종료되었습니다.');
    }

    function requireSession(sessionId) {
      ensureOpen();
      validateIdentifier(sessionId);
      const row = sessionRow(sessionId);
      if (!row) fail(404, 'RL_HISTORY_SESSION_NOT_FOUND', '저장된 세션을 찾을 수 없습니다.');
      return row;
    }

    function requireGame(sessionId, gameId) {
      requireSession(sessionId);
      validateIdentifier(gameId);
      const row = gameRow(sessionId, gameId);
      if (!row) fail(404, 'RL_HISTORY_GAME_NOT_FOUND', '저장된 게임을 찾을 수 없습니다.');
      return row;
    }

    function exportSession(sessionId) {
      const row = sessionRow(sessionId);
      if (!row) return removeFile(sessionPath(sessionId));
      atomicWrite(sessionPath(sessionId), JSON.stringify(JSON.parse(row.data_json), null, 2) + '\n');
    }

    function endEvent(game) {
      return {
        type: 'end', sessionId: game.sessionId, gameId: game.gameId,
        endedAt: game.endedAt, endReason: game.endReason,
        attemptCount: game.attemptCount, placementCount: game.placementCount,
        terminated: game.terminated, truncated: game.truncated, finalState: game.finalState,
      };
    }

    function exportCompleted(game) {
      atomicWrite(gamePath(game.sessionId, game.gameId, '.json'), JSON.stringify({ ...game, steps: rowsOfSteps(game.sessionId, game.gameId) }, null, 2) + '\n');
    }

    function exportGame(sessionId, gameId) {
      const row = gameRow(sessionId, gameId);
      if (!row) {
        removeFile(gamePath(sessionId, gameId, '.jsonl'));
        removeFile(gamePath(sessionId, gameId, '.json'));
        return;
      }
      const game = decodeGameRow(row);
      const records = [{ type: 'header', ...JSON.parse(row.header_json) },
        ...rowsOfSteps(sessionId, gameId).map(step => ({ type: 'step', ...step }))];
      if (game.status === 'finished') records.push(endEvent(game));
      atomicWrite(gamePath(sessionId, gameId, '.jsonl'), records.map(record => JSON.stringify(record) + '\n').join(''));
      if (game.status === 'finished') exportCompleted(game);
      else removeFile(gamePath(sessionId, gameId, '.json'));
    }

    function restoreExports(manifest) {
      for (const sessionId of manifest.sessionIds) exportSession(validateIdentifier(sessionId));
      for (const { sessionId, gameId } of manifest.games) exportGame(validateIdentifier(sessionId), validateIdentifier(gameId));
    }

    function lookupRequest(scope, requestId, fingerprint) {
      ensureOpen();
      if (scope !== '$create') validateIdentifier(scope);
      if (typeof requestId !== 'string' || !/^[\w.:-]{1,128}$/.test(requestId)) fail(400, 'INVALID_REQUEST_ID', 'requestId 형식이 올바르지 않습니다.');
      const row = db.prepare('SELECT fingerprint,response_blob FROM rl_requests WHERE scope=? AND request_id=?').get(scope, requestId);
      if (!row) return null;
      if (row.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_CONFLICT', '같은 requestId를 다른 요청에 사용할 수 없습니다.');
      return JSON.parse(gunzipSync(row.response_blob).toString('utf8'));
    }

    function commit({ session, starts = [], steps = [], ends = [], request, assertActive } = {}) {
      ensureOpen();
      if (request) {
        const previous = lookupRequest(request.scope, request.requestId, request.fingerprint);
        if (previous) return previous;
      }
      // A future asynchronous wrapper may delay this synchronous commit until
      // after a worker has failed. Preserve the caller's cancellation error and
      // create no manifest or export bytes for such a rejected operation.
      if (assertActive !== undefined) {
        if (typeof assertActive !== 'function') fail(400, 'INVALID_COMMIT_GUARD', '기록 커밋 검증 함수가 올바르지 않습니다.');
        assertActive();
      }
      const sessionIds = new Set();
      const games = new Map();
      if (session) sessionIds.add(validateIdentifier(session.sessionId));
      for (const record of [...starts, ...steps, ...ends]) {
        const sessionId = validateIdentifier(record.sessionId), gameId = validateIdentifier(record.gameId);
        sessionIds.add(sessionId);
        games.set(`${sessionId}/${gameId}`, { sessionId, gameId });
      }
      const manifest = { sessionIds: [...sessionIds], games: [...games.values()] };
      const pendingPath = join(pendingDirectory, `${randomUUID()}.json`);
      let transaction = false;
      let committedResponse;
      try {
        atomicWrite(pendingPath, JSON.stringify(manifest));
        db.exec('BEGIN IMMEDIATE');
        transaction = true;
        if (session) {
          const old = sessionRow(session.sessionId);
          const data = { ...(old ? JSON.parse(old.data_json) : {}), schemaVersion: SCHEMA_VERSION, ...session };
          data.startedAt ??= new Date().toISOString();
          data.updatedAt ??= data.startedAt;
          data.status ??= 'in_progress';
          db.prepare(`INSERT INTO rl_sessions VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
            updated_at=excluded.updated_at,status=excluded.status,data_json=excluded.data_json`)
            .run(data.sessionId, data.startedAt, data.updatedAt, data.status, JSON.stringify(data));
        }
        for (const start of starts) {
          if (!start.initialState || !Number.isInteger(start.initialGameSeed)) throw new Error('Missing initial replay state');
          const header = { ...start, schemaVersion: SCHEMA_VERSION };
          db.prepare(`INSERT INTO rl_games(session_id,game_id,env_id,episode_id,status,started_at,header_json,latest_state_json)
            VALUES(?,?,?,?,?,?,?,?)`).run(header.sessionId, header.gameId, header.envId, header.episodeId,
            'in_progress', header.startedAt, JSON.stringify(header), JSON.stringify(header.initialState));
        }
        const insertedSteps = [];
        for (const step of steps) {
          const game = gameRow(step.sessionId, step.gameId);
          if (!game || game.status !== 'in_progress' || step.step !== game.attempt_count || !step.stateAfter ||
              typeof step.actionValid !== 'boolean' || typeof step.requestId !== 'string') throw new Error('Out-of-order or incomplete recorded transition');
          const { stateAfter, ...publicStep } = step;
          publicStep.stateHashAfter = stateDigest(stateAfter);
          db.prepare('INSERT INTO rl_steps VALUES(?,?,?,?,?)').run(step.sessionId, step.gameId, step.step, step.requestId, JSON.stringify(publicStep));
          db.prepare(`UPDATE rl_games SET latest_state_json=?,attempt_count=attempt_count+1,
            placement_count=placement_count+? WHERE session_id=? AND game_id=?`)
            .run(JSON.stringify(stateAfter), Number(step.actionValid), step.sessionId, step.gameId);
          insertedSteps.push(publicStep);
        }
        const insertedEnds = [];
        for (const ending of ends) {
          const row = gameRow(ending.sessionId, ending.gameId);
          if (!row) throw new Error('Missing game to finish');
          if (row.status === 'finished') continue;
          const latest = JSON.parse(row.latest_state_json);
          if (!END_REASONS.has(ending.endReason) || !isDeepStrictEqual(ending.finalState, latest) ||
              ending.attemptCount !== row.attempt_count || ending.placementCount !== row.placement_count) throw new Error('Recorded terminal result does not match committed transitions');
          db.prepare(`UPDATE rl_games SET status='finished',ended_at=?,end_reason=?,final_state_json=?,terminated=?,truncated=?
            WHERE session_id=? AND game_id=?`).run(ending.endedAt ?? new Date().toISOString(), ending.endReason,
            JSON.stringify(latest), Number(Boolean(ending.terminated)), Number(Boolean(ending.truncated)), ending.sessionId, ending.gameId);
          insertedEnds.push(decodeGameRow(gameRow(ending.sessionId, ending.gameId)));
        }
        if (request) {
          const responseJson = JSON.stringify(request.response);
          committedResponse = JSON.parse(responseJson);
          db.prepare('INSERT INTO rl_requests VALUES(?,?,?,?,?)').run(request.scope, request.requestId, request.fingerprint,
            gzipSync(responseJson, { level: 1 }), new Date().toISOString());
        }
        const rebuilt = new Set();
        for (const start of starts) {
          atomicWrite(gamePath(start.sessionId, start.gameId, '.jsonl'), JSON.stringify({ type: 'header', ...start, schemaVersion: SCHEMA_VERSION }) + '\n');
        }
        const stepGroups = new Map();
        for (const step of insertedSteps) {
          const groupKey = `${step.sessionId}/${step.gameId}`;
          if (!stepGroups.has(groupKey)) stepGroups.set(groupKey, []);
          stepGroups.get(groupKey).push({ type: 'step', ...step });
        }
        for (const [groupKey, records] of stepGroups) {
          const { sessionId, gameId } = games.get(groupKey);
          const path = gamePath(sessionId, gameId, '.jsonl');
          if (!existsSync(path)) { exportGame(sessionId, gameId); rebuilt.add(groupKey); }
          else appendFlushed(path, records);
        }
        for (const game of insertedEnds) {
          const groupKey = `${game.sessionId}/${game.gameId}`;
          const path = gamePath(game.sessionId, game.gameId, '.jsonl');
          if (!rebuilt.has(groupKey)) {
            if (!existsSync(path)) exportGame(game.sessionId, game.gameId);
            else { appendFlushed(path, [endEvent(game)]); exportCompleted(game); }
          }
        }
        for (const sessionId of sessionIds) exportSession(sessionId);
        db.exec('COMMIT');
        transaction = false;
        // Failure to remove the marker is safe: recovery is idempotent.
        try { removeFile(pendingPath); } catch { /* Rebuilt on next startup. */ }
        return committedResponse;
      } catch (error) {
        if (transaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve original failure. */ } }
        try { restoreExports(manifest); removeFile(pendingPath); } catch { /* Leave marker for startup recovery. */ }
        throw historyError(503, 'RL_RECORDING_FAILED', '플레이 기록을 저장하지 못해 실행을 중단했습니다.', error);
      }
    }

    function closeSession(sessionId, reason = 'session_closed') {
      const row = requireSession(sessionId);
      const session = JSON.parse(row.data_json);
      if (session.status === 'finished') return clone(session);
      if (!END_REASONS.has(reason)) fail(400, 'INVALID_END_REASON', '게임 종료 이유가 올바르지 않습니다.');
      const endedAt = new Date().toISOString();
      const ends = db.prepare("SELECT * FROM rl_games WHERE session_id=? AND status='in_progress'").all(sessionId).map(game => ({
        sessionId, gameId: game.game_id, endReason: reason, endedAt,
        finalState: JSON.parse(game.latest_state_json), attemptCount: game.attempt_count,
        placementCount: game.placement_count, terminated: Boolean(game.terminated), truncated: Boolean(game.truncated),
      }));
      commit({ session: { ...session, status: 'finished', endReason: reason, endedAt, updatedAt: endedAt }, ends });
      return JSON.parse(sessionRow(sessionId).data_json);
    }

    // First remove uncommitted export tails left by a failed/crashed writer.
    for (const file of readdirSync(pendingDirectory)) {
      if (file.endsWith('.tmp')) { removeFile(join(pendingDirectory, file)); continue; }
      if (!/^[a-f0-9-]+\.json$/.test(file)) continue;
      const path = join(pendingDirectory, file);
      restoreExports(JSON.parse(readFileSync(path, 'utf8')));
      removeFile(path);
    }
    // Memory environments cannot survive the process that owned them.
    for (const row of db.prepare("SELECT session_id FROM rl_sessions WHERE status='in_progress'").all()) closeSession(row.session_id, 'interrupted');

    return {
      recordsDir: directory,
      dbPath: join(directory, 'history.sqlite'),
      persistent: true,
      schemaVersion: SCHEMA_VERSION,
      lookupRequest,
      commit,
      closeSession,
      listSessions(options) {
        ensureOpen();
        const paging = pagination(options);
        const total = db.prepare('SELECT COUNT(*) AS count FROM rl_sessions').get().count;
        const items = db.prepare(`SELECT s.data_json,(SELECT COUNT(*) FROM rl_games g WHERE g.session_id=s.session_id) AS game_count
          FROM rl_sessions s ORDER BY started_at DESC,session_id DESC LIMIT ? OFFSET ?`).all(paging.limit, paging.offset)
          .map(row => ({ ...JSON.parse(row.data_json), gameCount: row.game_count }));
        return page(items, total, paging);
      },
      listGames(sessionId, options) {
        requireSession(sessionId);
        const paging = pagination(options);
        const total = db.prepare('SELECT COUNT(*) AS count FROM rl_games WHERE session_id=?').get(sessionId).count;
        const items = db.prepare('SELECT * FROM rl_games WHERE session_id=? ORDER BY started_at,game_id LIMIT ? OFFSET ?')
          .all(sessionId, paging.limit, paging.offset).map(row => {
            const game = decodeGameRow(row);
            return { sessionId, gameId: game.gameId, envId: game.envId, episodeId: game.episodeId,
              status: game.status, startedAt: game.startedAt, endedAt: game.endedAt, endReason: game.endReason,
              attemptCount: game.attemptCount, placementCount: game.placementCount,
              score: game.latestState.score, combo: game.latestState.combo };
          });
        return page(items, total, paging);
      },
      getGame(sessionId, gameId) { return decodeGameRow(requireGame(sessionId, gameId)); },
      listSteps(sessionId, gameId, options) {
        requireGame(sessionId, gameId);
        const paging = pagination(options, 100);
        const total = db.prepare('SELECT COUNT(*) AS count FROM rl_steps WHERE session_id=? AND game_id=?').get(sessionId, gameId).count;
        const items = db.prepare('SELECT data_json FROM rl_steps WHERE session_id=? AND game_id=? ORDER BY step LIMIT ? OFFSET ?')
          .all(sessionId, gameId, paging.limit, paging.offset).map(row => JSON.parse(row.data_json));
        return page(items, total, paging);
      },
      getStepsForReplay(sessionId, gameId) { requireGame(sessionId, gameId); return rowsOfSteps(sessionId, gameId); },
      health() { return !closed && db.prepare('SELECT 1 AS ok').get().ok === 1; },
      close() {
        if (closed) return;
        closed = true;
        try { db.close(); } finally { openDirectories.delete(key); }
      },
    };
  } catch (error) {
    try { db?.close(); } finally { openDirectories.delete(key); }
    throw error.status ? error : historyError(503, 'RL_RECORDING_FAILED', '플레이 기록 저장소를 준비하지 못했습니다.', error);
  }
}
