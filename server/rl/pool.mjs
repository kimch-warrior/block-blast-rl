import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { ApiError } from '../../app/api/_lib/service.js';
import { ACTION_COUNT, MAX_SEED, DEFAULT_NUM_ENVS, MAX_ENVS, DEFAULT_WORKER_COUNT, rulesVersions } from './protocol.mjs';

const integerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const WORKER_TIMEOUT_MS = 30_000;
const plainObject = value => value && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function stableJson(value) {
  if (Array.isArray(value)) return '[' + Array.from(value, stableJson).join(',') + ']';
  if (plainObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function policyMetadata(value = {}) {
  const seen = new Set();
  function visit(item, depth = 0) {
    if (depth > 32) fail(400, 'INVALID_POLICY_METADATA', '정책 메타데이터가 너무 깊습니다.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item))) return;
    if (!Array.isArray(item) && !plainObject(item)) fail(400, 'INVALID_POLICY_METADATA', '정책 메타데이터에는 JSON 값만 사용할 수 있습니다.');
    if (seen.has(item)) fail(400, 'INVALID_POLICY_METADATA', '정책 메타데이터에 순환 참조가 있습니다.');
    seen.add(item);
    for (const child of Array.isArray(item) ? Array.from(item) : Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  }
  if (!plainObject(value)) fail(400, 'INVALID_POLICY_METADATA', 'policyMetadata는 JSON 객체여야 합니다.');
  visit(value);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 8192) fail(400, 'INVALID_POLICY_METADATA', '정책 메타데이터는 8192바이트 이하여야 합니다.');
  return JSON.parse(encoded);
}

export function createRlPool({ workerCount = DEFAULT_WORKER_COUNT, maxEnvs = MAX_ENVS, maxPending = 16, historyStore = null } = {}) {
  if (!integerIn(workerCount, 1, 16) || !integerIn(maxEnvs, 1, MAX_ENVS) || !integerIn(maxPending, 1, Number.MAX_SAFE_INTEGER)) {
    fail(400, 'INVALID_RL_CONFIG', `workerCount는 1~16, maxEnvs는 1~${MAX_ENVS}, maxPending은 양의 정수여야 합니다.`);
  }
  const sessions = new Map(), workers = [], inFlight = new Map(), memoryRequests = new Map(), recordingTasks = new Set();
  let totalEnvs = 0, pending = 0, nextWorker = 0, rpcSequence = 0;
  let closed = false, closePromise, recordingError = null;

  function beginOperation() {
    if (closed) fail(503, 'RL_CLOSED', 'RL 환경 풀이 종료되었습니다.');
    if (recordingError) fail(503, 'RL_RECORDING_FAILED', '기록 저장소를 복구한 후 서버를 다시 시작해주세요.');
    if (pending >= maxPending) fail(429, 'RL_OVERLOADED', '대기 중인 RL 작업이 많습니다. 잠시 후 다시 시도해주세요.');
    pending++;
    return () => { pending--; };
  }
  function metadata(session) {
    return { sessionId: session.sessionId, version: session.version, requestId: session.requestId,
      numEnvs: session.numEnvs, maxEpisodeSteps: session.maxEpisodeSteps,
      invalidActionMode: session.invalidActionMode, policyMetadata: session.policyMetadata,
      createdAt: session.createdAt, updatedAt: session.updatedAt, busy: session.busy };
  }
  function sessionRecord(session) {
    return { ...metadata(session), baseSeed: session.baseSeed, startedAt: session.createdAt, status: 'in_progress' };
  }
  const response = session => structuredClone({ ...metadata(session), ...rulesVersions, results: session.results });
  const withoutStepEvent = result => ({ ...result, reward: 0, info: { ...result.info,
    scoreDelta: 0, clearedRows: [], clearedCols: [], refilled: false, actionValid: null,
    invalidActionReason: null, scoreBreakdown: { placement: 0, elimination: 0, allClear: 0 } } });

  function findSession(sessionId, { allowBusy = false } = {}) {
    if (closed) fail(503, 'RL_CLOSED', 'RL 환경 풀이 종료되었습니다.');
    const session = sessions.get(sessionId);
    if (!session) fail(404, 'RL_SESSION_NOT_FOUND', 'RL 세션을 찾을 수 없습니다.');
    if (session.busy && (!allowBusy || session.results.length !== session.numEnvs)) fail(409, 'SESSION_BUSY', '이 RL 세션에서 다른 작업을 처리 중입니다.');
    return session;
  }
  function validateBody(body) {
    if (!plainObject(body)) fail(400, 'INVALID_BODY', 'JSON 객체가 필요합니다.');
  }
  function validateVersion(session, body) {
    if (!integerIn(body.version, 1, Number.MAX_SAFE_INTEGER)) fail(400, 'INVALID_VERSION', '현재 세션의 version이 필요합니다.');
    if (body.version !== session.version) fail(409, 'VERSION_CONFLICT', 'RL 세션이 변경되었습니다. 최신 version으로 다시 시도해주세요.');
  }
  function validateSeed(seed) {
    if (!integerIn(seed, 1, MAX_SEED)) fail(400, 'INVALID_SEED', `seed는 1~${MAX_SEED} 정수여야 합니다.`);
  }

  function runRequest(scope, operation, body, payload, work) {
    if (closed) return Promise.reject(new ApiError(503, 'RL_CLOSED', 'RL 환경 풀이 종료되었습니다.'));
    const clientId = body.requestId === undefined ? randomUUID() : body.requestId;
    if (typeof clientId !== 'string' || !/^[\w.:-]{1,128}$/.test(clientId)) fail(400, 'INVALID_REQUEST_ID', 'requestId는 1~128자의 영문, 숫자, 밑줄, 점, 콜론, 하이픈이어야 합니다.');
    const fingerprint = createHash('sha256').update(stableJson({ operation, payload })).digest('hex');
    const key = scope + '\0' + clientId;
    const existing = inFlight.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_CONFLICT', '같은 requestId를 다른 요청에 사용할 수 없습니다.');
      return existing.promise.then(structuredClone);
    }
    const request = { scope, requestId: clientId, fingerprint };
    const entry = { fingerprint, promise: null };
    inFlight.set(key, entry);
    try {
      let found;
      if (historyStore) found = historyStore.lookupRequest(scope, clientId, fingerprint);
      else {
        const cached = memoryRequests.get(key);
        if (cached) {
          if (cached.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_CONFLICT', '같은 requestId를 다른 요청에 사용할 수 없습니다.');
          found = JSON.parse(inflateSync(cached.response).toString('utf8'));
        }
      }
      const execute = previous => previous ?? work(request);
      const result = found?.then ? found.then(execute) : execute(found);
      entry.promise = Promise.resolve(result).then(value => {
        if (!historyStore) memoryRequests.set(key, { fingerprint, response: deflateSync(JSON.stringify(value), { level: 1 }) });
        return structuredClone(value);
      }).finally(() => { if (inFlight.get(key) === entry) inFlight.delete(key); });
    } catch (error) {
      inFlight.delete(key);
      entry.promise = Promise.reject(error);
    }
    return entry.promise;
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
  function closeRecording(session, reason) {
    if (session.closurePromise) return session.closurePromise;
    if (!historyStore || !session.persisted) return Promise.resolve();
    const task = Promise.resolve().then(() => historyStore.closeSession(session.sessionId, reason)).catch(error => {
      recordingError = error;
    });
    recordingTasks.add(task);
    task.finally(() => recordingTasks.delete(task));
    session.closurePromise = task;
    return task;
  }
  function invalidateSession(session, error, { cleanup = true, reason = 'interrupted', recordClosure = true } = {}) {
    if (sessions.get(session.sessionId) !== session) return session.closurePromise ?? Promise.resolve();
    sessions.delete(session.sessionId);
    totalEnvs -= session.numEnvs;
    session.invalidError = error;
    for (const [index, envIds] of groups(session)) {
      const record = workers[index];
      if (!record) continue;
      if (session.countsAccounted) record.envCount = Math.max(0, record.envCount - envIds.length);
      if (error) for (const [id, entry] of record.pending) {
        if (entry.sessionId !== session.sessionId) continue;
        record.pending.delete(id); clearTimeout(entry.timer); entry.reject(error);
      }
      if (cleanup && !closed && !record.dead) void rpc(record, { op: 'delete', sessionId: session.sessionId }).catch(() => {});
    }
    return recordClosure ? closeRecording(session, reason) : Promise.resolve();
  }
  function failWorker(record, error) {
    if (record.dead) return;
    record.dead = true;
    for (const entry of record.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    record.pending.clear();
    void record.worker.terminate().catch(() => {});
    for (const session of [...sessions.values()]) if (session.assignments.includes(record.index)) invalidateSession(session, error);
    record.envCount = 0;
  }
  function startWorker(index) {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { execArgv: [] });
    const record = { index, worker, threadId: worker.threadId, envCount: 0, pending: new Map(), dead: false };
    worker.on('message', message => {
      const entry = record.pending.get(message.requestId);
      if (!entry) return;
      record.pending.delete(message.requestId); clearTimeout(entry.timer);
      if (message.error) entry.reject(new ApiError(message.error.status, message.error.code, message.error.message));
      else entry.resolve(message.result);
    });
    worker.on('error', () => failWorker(record, new ApiError(503, 'RL_WORKER_FAILED', 'RL worker가 종료되어 관련 세션이 무효화되었습니다.')));
    worker.on('exit', () => failWorker(record, new ApiError(503, 'RL_WORKER_FAILED', 'RL worker가 종료되어 관련 세션이 무효화되었습니다.')));
    workers[index] = record;
    return record;
  }
  function ensureWorkers() {
    if (closed) fail(503, 'RL_CLOSED', 'RL 환경 풀이 종료되었습니다.');
    for (let index = 0; index < workerCount; index++) if (!workers[index] || workers[index].dead) startWorker(index);
  }
  function rpc(record, payload) {
    if (closed || record.dead) return Promise.reject(new ApiError(503, 'RL_WORKER_FAILED', 'RL worker를 사용할 수 없습니다.'));
    const id = ++rpcSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => failWorker(record, new ApiError(503, 'RL_WORKER_TIMEOUT', 'RL worker 응답 시간이 초과되어 관련 세션이 무효화되었습니다.')), WORKER_TIMEOUT_MS);
      timer.unref();
      record.pending.set(id, { resolve, reject, timer, sessionId: payload.sessionId });
      try { record.worker.postMessage({ ...payload, requestId: id }); }
      catch { failWorker(record, new ApiError(503, 'RL_WORKER_FAILED', 'RL worker에 요청을 보내지 못했습니다.')); }
    });
  }
  async function dispatch(session, op, envIds, extra = {}) {
    const values = await Promise.all([...groups(session, envIds)].map(([index, ids]) => {
      const payload = { op, sessionId: session.sessionId, envIds: ids, ...extra };
      if (op === 'step') payload.actions = ids.map(envId => ({ envId, action: extra.actions[envId] }));
      return rpc(workers[index], payload);
    }));
    if (session.invalidError) throw session.invalidError;
    return Object.fromEntries(['results', 'snapshots', 'starts', 'steps', 'ends'].map(key => [key, values.flatMap(value => value[key] ?? [])]));
  }
  async function persist(session, changes, request, result, liveSession = session) {
    if (historyStore) await historyStore.commit({ session: sessionRecord(session),
      starts: changes.starts, steps: changes.steps, ends: changes.ends, request: { ...request, response: result },
      // The durable store calls this immediately before its synchronous write
      // transaction. A delayed adapter must not commit a now-failed session.
      assertActive() {
        if (liveSession.invalidError) throw liveSession.invalidError;
        if (closed || sessions.get(liveSession.sessionId) !== liveSession) {
          throw new ApiError(503, 'RL_CLOSED', '기록을 저장하기 전에 실행 세션이 중단되었습니다.');
        }
      } });
    session.persisted = true;
  }
  async function mutate(session, request, work) {
    const finish = beginOperation();
    session.busy = true;
    try {
      const changes = await work();
      if (session.invalidError) throw session.invalidError;
      const next = { ...session, results: session.results.map(withoutStepEvent), snapshots: session.snapshots.slice(),
        version: session.version + 1, requestId: request.requestId, updatedAt: new Date().toISOString(), busy: false };
      for (const result of changes.results) next.results[result.envId] = result;
      for (const value of changes.snapshots) next.snapshots[value.envId] = value;
      const result = response(next);
      await persist(next, changes, request, result, session);
      if (session.invalidError) throw session.invalidError;
      Object.assign(session, next);
      return result;
    } catch (error) {
      await invalidateSession(session, error);
      if (error.status) throw error;
      throw new ApiError(503, 'RL_RECORDING_FAILED', '플레이 기록 저장에 실패하여 실행 세션을 중단했습니다.');
    } finally { session.busy = false; finish(); }
  }

  return {
    async create(options = {}) {
      validateBody(options);
      const payload = { numEnvs: options.numEnvs === undefined ? Math.min(DEFAULT_NUM_ENVS, maxEnvs) : options.numEnvs,
        seed: options.seed === undefined ? 1 : options.seed,
        maxEpisodeSteps: options.maxEpisodeSteps === undefined ? 10000 : options.maxEpisodeSteps,
        invalidActionMode: options.invalidActionMode === undefined ? 'reject' : options.invalidActionMode,
        policyMetadata: policyMetadata(options.policyMetadata) };
      return runRequest('$create', 'create', options, payload, async request => {
        const { numEnvs, seed, maxEpisodeSteps, invalidActionMode } = payload;
        if (!integerIn(numEnvs, 1, maxEnvs)) fail(400, 'INVALID_NUM_ENVS', `numEnvs는 1~${maxEnvs} 정수여야 합니다.`);
        if (!integerIn(maxEpisodeSteps, 1, 10_000_000)) fail(400, 'INVALID_EPISODE_STEPS', 'maxEpisodeSteps는 1~10000000 정수여야 합니다.');
        if (!['reject', 'transition'].includes(invalidActionMode)) fail(400, 'INVALID_ACTION_MODE', 'invalidActionMode는 reject 또는 transition이어야 합니다.');
        validateSeed(seed);
        const finish = beginOperation();
        let session;
        try {
          if (totalEnvs + numEnvs > maxEnvs) fail(409, 'ENV_LIMIT', `RL 환경은 전체 세션을 합해 최대 ${maxEnvs}개까지 사용할 수 있습니다.`);
          const createdAt = new Date().toISOString();
          session = { sessionId: randomUUID(), version: 1, requestId: request.requestId,
            numEnvs, maxEpisodeSteps, invalidActionMode, baseSeed: seed, policyMetadata: payload.policyMetadata,
            createdAt, updatedAt: createdAt, busy: true, results: [], snapshots: [], countsAccounted: false, persisted: false,
            assignments: Array.from({ length: numEnvs }, (_, index) => (nextWorker + index) % workerCount) };
          nextWorker = (nextWorker + numEnvs) % workerCount;
          sessions.set(session.sessionId, session); totalEnvs += numEnvs;
          ensureWorkers();
          for (const [index, ids] of groups(session)) workers[index].envCount += ids.length;
          session.countsAccounted = true;
          const changes = await dispatch(session, 'create', undefined, { seed, maxEpisodeSteps, invalidActionMode, policyMetadata: payload.policyMetadata });
          const next = { ...session, results: changes.results.sort((a, b) => a.envId - b.envId),
            snapshots: changes.snapshots.sort((a, b) => a.envId - b.envId), busy: false };
          const result = response(next);
          await persist(next, changes, request, result, session);
          if (session.invalidError) throw session.invalidError;
          Object.assign(session, next);
          return result;
        } catch (error) {
          if (session) await invalidateSession(session, error);
          if (error.status) throw error;
          throw new ApiError(503, 'RL_RECORDING_FAILED', '플레이 기록을 만들지 못해 실행 세션을 중단했습니다.');
        } finally { finish(); }
      });
    },
    async get(sessionId) { return response(findSession(sessionId, { allowBusy: true })); },
    async reset(sessionId, body) {
      validateBody(body);
      const payload = { version: body.version,
        ...(body.envIds === undefined ? {} : { envIds: Array.isArray(body.envIds) ? body.envIds.slice() : body.envIds }),
        ...(body.seed === undefined ? {} : { seed: body.seed }) };
      return runRequest(sessionId, 'reset', body, payload, async request => {
        const session = findSession(sessionId); validateVersion(session, payload);
        if (payload.seed !== undefined) validateSeed(payload.seed);
        const envIds = payload.envIds === undefined ? Array.from({ length: session.numEnvs }, (_, id) => id) : payload.envIds;
        if (!Array.isArray(envIds) || envIds.length === 0 || envIds.length > session.numEnvs ||
            Array.from(envIds).some(id => !integerIn(id, 0, session.numEnvs - 1)) || new Set(envIds).size !== envIds.length) fail(400, 'INVALID_ENV_IDS', 'envIds는 중복 없는 환경 번호 배열이어야 합니다.');
        return mutate(session, request, () => dispatch(session, 'reset', envIds, { seed: payload.seed }));
      });
    },
    async step(sessionId, body) {
      validateBody(body);
      const payload = { version: body.version, actions: Array.isArray(body.actions) ? body.actions.slice() : body.actions };
      return runRequest(sessionId, 'step', body, payload, async request => {
        const session = findSession(sessionId); validateVersion(session, payload);
        if (!Array.isArray(payload.actions) || payload.actions.length !== session.numEnvs) fail(400, 'INVALID_ACTIONS', 'actions에는 환경 개수만큼의 action 또는 null이 필요합니다.');
        for (let envId = 0; envId < session.numEnvs; envId++) {
          const action = payload.actions[envId];
          if (action === null) continue;
          if (!integerIn(action, 0, ACTION_COUNT - 1)) fail(400, 'INVALID_ACTION', `환경 ${envId}의 action은 0~191 정수 또는 null이어야 합니다.`);
          const result = session.results[envId];
          if (result.terminated || result.truncated) fail(422, 'RL_ENV_DONE', `환경 ${envId}를 먼저 reset해야 합니다.`);
          if (session.invalidActionMode === 'reject' && result.actionMask[action] !== 1) fail(422, 'ILLEGAL_ACTION', `환경 ${envId}에 놓을 수 없는 action입니다.`);
        }
        return mutate(session, request, () => dispatch(session, 'step', undefined, { actions: payload.actions, commandRequestId: request.requestId }));
      });
    },
    async snapshot(sessionId, envId) {
      const session = findSession(sessionId, { allowBusy: true });
      if (!integerIn(envId, 0, session.numEnvs - 1)) fail(404, 'RL_ENV_NOT_FOUND', 'RL 환경을 찾을 수 없습니다.');
      const finish = beginOperation();
      try {
        const value = structuredClone(session.snapshots[envId]);
        value.legalMoves = session.results[envId].observation.tray.map((id, slot) => {
          const positions = [];
          for (let index = 0; index < 64; index++) if (session.results[envId].actionMask[slot * 64 + index]) positions.push({ row: Math.floor(index / 8), col: index % 8 });
          return { slot, id, positions };
        });
        return value;
      } finally { finish(); }
    },
    async delete(sessionId) {
      const session = findSession(sessionId), finish = beginOperation();
      session.busy = true;
      try {
        await dispatch(session, 'delete');
        if (historyStore) await historyStore.closeSession(sessionId, 'session_closed');
        if (session.invalidError) throw session.invalidError;
        invalidateSession(session, null, { cleanup: false, recordClosure: false });
        return { sessionId, deleted: true, numEnvs: session.numEnvs };
      } catch (error) {
        await invalidateSession(session, error);
        if (error.status) throw error;
        throw new ApiError(503, 'RL_RECORDING_FAILED', '세션 종료 기록을 저장하지 못했습니다.');
      } finally { session.busy = false; finish(); }
    },
    async drainRecording() { while (recordingTasks.size) await Promise.all([...recordingTasks]); },
    stats() {
      return { ...rulesVersions, workerCount, activeWorkers: workers.filter(worker => !worker.dead).length,
        workers: workers.map(worker => ({ index: worker.index, threadId: worker.threadId, envCount: worker.envCount, alive: !worker.dead })),
        sessions: [...sessions.values()].map(metadata), sessionCount: sessions.size, totalEnvs, pending, maxPending, maxEnvs, closed,
        recordingEnabled: Boolean(historyStore), recordingError: recordingError?.code ?? (recordingError ? 'RL_RECORDING_FAILED' : null) };
    },
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      const error = new ApiError(503, 'RL_CLOSED', 'RL 환경 풀이 종료되었습니다.');
      for (const session of [...sessions.values()]) invalidateSession(session, error, { cleanup: false });
      for (const worker of workers) failWorker(worker, error);
      closePromise = Promise.all(workers.map(worker => worker.worker.terminate())).then(async () => {
        while (recordingTasks.size) await Promise.all([...recordingTasks]);
      });
      return closePromise;
    },
  };
}
