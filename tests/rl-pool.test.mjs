import test from 'node:test';
import assert from 'node:assert/strict';
import workerThreads, { threadId } from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { createRlPool } from '../server/rl/pool.mjs';
import { DEFAULT_NUM_ENVS, MAX_ENVS, DEFAULT_WORKER_COUNT } from '../server/rl/protocol.mjs';

const errorIs = (status, code) => error => error.status === status && error.code === code;
const firstAction = result => result.actionMask.findIndex(Boolean);
const actionsFor = session => session.results.map(result =>
  result.terminated || result.truncated ? null : firstAction(result));
// Independent executions intentionally have different archival identities.
const trajectory = results => results.map(({ gameId, ...result }) => result);

test('pool configuration is bounded and workers start lazily', async t => {
  for (const config of [{ workerCount: 0 }, { workerCount: 17 }, { maxEnvs: 513 }, { maxEnvs: 0 }, { maxPending: 0 }]) {
    assert.throws(() => createRlPool(config), errorIs(400, 'INVALID_RL_CONFIG'));
  }
  const pool = createRlPool();
  t.after(() => pool.close());
  assert.equal(pool.stats().activeWorkers, 0);
  assert.deepEqual(pool.stats().workers, []);
  for (const body of [null, [], 5, '100', new Date()]) {
    await assert.rejects(pool.create(body), errorIs(400, 'INVALID_BODY'));
  }
  await assert.rejects(pool.create({ seed: 0 }), errorIs(400, 'INVALID_SEED'));
  await assert.rejects(pool.create({ numEnvs: 513 }), errorIs(400, 'INVALID_NUM_ENVS'));
  await assert.rejects(pool.create({ invalidActionMode: 'penalty' }), errorIs(400, 'INVALID_ACTION_MODE'));
  assert.equal(pool.stats().activeWorkers, 0);
});

test('default creation uses 256 environments across four workers and honors a smaller custom cap', async t => {
  assert.equal(DEFAULT_NUM_ENVS, 256);
  assert.equal(MAX_ENVS, 512);
  assert.equal(DEFAULT_WORKER_COUNT, 4);
  const pool = createRlPool();
  const small = createRlPool({ workerCount: 1, maxEnvs: 3 });
  t.after(() => Promise.all([pool.close(), small.close()]));
  const session = await pool.create();
  assert.equal(session.numEnvs, 256);
  assert.equal(session.results.length, 256);
  assert.equal(pool.stats().maxEnvs, 512);
  assert.equal(pool.stats().workerCount, 4);
  assert.deepEqual(pool.stats().workers.map(worker => worker.envCount), [64, 64, 64, 64]);
  const capped = await small.create();
  assert.equal(capped.numEnvs, 3);
  assert.equal(capped.results.length, 3);
});

test('two concurrent default sessions reserve the global 512-environment capacity', async t => {
  const pool = createRlPool();
  t.after(() => pool.close());
  const first = pool.create();
  const second = pool.create();
  assert.equal(pool.stats().totalEnvs, 512);
  await assert.rejects(pool.create({ numEnvs: 1 }), errorIs(409, 'ENV_LIMIT'));
  await assert.rejects(pool.create({ numEnvs: 513 }), errorIs(400, 'INVALID_NUM_ENVS'));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.numEnvs, 256);
  assert.equal(b.numEnvs, 256);
  assert.equal(pool.stats().sessionCount, 2);
  assert.deepEqual(pool.stats().workers.map(worker => worker.envCount), [128, 128, 128, 128]);
  await pool.delete(a.sessionId);
  const replacement = await pool.create();
  assert.equal(replacement.numEnvs, 256);
  assert.equal(pool.stats().totalEnvs, 512);
});

test('environment 511 supports stepping, viewer snapshots and subset reset in a 512-environment session', async t => {
  const pool = createRlPool();
  t.after(() => pool.close());
  const initial = await pool.create({ numEnvs: 512, seed: 9 });
  const before = await pool.snapshot(initial.sessionId, 511);
  assert.equal(before.id, `${initial.sessionId}-511`);
  const actions = Array(512).fill(null);
  actions[511] = firstAction(initial.results[511]);
  let session = await pool.step(initial.sessionId, { version: initial.version, actions });
  assert.equal(session.results[511].observation.moves, 1);
  assert.ok(session.results[511].reward > 0);
  assert.ok(session.results.slice(0, 511).every(result => result.observation.moves === 0 && result.version === 1));
  const after = await pool.snapshot(session.sessionId, 511);
  assert.equal(after.state.moves, 1);
  assert.equal(after.version, before.version + 1);
  session = await pool.reset(session.sessionId, { version: session.version, envIds: [511], seed: 9 });
  assert.deepEqual(session.results[511].observation, initial.results[511].observation);
  assert.equal(session.results[511].episodeId, 1);
  assert.equal(session.results[511].version, after.version + 1);
  assert.equal((await pool.snapshot(session.sessionId, 511)).state.moves, 0);
});

test('seeded trajectories and resets are identical with one and four real worker threads', async t => {
  const one = createRlPool({ workerCount: 1 });
  const four = createRlPool({ workerCount: 4 });
  t.after(() => Promise.all([one.close(), four.close()]));
  let [a, b] = await Promise.all([
    one.create({ numEnvs: 12, seed: 1234, maxEpisodeSteps: 7 }),
    four.create({ numEnvs: 12, seed: 1234, maxEpisodeSteps: 7 }),
  ]);
  assert.deepEqual(trajectory(a.results), trajectory(b.results));
  assert.equal(a.engineRulesVersion, 'reconstruction-v1');
  assert.equal(a.scoreRulesVersion, 2);
  assert.equal(a.invalidActionMode, 'reject');
  const stats = four.stats();
  assert.equal(stats.activeWorkers, 4);
  assert.equal(new Set(stats.workers.map(worker => worker.threadId)).size, 4);
  assert.ok(stats.workers.every(worker => worker.threadId > 0 && worker.threadId !== threadId));
  assert.deepEqual(stats.workers.map(worker => worker.envCount), [3, 3, 3, 3]);
  for (let step = 0; step < 15; step++) {
    const doneIds = a.results.filter(result => result.terminated || result.truncated).map(result => result.envId);
    if (doneIds.length) {
      [a, b] = await Promise.all([
        one.reset(a.sessionId, { version: a.version, envIds: doneIds }),
        four.reset(b.sessionId, { version: b.version, envIds: doneIds }),
      ]);
      assert.deepEqual(trajectory(a.results), trajectory(b.results));
    }
    const actions = actionsFor(a);
    const previous = a;
    [a, b] = await Promise.all([
      one.step(a.sessionId, { version: a.version, actions }),
      four.step(b.sessionId, { version: b.version, actions }),
    ]);
    assert.deepEqual(trajectory(a.results), trajectory(b.results));
    for (let envId = 0; envId < a.numEnvs; envId++) {
      const result = a.results[envId];
      assert.equal(result.reward, result.observation.score - previous.results[envId].observation.score);
      assert.equal(result.info.scoreDelta, result.reward);
      assert.equal(result.info.actionValid, true);
      assert.equal(result.info.invalidActionReason, null);
      assert.equal(result.actionMask.length, 192);
      assert.ok(result.observation.board.flat().every(cell => cell === 0 || cell === 1));
      assert.equal(Object.hasOwn(result.observation, 'seed'), false);
      assert.equal(Object.hasOwn(result, 'state'), false);
    }
  }
});

test('an invalid action late in a batch cannot partially advance any environment', async t => {
  const pool = createRlPool({ workerCount: 2 });
  t.after(() => pool.close());
  const initial = await pool.create({ numEnvs: 4, seed: 77 });
  const before = await pool.get(initial.sessionId);
  const beforeSnapshot = await pool.snapshot(initial.sessionId, 0);
  const actions = actionsFor(initial);
  const illegal = initial.results[3].actionMask.findIndex(value => value === 0);
  assert.ok(illegal >= 0);
  actions[3] = illegal;
  // Caller mutation of returned masks must not modify the validation cache.
  initial.results[3].actionMask[illegal] = 1;
  await assert.rejects(pool.step(initial.sessionId, { version: initial.version, actions }), errorIs(422, 'ILLEGAL_ACTION'));
  assert.deepEqual(await pool.get(initial.sessionId), before);
  assert.deepEqual(await pool.snapshot(initial.sessionId, 0), beforeSnapshot);
  await assert.rejects(pool.step(initial.sessionId, { version: initial.version, actions: [0] }), errorIs(400, 'INVALID_ACTIONS'));
  await assert.rejects(pool.step(initial.sessionId, { version: initial.version, actions: [null, null, null, 192] }), errorIs(400, 'INVALID_ACTION'));
  assert.deepEqual(await pool.get(initial.sessionId), before);
});

test('environment capacity is reserved before asynchronous creation and released on delete', async t => {
  const pool = createRlPool({ workerCount: 2, maxEnvs: 3 });
  t.after(() => pool.close());
  const creating = pool.create({ numEnvs: 2, seed: 10 });
  await assert.rejects(pool.create({ numEnvs: 2, seed: 11 }), errorIs(409, 'ENV_LIMIT'));
  const a = await creating;
  const b = await pool.create({ numEnvs: 1, seed: 12 });
  assert.equal(pool.stats().totalEnvs, 3);
  assert.equal(pool.stats().sessionCount, 2);
  assert.equal(pool.stats().sessions.length, 2);
  await assert.rejects(pool.create({ numEnvs: 1 }), errorIs(409, 'ENV_LIMIT'));
  await pool.delete(a.sessionId);
  await assert.rejects(pool.get(a.sessionId), errorIs(404, 'RL_SESSION_NOT_FOUND'));
  const c = await pool.create({ numEnvs: 2 });
  assert.equal(pool.stats().workers.reduce((sum, worker) => sum + worker.envCount, 0), 3);
  await Promise.all([pool.delete(b.sessionId), pool.delete(c.sessionId)]);
  assert.equal(pool.stats().totalEnvs, 0);
  assert.ok(pool.stats().workers.every(worker => worker.envCount === 0));
});

test('session mutations reject overlap and stale versions without affecting the accepted batch', async t => {
  const pool = createRlPool({ workerCount: 2 });
  t.after(() => pool.close());
  const initial = await pool.create({ numEnvs: 4, seed: 5 });
  const command = { version: initial.version, actions: actionsFor(initial) };
  const first = pool.step(initial.sessionId, command);
  await assert.rejects(pool.step(initial.sessionId, command), errorIs(409, 'SESSION_BUSY'));
  const next = await first;
  assert.equal(next.version, initial.version + 1);
  assert.ok(next.results.every(result => result.observation.moves === 1));
  await assert.rejects(pool.reset(initial.sessionId, { version: initial.version }), errorIs(409, 'VERSION_CONFLICT'));
  assert.equal((await pool.get(initial.sessionId)).version, next.version);
});

test('viewer snapshots before and during a training step never lock out mutations', async t => {
  const pool = createRlPool({ workerCount: 2 });
  t.after(() => pool.close());
  let session = await pool.create({ numEnvs: 4, seed: 55 });
  const before = pool.snapshot(session.sessionId, 0);
  const first = pool.step(session.sessionId, { version: session.version, actions: actionsFor(session) });
  const [snapshot, stepped] = await Promise.all([before, first]);
  assert.equal(snapshot.state.moves, 0);
  assert.equal(stepped.results[0].observation.moves, 1);
  session = stepped;
  const second = pool.step(session.sessionId, { version: session.version, actions: actionsFor(session) });
  const during = pool.snapshot(session.sessionId, 0);
  const cached = await pool.get(session.sessionId);
  assert.equal(cached.version, session.version);
  const [again, viewed] = await Promise.all([second, during]);
  assert.equal(again.results[0].observation.moves, 2);
  // Pending state is invisible until its recording transaction is committed.
  assert.equal(viewed.state.moves, 1);
  assert.equal(viewed.version, session.results[0].version);
});

test('bounded pending work returns overload without invalidating a live session', async t => {
  const pool = createRlPool({ workerCount: 1, maxPending: 1 });
  t.after(() => pool.close());
  const creating = pool.create({ numEnvs: 2 });
  await assert.rejects(pool.create({ numEnvs: 1 }), errorIs(429, 'RL_OVERLOADED'));
  const session = await creating;
  const stepping = pool.step(session.sessionId, { version: session.version, actions: actionsFor(session) });
  await assert.rejects(pool.snapshot(session.sessionId, 0), errorIs(429, 'RL_OVERLOADED'));
  const next = await stepping;
  assert.equal((await pool.get(session.sessionId)).version, next.version);
  assert.equal(pool.stats().pending, 0);
});

test('truncation, null skips, deterministic subset resets and monotonic snapshot versions', async t => {
  const pool = createRlPool({ workerCount: 2 });
  t.after(() => pool.close());
  const initial = await pool.create({ numEnvs: 2, seed: 123, maxEpisodeSteps: 1 });
  let session = await pool.step(initial.sessionId, { version: initial.version, actions: actionsFor(initial) });
  assert.ok(session.results.every(result => result.truncated && !result.terminated));
  const doneVersion = session.results[0].version;
  await assert.rejects(pool.step(session.sessionId, { version: session.version, actions: session.results.map(firstAction) }), errorIs(422, 'RL_ENV_DONE'));
  session = await pool.step(session.sessionId, { version: session.version, actions: [null, null] });
  assert.ok(session.results.every(result => result.reward === 0 && result.version === doneVersion));
  assert.ok(session.results.every(result => result.info.scoreDelta === 0));
  const untouched = structuredClone(session.results[1]);
  session = await pool.reset(session.sessionId, { version: session.version, envIds: [0], seed: 123 });
  assert.deepEqual(session.results[0].observation, initial.results[0].observation);
  assert.equal(session.results[0].episodeId, initial.results[0].episodeId + 1);
  assert.equal(session.results[0].version, doneVersion + 1);
  assert.equal(session.results[0].truncated, false);
  assert.equal(session.results[0].info.scoreDelta, 0);
  assert.deepEqual(session.results[1], untouched);
  const snapshot = await pool.snapshot(session.sessionId, 0);
  assert.equal(snapshot.id, `${session.sessionId}-0`);
  assert.equal(snapshot.version, session.results[0].version);
  assert.equal(snapshot.canUndo, false);
  assert.equal(snapshot.lastMove, null);
  assert.ok(Number.isInteger(snapshot.state.seed));
  const firstReset = session.results[0];
  session = await pool.reset(session.sessionId, { version: session.version, envIds: [0], seed: 123 });
  assert.deepEqual(session.results[0].observation, firstReset.observation);
  assert.equal(session.results[0].episodeId, firstReset.episodeId + 1);
  assert.equal(session.results[0].version, firstReset.version + 1);
  for (const envIds of [null, [], [0, 0], [-1], [2], Array(1)]) {
    await assert.rejects(pool.reset(session.sessionId, { version: session.version, envIds }), errorIs(400, 'INVALID_ENV_IDS'));
  }
});

test('subset reset clears step event fields without changing untouched environment state', async t => {
  const pool = createRlPool({ workerCount: 2 });
  t.after(() => pool.close());
  let session = await pool.create({ numEnvs: 2, seed: 7 });
  session = await pool.step(session.sessionId, { version: session.version, actions: actionsFor(session) });
  const untouched = session.results[1];
  assert.ok(untouched.reward > 0);
  assert.ok(untouched.info.scoreBreakdown.placement > 0);
  session = await pool.reset(session.sessionId, { version: session.version, envIds: [0] });
  const result = session.results[1];
  assert.deepEqual(result.observation, untouched.observation);
  assert.equal(result.version, untouched.version);
  assert.equal(result.reward, 0);
  assert.equal(result.info.scoreDelta, 0);
  assert.equal(result.info.actionValid, null);
  assert.equal(result.info.invalidActionReason, null);
  assert.deepEqual(result.info.clearedRows, []);
  assert.deepEqual(result.info.clearedCols, []);
  assert.equal(result.info.refilled, false);
  assert.deepEqual(result.info.scoreBreakdown, { placement: 0, elimination: 0, allClear: 0 });
});

test('transition mode counts illegal attempts without changing game state or RNG', async t => {
  const pool = createRlPool({ workerCount: 2 });
  t.after(() => pool.close());
  let session = await pool.create({ numEnvs: 2, seed: 812, maxEpisodeSteps: 3, invalidActionMode: 'transition' });
  assert.equal(session.invalidActionMode, 'transition');
  assert.ok(session.results.every(result => result.info.actionValid === null));
  session = await pool.step(session.sessionId, { version: session.version, actions: actionsFor(session) });
  const before = session;
  const beforeSnapshot = await pool.snapshot(session.sessionId, 0);
  assert.ok(beforeSnapshot.lastMove);
  const illegal = before.results[0].actionMask.findIndex(value => value === 0);
  assert.ok(illegal >= 0);
  session = await pool.step(session.sessionId, {
    version: session.version, actions: [illegal, firstAction(session.results[1])],
  });
  const invalid = session.results[0];
  const valid = session.results[1];
  assert.deepEqual(invalid.observation, before.results[0].observation);
  assert.deepEqual(invalid.actionMask, before.results[0].actionMask);
  assert.equal(invalid.version, before.results[0].version + 1);
  assert.equal(invalid.info.episodeSteps, 2);
  assert.equal(invalid.reward, 0);
  assert.equal(invalid.info.scoreDelta, 0);
  assert.equal(invalid.info.actionValid, false);
  assert.equal(invalid.info.invalidActionReason, 'illegal_placement');
  assert.deepEqual(invalid.info.scoreBreakdown, { placement: 0, elimination: 0, allClear: 0 });
  assert.equal(invalid.truncated, false);
  assert.equal(invalid.terminated, false);
  const afterSnapshot = await pool.snapshot(session.sessionId, 0);
  assert.deepEqual(afterSnapshot.state, beforeSnapshot.state); // Includes internal RNG seed.
  assert.equal(afterSnapshot.lastMove, null);
  assert.equal(afterSnapshot.version, beforeSnapshot.version + 1);
  assert.equal(valid.observation.moves, before.results[1].observation.moves + 1);
  assert.equal(valid.info.actionValid, true);
  assert.equal(valid.info.invalidActionReason, null);
  assert.ok(valid.reward > 0);
  const unchanged = await pool.get(session.sessionId);
  await assert.rejects(pool.step(session.sessionId, {
    version: session.version, actions: [illegal, 192],
  }), errorIs(400, 'INVALID_ACTION'));
  assert.deepEqual(await pool.get(session.sessionId), unchanged);
  session = await pool.step(session.sessionId, { version: session.version, actions: [illegal, null] });
  assert.equal(session.results[0].truncated, true);
  assert.equal(session.results[0].info.episodeSteps, 3);
  assert.equal(session.results[0].observation.moves, 1);
  assert.equal(session.results[1].info.actionValid, null);
  assert.equal(session.results[1].reward, 0);
  await assert.rejects(pool.step(session.sessionId, {
    version: session.version, actions: [illegal, firstAction(session.results[1])],
  }), errorIs(422, 'RL_ENV_DONE'));
  session = await pool.reset(session.sessionId, { version: session.version, envIds: [0] });
  assert.equal(session.invalidActionMode, 'transition');
  assert.equal(session.results[0].info.actionValid, null);
  assert.equal(session.results[0].info.episodeSteps, 0);
  assert.equal(session.results[0].truncated, false);
  const afterResetIllegal = session.results[0].actionMask.findIndex(value => value === 0);
  session = await pool.step(session.sessionId, { version: session.version, actions: [afterResetIllegal, null] });
  assert.equal(session.results[0].info.actionValid, false);
  assert.equal(session.results[0].info.episodeSteps, 1);
  assert.equal(session.results[0].observation.moves, 0);
});

test('close rejects in-flight work, releases all capacity and terminates real worker threads', async () => {
  const pool = createRlPool({ workerCount: 4 });
  const creating = pool.create();
  const rejection = assert.rejects(creating, errorIs(503, 'RL_CLOSED'));
  await pool.close();
  await rejection;
  await pool.close();
  const stats = pool.stats();
  assert.equal(stats.closed, true);
  assert.equal(stats.activeWorkers, 0);
  assert.equal(stats.totalEnvs, 0);
  assert.equal(stats.sessionCount, 0);
  assert.equal(stats.pending, 0);
  await assert.rejects(pool.create({ numEnvs: 1 }), errorIs(503, 'RL_CLOSED'));
});

test('a dead worker rejects outstanding work, invalidates affected sessions and restarts lazily', async t => {
  // Capture actual Worker instances without adding a failure-control API to
  // production code. Node runs top-level tests in this file sequentially.
  const OriginalWorker = workerThreads.Worker;
  const captured = [];
  workerThreads.Worker = class extends OriginalWorker {
    constructor(...args) {
      super(...args);
      captured.push(this);
    }
  };
  syncBuiltinESMExports();
  const pool = createRlPool({ workerCount: 2 });
  t.after(async () => {
    workerThreads.Worker = OriginalWorker;
    syncBuiltinESMExports();
    await pool.close();
  });
  const affected = await pool.create({ numEnvs: 3, seed: 81 }); // workers 0, 1, 0
  const unaffected = await pool.create({ numEnvs: 1, seed: 82 }); // worker 1
  const oldThread = captured[0].threadId;
  const termination = captured[0].terminate();
  const command = pool.step(affected.sessionId, { version: affected.version, actions: actionsFor(affected) });
  const rejection = assert.rejects(command, errorIs(503, 'RL_WORKER_FAILED'));
  await Promise.all([termination, rejection]);
  await assert.rejects(pool.get(affected.sessionId), errorIs(404, 'RL_SESSION_NOT_FOUND'));
  assert.deepEqual((await pool.get(unaffected.sessionId)).results, unaffected.results);
  assert.equal(pool.stats().totalEnvs, 1);
  assert.equal(pool.stats().pending, 0);
  const replacement = await pool.create({ numEnvs: 1, seed: 83 });
  assert.equal(pool.stats().activeWorkers, 2);
  assert.notEqual(pool.stats().workers[0].threadId, oldThread);
  assert.equal(replacement.results.length, 1);
  assert.equal(pool.stats().workers.reduce((sum, worker) => sum + worker.envCount, 0), 2);
});
