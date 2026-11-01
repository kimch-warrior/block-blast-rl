import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ApiError } from '../../app/api/_lib/service.js';
import { ACTION_COUNT, MAX_SEED, DEFAULT_NUM_ENVS, MAX_ENVS, DEFAULT_WORKER_COUNT, rulesVersions } from './protocol.mjs';

const integerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const WORKER_TIMEOUT_MS = 30_000;

export function createRlPool({ workerCount = DEFAULT_WORKER_COUNT, maxEnvs = MAX_ENVS, maxPending = 16 } = {}) {
  if (!integerIn(workerCount, 1, 16) || !integerIn(maxEnvs, 1, MAX_ENVS) ||
      !integerIn(maxPending, 1, Number.MAX_SAFE_INTEGER)) {
    fail(400, 'INVALID_RL_CONFIG', `workerCount는 1~16, maxEnvs는 1~${MAX_ENVS}, maxPending은 양의 정수여야 합니다.`);
  }
  const sessions = new Map();
  const workers = [];
  let totalEnvs = 0;
  let pending = 0;
  let nextWorker = 0;
  let requestId = 0;
  let closed = false;
  let closePromise;

  function beginOperation() {
    if (closed) fail(503, 'RL_CLOSED', 'RL 환경 풀이 종료되었습니다.');
    if (pending >= maxPending) fail(429, 'RL_OVERLOADED', '대기 중인 RL 작업이 많습니다. 잠시 후 다시 시도해주세요.');
    pending++;
    return () => { pending--; };
  }

  function metadata(session) {
    return {
      sessionId: session.sessionId, version: session.version, numEnvs: session.numEnvs,
      maxEpisodeSteps: session.maxEpisodeSteps, invalidActionMode: session.invalidActionMode, createdAt: session.createdAt,
      updatedAt: session.updatedAt, busy: session.busy,
    };
  }

  function response(session) {
    return structuredClone({ ...metadata(session), ...rulesVersions, results: session.results });
  }

  function withoutStepEvent(result) {
    return { ...result, reward: 0, info: {
      ...result.info, scoreDelta: 0, clearedRows: [], clearedCols: [], refilled: false,
      actionValid: null, invalidActionReason: null,
      scoreBreakdown: { placement: 0, elimination: 0, allClear: 0 },
    } };
  }

  function findSession(sessionId, { allowBusy = false } = {}) {
    if (closed) fail(503, 'RL_CLOSED', 'RL 환경 풀이 종료되었습니다.');
    const session = sessions.get(sessionId);
    if (!session) fail(404, 'RL_SESSION_NOT_FOUND', 'RL 세션을 찾을 수 없습니다.');
    if (session.busy && (!allowBusy || session.results.length !== session.numEnvs)) {
      fail(409, 'SESSION_BUSY', '이 RL 세션에서 다른 작업을 처리 중입니다.');
    }
    return session;
  }

  function validateVersion(session, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_BODY', 'JSON 객체가 필요합니다.');
    if (!integerIn(body.version, 1, Number.MAX_SAFE_INTEGER)) fail(400, 'INVALID_VERSION', '현재 세션의 version이 필요합니다.');
    if (body.version !== session.version) fail(409, 'VERSION_CONFLICT', 'RL 세션이 변경되었습니다. 최신 version으로 다시 시도해주세요.');
  }

  function validateSeed(seed) {
    if (!integerIn(seed, 1, MAX_SEED)) fail(400, 'INVALID_SEED', `seed는 1~${MAX_SEED} 정수여야 합니다.`);
  }

  function groups(session, envIds = Array.from({ length: session.numEnvs }, (_, id) => id)) {
    const grouped = new Map();
    for (const envId of envIds) {
      const index = session.assignments[envId];
      if (!grouped.has(index)) grouped.set(index, []);
      grouped.get(index).push(envId);
    }
    return grouped;
  }

  function invalidateSession(session, error, cleanup = true) {
    if (sessions.get(session.sessionId) !== session) return;
    sessions.delete(session.sessionId);
    totalEnvs -= session.numEnvs;
    session.invalidError = error;
    for (const [index, envIds] of groups(session)) {
      const record = workers[index];
      if (!record) continue;
      if (session.countsAccounted) record.envCount = Math.max(0, record.envCount - envIds.length);
      if (error) {
        for (const [id, entry] of record.pending) {
          if (entry.sessionId !== session.sessionId) continue;
          record.pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(error);
        }
      }
      if (cleanup && !closed && !record.dead) {
        // Messages on each worker are ordered, so deletion runs after any
        // already dispatched operation on this invalidated session.
        void rpc(record, { op: 'delete', sessionId: session.sessionId }).catch(() => {});
      }
    }
  }

  function failWorker(record, error) {
    if (record.dead) return;
    record.dead = true;
    for (const entry of record.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    record.pending.clear();
    void record.worker.terminate().catch(() => {});
    for (const session of [...sessions.values()]) {
      if (session.assignments.includes(record.index)) invalidateSession(session, error);
    }
    record.envCount = 0;
  }

  function startWorker(index) {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      // Desktop launchers may pass flags unsupported by Worker (for example
      // --use-largepages). The simulation needs no inherited runtime flags.
      execArgv: [],
    });
    const record = { index, worker, threadId: worker.threadId, envCount: 0, pending: new Map(), dead: false };
    worker.on('message', message => {
      const entry = record.pending.get(message.requestId);
      if (!entry) return;
      record.pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new ApiError(message.error.status, message.error.code, message.error.message));
      else entry.resolve(message.result);
    });
    worker.on('error', () => {
      failWorker(record, new ApiError(503, 'RL_WORKER_FAILED', 'RL worker가 종료되어 관련 세션이 무효화되었습니다.'));
    });
    worker.on('exit', () => {
      failWorker(record, new ApiError(503, 'RL_WORKER_FAILED', 'RL worker가 종료되어 관련 세션이 무효화되었습니다.'));
    });
    workers[index] = record;
    return record;
  }

  function ensureWorkers() {
    if (closed) fail(503, 'RL_CLOSED', 'RL 환경 풀이 종료되었습니다.');
    for (let index = 0; index < workerCount; index++) {
      if (!workers[index] || workers[index].dead) startWorker(index);
    }
  }

  function rpc(record, payload) {
    if (closed || record.dead) return Promise.reject(new ApiError(503, 'RL_WORKER_FAILED', 'RL worker를 사용할 수 없습니다.'));
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new ApiError(503, 'RL_WORKER_TIMEOUT', 'RL worker 응답 시간이 초과되어 관련 세션이 무효화되었습니다.');
        failWorker(record, error);
        void record.worker.terminate();
      }, WORKER_TIMEOUT_MS);
      timer.unref();
      record.pending.set(id, { resolve, reject, timer, sessionId: payload.sessionId });
      try {
        record.worker.postMessage({ ...payload, requestId: id });
      } catch {
        failWorker(record, new ApiError(503, 'RL_WORKER_FAILED', 'RL worker에 요청을 보내지 못했습니다.'));
      }
    });
  }

  async function dispatch(session, op, envIds, extra = {}) {
    const values = await Promise.all([...groups(session, envIds)].map(([index, ids]) => {
      const payload = { op, sessionId: session.sessionId, envIds: ids, ...extra };
      if (op === 'step') payload.actions = ids.map(envId => ({ envId, action: extra.actions[envId] }));
      return rpc(workers[index], payload);
    }));
    if (session.invalidError) throw session.invalidError;
    return values.flat();
  }

  async function mutate(session, work) {
    const finish = beginOperation();
    session.busy = true;
    try {
      const changed = await work();
      if (session.invalidError) throw session.invalidError;
      // Skipped environments never repeat a previous step's reward.
      session.results = session.results.map(withoutStepEvent);
      for (const result of changed) session.results[result.envId] = result;
      session.version++;
      session.updatedAt = new Date().toISOString();
      session.busy = false;
      return response(session);
    } catch (error) {
      // A failed cross-worker batch may have run on another worker already.
      // Never expose that partially advanced session again.
      invalidateSession(session, error);
      throw error;
    } finally {
      session.busy = false;
      finish();
    }
  }

  return {
    async create(options = {}) {
      if (!options || typeof options !== 'object' ||
          (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) {
        fail(400, 'INVALID_BODY', 'JSON 객체가 필요합니다.');
      }
      const { numEnvs = Math.min(DEFAULT_NUM_ENVS, maxEnvs), seed = 1, maxEpisodeSteps = 10000, invalidActionMode = 'reject' } = options;
      if (!integerIn(numEnvs, 1, maxEnvs)) fail(400, 'INVALID_NUM_ENVS', `numEnvs는 1~${maxEnvs} 정수여야 합니다.`);
      if (!integerIn(maxEpisodeSteps, 1, 10_000_000)) fail(400, 'INVALID_EPISODE_STEPS', 'maxEpisodeSteps는 1~10000000 정수여야 합니다.');
      if (invalidActionMode !== 'reject' && invalidActionMode !== 'transition') fail(400, 'INVALID_ACTION_MODE', 'invalidActionMode는 reject 또는 transition이어야 합니다.');
      validateSeed(seed);
      const finish = beginOperation();
      let session;
      try {
        if (totalEnvs + numEnvs > maxEnvs) fail(409, 'ENV_LIMIT', `RL 환경은 전체 세션을 합해 최대 ${maxEnvs}개까지 사용할 수 있습니다.`);
        const createdAt = new Date().toISOString();
        session = {
          sessionId: randomUUID(), version: 1, numEnvs, maxEpisodeSteps, invalidActionMode,
          createdAt, updatedAt: createdAt, busy: true, results: [], countsAccounted: false,
          assignments: Array.from({ length: numEnvs }, (_, index) => (nextWorker + index) % workerCount),
        };
        nextWorker = (nextWorker + numEnvs) % workerCount;
        // Reserve capacity synchronously before starting any asynchronous work.
        sessions.set(session.sessionId, session);
        totalEnvs += numEnvs;
        ensureWorkers();
        for (const [index, ids] of groups(session)) workers[index].envCount += ids.length;
        session.countsAccounted = true;
        const results = await dispatch(session, 'create', undefined, { seed, maxEpisodeSteps, invalidActionMode });
        session.results = results.sort((a, b) => a.envId - b.envId);
        session.busy = false;
        return response(session);
      } catch (error) {
        if (session) invalidateSession(session, error);
        throw error;
      } finally {
        finish();
      }
    },

    async get(sessionId) {
      return response(findSession(sessionId, { allowBusy: true }));
    },

    async reset(sessionId, body) {
      const session = findSession(sessionId);
      validateVersion(session, body);
      if (body.seed !== undefined) validateSeed(body.seed);
      const envIds = body.envIds === undefined ? Array.from({ length: session.numEnvs }, (_, id) => id) : body.envIds;
      if (!Array.isArray(envIds) || envIds.length === 0 || envIds.length > session.numEnvs ||
          Array.from(envIds).some(id => !integerIn(id, 0, session.numEnvs - 1)) || new Set(envIds).size !== envIds.length) {
        fail(400, 'INVALID_ENV_IDS', 'envIds는 중복 없는 환경 번호 배열이어야 합니다.');
      }
      return mutate(session, () => dispatch(session, 'reset', envIds, { seed: body.seed }));
    },

    async step(sessionId, body) {
      const session = findSession(sessionId);
      validateVersion(session, body);
      if (!Array.isArray(body.actions) || body.actions.length !== session.numEnvs) {
        fail(400, 'INVALID_ACTIONS', 'actions에는 환경 개수만큼의 action 또는 null이 필요합니다.');
      }
      for (let envId = 0; envId < session.numEnvs; envId++) {
        const action = body.actions[envId];
        if (action === null) continue;
        if (!integerIn(action, 0, ACTION_COUNT - 1)) fail(400, 'INVALID_ACTION', `환경 ${envId}의 action은 0~191 정수 또는 null이어야 합니다.`);
        const result = session.results[envId];
        if (result.terminated || result.truncated) fail(422, 'RL_ENV_DONE', `환경 ${envId}를 먼저 reset해야 합니다.`);
        if (session.invalidActionMode === 'reject' && result.actionMask[action] !== 1) fail(422, 'ILLEGAL_ACTION', `환경 ${envId}에 놓을 수 없는 action입니다.`);
      }
      // Copy caller-owned input before awaiting: later mutation cannot bypass
      // the complete-batch validation performed above.
      const actions = body.actions.slice();
      return mutate(session, () => dispatch(session, 'step', undefined, { actions }));
    },

    async snapshot(sessionId, envId) {
      const session = findSession(sessionId, { allowBusy: true });
      if (!integerIn(envId, 0, session.numEnvs - 1)) fail(404, 'RL_ENV_NOT_FOUND', 'RL 환경을 찾을 수 없습니다.');
      const finish = beginOperation();
      // Worker message ordering gives a coherent single-environment snapshot
      // without letting a viewer lock out training mutations.
      try {
        const result = await rpc(workers[session.assignments[envId]], { op: 'snapshot', sessionId, envId });
        if (session.invalidError) throw session.invalidError;
        return result;
      } catch (error) {
        invalidateSession(session, error);
        throw error;
      } finally {
        finish();
      }
    },

    async delete(sessionId) {
      const session = findSession(sessionId);
      const finish = beginOperation();
      try {
        invalidateSession(session, null, false);
        await dispatch(session, 'delete');
        return { sessionId, deleted: true, numEnvs: session.numEnvs };
      } finally {
        finish();
      }
    },

    stats() {
      return {
        ...rulesVersions, workerCount, activeWorkers: workers.filter(worker => !worker.dead).length,
        workers: workers.map(worker => ({ index: worker.index, threadId: worker.threadId, envCount: worker.envCount, alive: !worker.dead })),
        sessions: [...sessions.values()].map(metadata), sessionCount: sessions.size,
        totalEnvs, pending, maxPending, maxEnvs, closed,
      };
    },

    async close() {
      if (closePromise) return closePromise;
      closed = true;
      const error = new ApiError(503, 'RL_CLOSED', 'RL 환경 풀이 종료되었습니다.');
      for (const session of [...sessions.values()]) invalidateSession(session, error, false);
      for (const worker of workers) failWorker(worker, error);
      closePromise = Promise.all(workers.map(worker => worker.worker.terminate())).then(() => undefined);
      return closePromise;
    },
  };
}
