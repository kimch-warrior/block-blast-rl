import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameApi, readGameMode } from '../public/game/client/api.js';
import { createStorage } from '../public/game/client/storage.js';

test('game mode selects regular polling or the requested read-only training environment', () => {
  assert.deepEqual(readGameMode('?unrelated=value'), {
    readOnly: false,
    sessionId: '',
    envId: 0,
    valid: true,
    statePath: '/api/state',
    pollIntervalMs: 1600,
  });

  const viewer = readGameMode('?session=session-123&env=511');
  assert.deepEqual(viewer, {
    readOnly: true,
    sessionId: 'session-123',
    envId: 511,
    valid: true,
    statePath: '/api/rl/sessions/session-123/envs/511',
    pollIntervalMs: 500,
  });
  assert.equal(Object.isFrozen(viewer), true);
  assert.throws(() => { viewer.envId = 0; }, TypeError);

  const defaultEnv = readGameMode('?session=session-123');
  assert.equal(defaultEnv.valid, true);
  assert.equal(defaultEnv.envId, 0);
  assert.equal(defaultEnv.statePath, '/api/rl/sessions/session-123/envs/0');
});

test('malformed viewer queries remain read-only and cannot select a regular game', () => {
  for (const search of [
    '?env=0',
    '?session=',
    '?session=a&env=512',
    '?session=a&env=-1',
    '?session=a&env=1.5',
    '?session=a&env=',
    '?session=a&env=NaN',
    '?session=unsafe%2Fname&env=0',
    `?session=${'a'.repeat(101)}&env=0`,
  ]) {
    const mode = readGameMode(search);
    assert.equal(mode.readOnly, true, search);
    assert.equal(mode.valid, false, search);
    assert.notEqual(mode.statePath, '/api/state', search);
  }
});

test('API requests retain credentials, bypass caches and serialize mutations as JSON', async () => {
  const calls = [];
  const snapshot = { id: 'game', version: 2 };
  const api = createGameApi({
    fetch: async (path, options) => {
      calls.push({ path, options });
      return { ok: true, json: async () => snapshot };
    },
  });

  assert.equal(await api.request('/api/state'), snapshot);
  assert.equal(await api.request('/api/games/game/place', {
    method: 'POST', body: { version: 1, slot: 0, row: 2, col: 3 },
  }), snapshot);

  assert.equal(calls[0].path, '/api/state');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(calls[1].path, '/api/games/game/place');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(calls[1].options.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(calls[1].options.body), { version: 1, slot: 0, row: 2, col: 3 });
});

test('API failures preserve server status and the latest game snapshot for recovery', async () => {
  const data = {
    id: 'game', version: 3, state: { score: 10 },
    error: { code: 'VERSION_CONFLICT', message: '최신 상태를 사용해주세요.' },
  };
  const api = createGameApi({
    fetch: async () => ({ ok: false, status: 409, json: async () => data }),
  });

  await assert.rejects(api.request('/api/games/game/place', {
    method: 'POST', body: { version: 1 },
  }), error => {
    assert.equal(error.message, data.error.message);
    assert.equal(error.status, 409);
    assert.equal(error.data, data);
    return true;
  });
});

test('non-JSON responses have a usable error and network failures are preserved', async () => {
  const badJson = createGameApi({
    fetch: async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Not JSON'); } }),
  });
  await assert.rejects(badJson.request('/api/state'), error => {
    assert.equal(error.status, 502);
    assert.match(error.message, /502/);
    assert.deepEqual(error.data, {});
    return true;
  });

  const networkError = new TypeError('Network unavailable');
  const offline = createGameApi({ fetch: async () => { throw networkError; } });
  await assert.rejects(offline.request('/api/state'), error => error === networkError);
});

test('API timeout aborts an outstanding request and clears successful request timers', async () => {
  let pendingSignal;
  const stalled = createGameApi({
    timeoutMs: 10,
    fetch: async (_path, { signal }) => {
      pendingSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  await assert.rejects(stalled.request('/api/state'), error => error.name === 'AbortError');
  assert.equal(pendingSignal.aborted, true);

  let completedSignal;
  const completed = createGameApi({
    timeoutMs: 5,
    fetch: async (_path, { signal }) => {
      completedSignal = signal;
      return { ok: true, json: async () => ({}) };
    },
  });
  await completed.request('/api/state');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(completedSignal.aborted, false);
});

test('storage uses the existing key namespace and preserves stored values', () => {
  const values = new Map();
  const storage = createStorage({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  });

  assert.equal(storage.get('missing'), null);
  assert.equal(storage.get('missing', 0), 0);
  storage.set('best', 123);
  assert.equal(values.get('bb-web:best'), '123');
  assert.equal(storage.get('best'), '123');
  storage.set('empty', '');
  assert.equal(storage.get('empty', 'fallback'), '');
  storage.remove('best');
  assert.equal(storage.get('best'), null);
});

test('denied, full or missing storage cannot prevent gameplay', () => {
  const unavailable = createStorage({
    getItem() { throw new Error('Denied'); },
    setItem() { throw new Error('Full'); },
    removeItem() { throw new Error('Denied'); },
  });
  assert.equal(unavailable.get('best', 0), 0);
  assert.doesNotThrow(() => unavailable.set('best', 10));
  assert.doesNotThrow(() => unavailable.remove('best'));

  const missing = createStorage(undefined);
  assert.equal(missing.get('best', 0), 0);
  assert.doesNotThrow(() => missing.set('best', 10));
  assert.doesNotThrow(() => missing.remove('best'));
});

test('lazy storage providers keep browser property access inside the exception boundary', () => {
  let accesses = 0;
  const denied = createStorage(() => {
    accesses++;
    throw new Error('Browser denied access to the localStorage property');
  });

  assert.equal(accesses, 0);
  assert.equal(denied.get('best', 0), 0);
  assert.doesNotThrow(() => denied.set('best', 10));
  assert.doesNotThrow(() => denied.remove('best'));
  assert.equal(accesses, 3);

  const values = new Map();
  const available = createStorage(() => ({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }));
  available.set('best', 12);
  assert.equal(available.get('best'), '12');
  assert.equal(values.get('bb-web:best'), '12');
  available.remove('best');
  assert.equal(available.get('best'), null);
});
