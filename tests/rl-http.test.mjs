import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createApplication } from '../server/index.mjs';

const tempRoot = resolve('outputs/rl-http-tests');
async function start(context, rlOptions = {}) {
  await mkdir(tempRoot, { recursive: true });
  const dataDir = await mkdtemp(`${tempRoot}/run-`);
  const app = createApplication({ dataDir, rlOptions: { workerCount: 4, ...rlOptions } });
  context.after(async () => {
    await app.close();
    // Delete only this test's verified, freshly created directory.
    const absolute = resolve(dataDir);
    assert.equal(dirname(absolute), tempRoot);
    assert.ok(basename(absolute).startsWith('run-'));
    await rm(absolute, { recursive: true, force: true });
  });
  await new Promise((done, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', done);
  });
  return `http://127.0.0.1:${app.server.address().port}`;
}
async function request(origin, path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, {
    method, signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const firstActions = batch => batch.results.map(result => result.actionMask.findIndex(value => value === 1));

test('RL HTTP API distributes 100 in-memory environments across real worker threads and releases capacity', async context => {
  const origin = await start(context, { workerCount: 2, maxEnvs: 100 });
  const created = await request(origin, '/api/rl/sessions', { numEnvs: 100, seed: 123, maxEpisodeSteps: 100 });
  assert.equal(created.status, 201);
  const batch = created.body;
  assert.equal(batch.numEnvs, 100);
  assert.equal(batch.results.length, 100);
  assert.equal(batch.version, 1);
  assert.equal(new Set(batch.results.map(result => result.envId)).size, 100);
  assert.equal(batch.engineRulesVersion, 'reconstruction-v1');
  assert.equal(batch.scoreRulesVersion, 2);
  for (const result of batch.results) {
    assert.equal(result.observation.board.length, 8);
    assert.ok(result.observation.board.every(row => row.length === 8 && row.every(value => value === 0)));
    assert.equal(result.observation.tray.length, 3);
    assert.equal(Object.hasOwn(result.observation, 'seed'), false);
    assert.equal(result.actionMask.length, 192);
    assert.ok(result.actionMask.some(value => value === 1));
  }
  const stats = await request(origin, '/api/rl/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.workerCount, 2);
  assert.equal(stats.body.activeWorkers, 2);
  assert.equal(stats.body.totalEnvs, 100);
  const active = stats.body.workers.filter(worker => worker.envCount > 0);
  assert.equal(active.length, 2);
  assert.equal(new Set(active.map(worker => worker.threadId)).size, 2);
  assert.ok(active.every(worker => worker.threadId > 0 && worker.envCount === 50));
  const listed = await request(origin, '/api/rl/sessions');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.sessions.some(session => session.sessionId === batch.sessionId));
  const overflow = await request(origin, '/api/rl/sessions', { numEnvs: 1, seed: 1 });
  assert.equal(overflow.status, 409);
  assert.equal(overflow.body.error.code, 'ENV_LIMIT');
  const removed = await request(origin, `/api/rl/sessions/${batch.sessionId}`, undefined, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await request(origin, '/api/rl/stats')).body.totalEnvs, 0);
  assert.equal((await request(origin, `/api/rl/sessions/${batch.sessionId}`)).status, 404);
  assert.equal((await request(origin, '/api/rl/sessions', { numEnvs: 1, seed: 1 })).status, 201);
});

test('RL defaults to 256 environments on four workers and accepts full 512-environment batches within the HTTP limit', async context => {
  const origin = await start(context);
  const normal = (await request(origin, '/api/games', { seed: 123 })).body;
  const first = await request(origin, '/api/rl/sessions', {});
  assert.equal(first.status, 201);
  assert.equal(first.body.numEnvs, 256);
  assert.equal(first.body.results.length, 256);
  assert.equal(first.body.results.at(-1).envId, 255);
  const stats = (await request(origin, '/api/rl/stats')).body;
  assert.equal(stats.workerCount, 4);
  assert.equal(stats.activeWorkers, 4);
  assert.equal(stats.maxEnvs, 512);
  assert.equal(stats.totalEnvs, 256);
  assert.equal(new Set(stats.workers.map(worker => worker.threadId)).size, 4);
  assert.ok(stats.workers.every(worker => worker.threadId > 0 && worker.envCount === 64));

  const second = await request(origin, '/api/rl/sessions', {});
  assert.equal(second.status, 201);
  assert.equal(second.body.numEnvs, 256);
  assert.equal((await request(origin, '/api/rl/stats')).body.totalEnvs, 512);
  const overflow = await request(origin, '/api/rl/sessions', {});
  assert.equal(overflow.status, 409);
  assert.equal(overflow.body.error.code, 'ENV_LIMIT');
  const oversized = await request(origin, '/api/rl/sessions', { numEnvs: 513 });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.body.error.code, 'INVALID_NUM_ENVS');
  for (const batch of [first.body, second.body]) {
    assert.equal((await request(origin, `/api/rl/sessions/${batch.sessionId}`, undefined, 'DELETE')).status, 200);
  }
  assert.equal((await request(origin, '/api/rl/stats')).body.totalEnvs, 0);

  const created = await request(origin, '/api/rl/sessions', { numEnvs: 512, seed: 123 });
  assert.equal(created.status, 201);
  assert.equal(created.body.results.length, 512);
  const path = `/api/rl/sessions/${created.body.sessionId}`;
  const stepBody = { version: created.body.version, actions: firstActions(created.body) };
  assert.ok(Buffer.byteLength(JSON.stringify(stepBody)) < 8192);
  const stepped = await request(origin, `${path}/step`, stepBody);
  assert.equal(stepped.status, 200);
  assert.equal(stepped.body.results.length, 512);
  assert.ok(stepped.body.results.every(result => result.observation.moves === 1 && result.reward > 0));
  const resetBody = { version: stepped.body.version, envIds: Array.from({ length: 512 }, (_, id) => id), seed: 123 };
  assert.ok(Buffer.byteLength(JSON.stringify(resetBody)) < 8192);
  const reset = await request(origin, `${path}/reset`, resetBody);
  assert.equal(reset.status, 200);
  assert.equal(reset.body.results.length, 512);
  assert.ok(reset.body.results.every(result => result.observation.moves === 0 && result.reward === 0));
  const viewer = await request(origin, `${path}/envs/511`);
  assert.equal(viewer.status, 200);
  assert.equal(viewer.body.state.moves, 0);
  assert.equal(viewer.body.state.board.length, 8);
  const badEnv = await request(origin, `${path}/envs/512`);
  assert.equal(badEnv.status, 400);
  assert.equal(badEnv.body.error.code, 'INVALID_ENV_ID');
  assert.deepEqual((await request(origin, '/api/state')).body, normal);

  const docs = (await request(origin, '/api/openapi.json')).body;
  const createSchema = docs.paths['/api/rl/sessions'].post.requestBody.content['application/json'].schema;
  assert.equal(createSchema.properties.numEnvs.default, 256);
  assert.equal(createSchema.properties.numEnvs.maximum, 512);
  assert.equal(docs.components.schemas.RlBatch.properties.numEnvs.maximum, 512);
  assert.equal(docs.components.schemas.RlResult.properties.envId.maximum, 511);
});

test('RL HTTP step validates the whole batch, applies score rewards and rejects stale or concurrent versions', async context => {
  const origin = await start(context);
  const initial = (await request(origin, '/api/rl/sessions', { numEnvs: 4, seed: 123 })).body;
  const path = `/api/rl/sessions/${initial.sessionId}`;
  const valid = firstActions(initial);
  const invalid = valid.slice();
  invalid[3] = initial.results[3].actionMask.findIndex(value => value === 0);
  assert.ok(invalid[3] >= 0);
  const rejected = await request(origin, `${path}/step`, { version: initial.version, actions: invalid });
  assert.equal(rejected.status, 422);
  assert.deepEqual((await request(origin, path)).body, initial);
  const malformed = await request(origin, `${path}/step`, { version: initial.version, actions: [valid[0]] });
  assert.equal(malformed.status, 400);
  const placed = await request(origin, `${path}/step`, { version: initial.version, actions: valid });
  assert.equal(placed.status, 200);
  assert.equal(placed.body.version, initial.version + 1);
  for (const result of placed.body.results) {
    assert.equal(result.observation.moves, 1);
    assert.equal(result.reward, result.observation.score - initial.results[result.envId].observation.score);
    assert.ok(result.reward > 0);
  }
  const stale = await request(origin, `${path}/step`, { version: initial.version, actions: valid });
  assert.equal(stale.status, 409);
  const next = firstActions(placed.body);
  const concurrent = await Promise.all([
    request(origin, `${path}/step`, { version: placed.body.version, actions: next }),
    request(origin, `${path}/step`, { version: placed.body.version, actions: next }),
  ]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  const latest = (await request(origin, path)).body;
  assert.equal(latest.version, placed.body.version + 1);
  assert.ok(latest.results.every(result => result.observation.moves === 2));
});

test('RL truncation retains final observations until an explicit subset reset and supports an observer snapshot', async context => {
  const origin = await start(context);
  const initial = (await request(origin, '/api/rl/sessions', { numEnvs: 3, seed: 42, maxEpisodeSteps: 1 })).body;
  const path = `/api/rl/sessions/${initial.sessionId}`;
  const stepped = (await request(origin, `${path}/step`, { version: initial.version, actions: firstActions(initial) })).body;
  assert.ok(stepped.results.every(result => result.truncated && !result.terminated && result.observation.moves === 1));
  const forbidden = await request(origin, `${path}/step`, { version: stepped.version, actions: firstActions(initial) });
  assert.equal(forbidden.status, 422);
  const skipped = await request(origin, `${path}/step`, { version: stepped.version, actions: [null, null, null] });
  assert.equal(skipped.status, 200);
  assert.ok(skipped.body.results.every(result => result.observation.moves === 1));
  const observer = await request(origin, `${path}/envs/0`);
  assert.equal(observer.status, 200);
  assert.equal(observer.body.state.moves, 1);
  assert.equal(observer.body.canUndo, false);
  assert.equal(observer.body.state.board.length, 8);
  assert.equal(observer.body.legalMoves.length, 3);
  const reset = await request(origin, `${path}/reset`, { version: skipped.body.version, envIds: [0], seed: 42 });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.results[0].observation.moves, 0);
  assert.equal(reset.body.results[0].truncated, false);
  assert.deepEqual(reset.body.results[0].observation, initial.results[0].observation);
  assert.equal(reset.body.results[1].observation.moves, 1);
  assert.equal(reset.body.results[1].truncated, true);
  assert.ok(reset.body.results[0].episodeId > initial.results[0].episodeId);
});

test('RL validation and sessions do not replace the persisted web game', async context => {
  const origin = await start(context);
  const normal = (await request(origin, '/api/games', { seed: 123 })).body;
  for (const body of [{ numEnvs: 513 }, { numEnvs: 0 }, { numEnvs: 1, seed: 0 }, { numEnvs: 1, maxEpisodeSteps: 0 }, { numEnvs: 1, invalidActionMode: 'unknown' }]) {
    const invalid = await request(origin, '/api/rl/sessions', body);
    assert.equal(invalid.status, 400);
  }
  const session = (await request(origin, '/api/rl/sessions', { numEnvs: 2, seed: 123 })).body;
  const placed = await request(origin, `/api/rl/sessions/${session.sessionId}/step`, { version: session.version, actions: firstActions(session) });
  assert.equal(placed.status, 200);
  assert.deepEqual((await request(origin, '/api/state')).body, normal);
  assert.equal((await request(origin, `/api/rl/sessions/${session.sessionId}/envs/2`)).status, 404);
  const badEnv = await request(origin, `/api/rl/sessions/${session.sessionId}/envs/not-a-number`);
  assert.equal(badEnv.status, 400);
  assert.equal(badEnv.body.error.code, 'INVALID_ENV_ID');
  const crossOrigin = await fetch(`${origin}/api/rl/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' },
    body: JSON.stringify({ numEnvs: 1, seed: 1 }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, 'INVALID_ORIGIN');
  const deleteCrossOrigin = await fetch(`${origin}/api/rl/sessions/${session.sessionId}`, {
    method: 'DELETE', headers: { Origin: 'https://unrelated.example' },
  });
  assert.equal(deleteCrossOrigin.status, 403);
  assert.equal((await deleteCrossOrigin.json()).error.code, 'INVALID_ORIGIN');
  assert.equal((await request(origin, `/api/rl/sessions/${session.sessionId}`)).status, 200);
});

test('RL transition mode records illegal attempts without changing game state and counts them toward truncation', async context => {
  const origin = await start(context);
  const created = await request(origin, '/api/rl/sessions', {
    numEnvs: 2, seed: 123, maxEpisodeSteps: 2, invalidActionMode: 'transition',
  });
  assert.equal(created.status, 201);
  const initial = created.body;
  assert.equal(initial.invalidActionMode, 'transition');
  const path = `/api/rl/sessions/${initial.sessionId}`;
  const initialActions = firstActions(initial);
  const first = await request(origin, `${path}/step`, { version: initial.version, actions: initialActions });
  assert.equal(first.status, 200);
  assert.ok(first.body.results.every(result => result.info.actionValid === true));
  const before = (await request(origin, `${path}/envs/1`)).body;
  assert.equal(first.body.results[1].actionMask[initialActions[1]], 0);
  // Reusing a consumed tray slot is a well-formed but illegal action.
  const mixed = await request(origin, `${path}/step`, {
    version: first.body.version, actions: [firstActions(first.body)[0], initialActions[1]],
  });
  assert.equal(mixed.status, 200);
  const valid = mixed.body.results[0], invalid = mixed.body.results[1];
  assert.equal(valid.info.actionValid, true);
  assert.equal(valid.observation.moves, 2);
  assert.ok(valid.reward > 0);
  assert.equal(valid.info.scoreDelta, valid.reward);
  assert.equal(invalid.info.actionValid, false);
  assert.equal(invalid.info.invalidActionReason, 'illegal_placement');
  assert.equal(invalid.reward, 0);
  assert.equal(invalid.info.scoreDelta, 0);
  assert.equal(invalid.info.episodeSteps, 2);
  assert.equal(invalid.observation.moves, 1);
  assert.equal(invalid.version, first.body.results[1].version + 1);
  assert.deepEqual(invalid.observation, first.body.results[1].observation);
  assert.deepEqual(invalid.actionMask, first.body.results[1].actionMask);
  assert.equal(invalid.truncated, true);
  assert.equal(invalid.terminated, false);
  const after = (await request(origin, `${path}/envs/1`)).body;
  assert.deepEqual(after.state, before.state); // Includes raw score, tray and internal RNG state.
  const done = await request(origin, `${path}/step`, {
    version: mixed.body.version, actions: [null, initialActions[1]],
  });
  assert.equal(done.status, 422);
  assert.equal(done.body.error.code, 'RL_ENV_DONE');
  const skipped = await request(origin, `${path}/step`, { version: mixed.body.version, actions: [null, null] });
  assert.equal(skipped.status, 200);
  assert.ok(skipped.body.results.every(result => result.info.actionValid === null));
  assert.equal(skipped.body.results[1].info.episodeSteps, 2);
});
