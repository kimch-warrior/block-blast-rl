import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createApplication } from '../server/index.mjs';
import { createGame } from '../public/game/engine.js';

const tempRoot = resolve('outputs/rl-history-http-tests');

async function fixture(context) {
  await mkdir(tempRoot, { recursive: true });
  const dataDir = await mkdtemp(`${tempRoot}/run-`);
  let app, origin;
  async function start() {
    app = createApplication({ dataDir, rlOptions: { workerCount: 2 } });
    await new Promise((done, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', done);
    });
    origin = `http://127.0.0.1:${app.server.address().port}`;
  }
  context.after(async () => {
    await app?.close();
    const absolute = resolve(dataDir);
    assert.equal(dirname(absolute), tempRoot);
    assert.ok(basename(absolute).startsWith('run-'));
    await rm(absolute, { recursive: true, force: true });
  });
  await start();
  return {
    dataDir,
    async restart() { await app.close(); await start(); },
    async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(origin + path, {
        method, signal: AbortSignal.timeout(20_000),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
  };
}
const livePath = session => `/api/rl/sessions/${session.sessionId}`;
const historyPath = (session, gameId) => `/api/rl/history/sessions/${session.sessionId}/games${gameId ? `/${gameId}` : ''}`;
const firstAction = result => result.actionMask.findIndex(Boolean);
async function ok(promise, status = 200) {
  const response = await promise;
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
}

test('backend creates durable game identities and records applied actions, not skips or policy observations', async context => {
  const f = await fixture(context);
  const normal = await ok(f.request('/api/games', { seed: 123 }), 201);
  const policyMetadata = { name: 'ppo', version: 'v1', weights: { checkpoint: 'policy.pt', sha256: 'test-checkpoint' }, experimentTags: ['test'] };
  let session = await ok(f.request('/api/rl/sessions', { numEnvs: 2, seed: 19, policyMetadata, requestId: randomUUID() }), 201);
  const original = structuredClone(session);
  assert.equal(new Set(session.results.map(result => result.gameId)).size, 2);
  for (const result of session.results) {
    assert.match(result.gameId, /^[a-f0-9-]{36}$/);
    for (const privateField of ['gameId', 'baseSeed', 'initialGameSeed', 'initialState', 'policyMetadata']) {
      assert.equal(Object.hasOwn(result.observation, privateField), false);
    }
  }
  const gameId = session.results[0].gameId;
  const header = await ok(f.request(historyPath(session, gameId)));
  assert.equal(header.schemaVersion, 1);
  assert.equal(header.baseSeed, 19);
  assert.deepEqual(header.policyMetadata, policyMetadata);
  assert.deepEqual(header.initialState, createGame(header.initialGameSeed));
  const viewer = await ok(f.request(`${livePath(session)}/envs/0`));
  assert.equal(viewer.gameId, gameId);
  assert.equal(viewer.id, `${session.sessionId}-0`);
  assert.notEqual(viewer.id, gameId);

  const action = firstAction(session.results[0]);
  const slot = Math.floor(action / 64);
  const requestId = randomUUID();
  session = await ok(f.request(`${livePath(session)}/step`, { version: session.version, actions: [action, null], requestId }));
  assert.equal(session.results[0].gameId, gameId);
  const steps = await ok(f.request(`${historyPath(session, gameId)}/steps`));
  assert.equal(steps.total, 1);
  assert.equal(steps.items[0].step, 0);
  assert.equal(steps.items[0].requestId, requestId);
  assert.equal(steps.items[0].slot, slot);
  assert.equal(steps.items[0].blockId, original.results[0].observation.tray[slot]);
  assert.equal(steps.items[0].x, action % 8);
  assert.equal(steps.items[0].y, Math.floor((action % 64) / 8));
  assert.equal(steps.items[0].scoreDelta, session.results[0].reward);
  assert.equal(steps.items[0].scoreAfter, session.results[0].observation.score);
  assert.deepEqual(steps.items[0].trayAfter, session.results[0].observation.tray);
  assert.equal((await ok(f.request(`${historyPath(session, session.results[1].gameId)}/steps`))).total, 0);

  session = await ok(f.request(`${livePath(session)}/reset`, { version: session.version, envIds: [0], seed: 73, requestId: randomUUID() }));
  assert.notEqual(session.results[0].gameId, gameId);
  assert.equal(session.results[1].gameId, original.results[1].gameId);
  assert.equal((await ok(f.request(historyPath(session, gameId)))).endReason, 'manual_reset');
  const replacement = await ok(f.request(historyPath(session, session.results[0].gameId)));
  assert.equal(replacement.baseSeed, 19);
  assert.equal(replacement.gameBaseSeed, 73);
  assert.deepEqual(replacement.initialState, createGame(replacement.initialGameSeed));
  assert.deepEqual(await ok(f.request('/api/state')), normal);
});

test('explicit seed resets retain the exact generation seed and replay full board, score, combo and refills', async context => {
  const f = await fixture(context);
  let session = await ok(f.request('/api/rl/sessions', { numEnvs: 1, seed: 29 }), 201);
  for (let i = 0; i < 3; i++) {
    session = await ok(f.request(`${livePath(session)}/reset`, { version: session.version, requestId: randomUUID() }));
  }
  session = await ok(f.request(`${livePath(session)}/reset`, { version: session.version, seed: 101, requestId: randomUUID() }));
  const gameId = session.results[0].gameId;
  const initial = await ok(f.request(historyPath(session, gameId)));
  assert.ok(initial.episodeId > 0);
  assert.equal(initial.gameBaseSeed, 101);
  assert.deepEqual(initial.initialState, createGame(initial.initialGameSeed));
  for (let i = 0; i < 6 && !session.results[0].terminated; i++) {
    session = await ok(f.request(`${livePath(session)}/step`, { version: session.version, actions: [firstAction(session.results[0])], requestId: randomUUID() }));
  }
  const final = await ok(f.request(`${livePath(session)}/envs/0`));
  const replay = await ok(f.request(`${historyPath(session, gameId)}/replay`));
  assert.equal(replay.valid, true);
  assert.deepEqual(replay.state, final.state);
  assert.ok(replay.attemptCount >= 3);
  const steps = await ok(f.request(`${historyPath(session, gameId)}/steps?limit=100&offset=0`));
  assert.ok(steps.items.some(step => step.refilled));
  session = await ok(f.request(`${livePath(session)}/reset`, { version: session.version, requestId: randomUUID() }));
  const closed = await ok(f.request(historyPath(session, gameId)));
  assert.deepEqual(closed.finalState, final.state);
  assert.deepEqual((await ok(f.request(`${historyPath(session, gameId)}/replay`))).state, final.state);
  const fileBase = resolve(f.dataDir, 'records', 'sessions', session.sessionId, 'games', gameId);
  const jsonl = (await readFile(`${fileBase}.jsonl`, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(jsonl[0].type, 'header');
  assert.equal(jsonl[0].initialGameSeed, initial.initialGameSeed);
  assert.equal(jsonl.filter(event => event.type === 'step').length, steps.total);
  assert.equal(jsonl.at(-1).type, 'end');
  const document = JSON.parse(await readFile(`${fileBase}.json`, 'utf8'));
  assert.equal(document.gameId, gameId);
  assert.equal(document.steps.length, steps.total);
});

test('request IDs deduplicate concurrent and stale retries through reset, deletion and server restart', async context => {
  const f = await fixture(context);
  const create = { numEnvs: 1, seed: 17, requestId: 'create-retry' };
  const creations = await Promise.all([f.request('/api/rl/sessions', create), f.request('/api/rl/sessions', create)]);
  assert.ok(creations.every(response => response.status === 201));
  assert.deepEqual(creations[0].body, creations[1].body);
  let session = creations[0].body;
  const gameId = session.results[0].gameId;
  const command = { version: session.version, actions: [firstAction(session.results[0])], requestId: 'step-retry' };
  const responses = await Promise.all([f.request(`${livePath(session)}/step`, command), f.request(`${livePath(session)}/step`, command)]);
  assert.ok(responses.every(response => response.status === 200));
  assert.deepEqual(responses[0].body, responses[1].body);
  const firstResponse = responses[0].body;
  session = await ok(f.request(`${livePath(session)}/step`, { version: firstResponse.version, actions: [firstAction(firstResponse.results[0])], requestId: 'second-step' }));
  assert.deepEqual(await ok(f.request(`${livePath(session)}/step`, command)), firstResponse);
  const conflict = await f.request(`${livePath(session)}/step`, { ...command, actions: [command.actions[0] === 0 ? 1 : 0] });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'REQUEST_ID_CONFLICT');
  assert.equal((await ok(f.request(`${historyPath(session, gameId)}/steps`))).total, 2);
  const reset = { version: session.version, seed: 73, requestId: 'reset-retry' };
  session = await ok(f.request(`${livePath(session)}/reset`, reset));
  assert.deepEqual(await ok(f.request(`${livePath(session)}/reset`, reset)), session);
  assert.equal((await ok(f.request(historyPath(session)))).total, 2);
  await ok(f.request(livePath(session), undefined, 'DELETE'));
  assert.deepEqual(await ok(f.request(`${livePath(session)}/step`, command)), firstResponse);
  await f.restart();
  assert.equal((await f.request(livePath(session))).status, 404);
  assert.deepEqual(await ok(f.request(`${livePath(session)}/step`, command)), firstResponse);
  assert.deepEqual(await ok(f.request('/api/rl/sessions', create), 201), creations[0].body);
  assert.equal((await ok(f.request(`${historyPath(session, gameId)}/steps`))).total, 2);
  assert.equal((await ok(f.request('/api/rl/stats'))).totalEnvs, 0);
});

test('recording separates rejected actions, skips, invalid transitions and terminal end reasons', async context => {
  const f = await fixture(context);
  let rejected = await ok(f.request('/api/rl/sessions', { numEnvs: 1, seed: 2 }), 201);
  const rejectedGame = rejected.results[0].gameId;
  const bad = rejected.results[0].actionMask.findIndex(value => value === 0);
  assert.equal((await f.request(`${livePath(rejected)}/step`, { version: rejected.version, actions: [bad], requestId: 'rejected-action' })).status, 422);
  rejected = await ok(f.request(`${livePath(rejected)}/step`, { version: rejected.version, actions: [null], requestId: 'skipped-action' }));
  assert.equal((await ok(f.request(`${historyPath(rejected, rejectedGame)}/steps`))).total, 0);
  let transition = await ok(f.request('/api/rl/sessions', { numEnvs: 1, seed: 3, maxEpisodeSteps: 2, invalidActionMode: 'transition' }), 201);
  const transitionGame = transition.results[0].gameId;
  transition = await ok(f.request(`${livePath(transition)}/step`, { version: transition.version, actions: [transition.results[0].actionMask.findIndex(value => value === 0)], requestId: 'invalid-transition' }));
  assert.equal(transition.results[0].observation.moves, 0);
  assert.equal(transition.results[0].info.actionValid, false);
  transition = await ok(f.request(`${livePath(transition)}/step`, { version: transition.version, actions: [firstAction(transition.results[0])], requestId: 'valid-transition' }));
  assert.equal(transition.results[0].truncated, true);
  const metadata = await ok(f.request(historyPath(transition, transitionGame)));
  assert.equal(metadata.attemptCount, 2);
  assert.equal(metadata.placementCount, 1);
  assert.equal(metadata.endReason, 'max_episode_steps');
  const replay = await ok(f.request(`${historyPath(transition, transitionGame)}/replay`));
  assert.equal(replay.attemptCount, 2);
  assert.equal(replay.placementCount, 1);
  assert.equal(replay.truncated, true);
  await ok(f.request(livePath(transition), undefined, 'DELETE'));
  assert.equal((await ok(f.request(historyPath(transition, transitionGame)))).endReason, 'max_episode_steps');
  await ok(f.request(livePath(rejected), undefined, 'DELETE'));
  assert.equal((await ok(f.request(historyPath(rejected, rejectedGame)))).endReason, 'session_closed');
});

test('restart preserves interrupted games and history pagination and OpenAPI remain independent of live sessions', async context => {
  const f = await fixture(context);
  let session = await ok(f.request('/api/rl/sessions', { numEnvs: 2, seed: 11 }), 201);
  const gameId = session.results[0].gameId;
  session = await ok(f.request(`${livePath(session)}/step`, { version: session.version, actions: [firstAction(session.results[0]), null], requestId: randomUUID() }));
  const expected = (await ok(f.request(`${livePath(session)}/envs/0`))).state;
  await f.restart();
  assert.equal((await f.request(livePath(session))).status, 404);
  const metadata = await ok(f.request(historyPath(session, gameId)));
  assert.equal(metadata.endReason, 'interrupted');
  assert.deepEqual(metadata.finalState, expected);
  assert.deepEqual((await ok(f.request(`${historyPath(session, gameId)}/replay`))).state, expected);
  const sessions = await ok(f.request('/api/rl/history/sessions?limit=1&offset=0'));
  assert.equal(sessions.total, 1);
  assert.equal(sessions.items[0].sessionId, session.sessionId);
  const games = await ok(f.request(`${historyPath(session)}?limit=1&offset=0`));
  assert.equal(games.total, 2);
  assert.equal(games.items.length, 1);
  assert.equal(games.hasMore, true);
  const rest = await ok(f.request(`${historyPath(session)}?limit=1&offset=1`));
  assert.notEqual(rest.items[0].gameId, games.items[0].gameId);
  const steps = await ok(f.request(`${historyPath(session, gameId)}/steps?limit=1&offset=1`));
  assert.equal(steps.total, 1);
  assert.equal(steps.items.length, 0);
  for (const query of ['limit=0', 'limit=1001', 'offset=-1', 'offset=1.5']) {
    assert.equal((await f.request(`/api/rl/history/sessions?${query}`)).status, 400);
  }
  const openapi = await ok(f.request('/api/openapi.json'));
  assert.ok(openapi.paths['/api/rl/history/sessions/{sessionId}/games/{gameId}/replay']);
  const listedGame = openapi.paths['/api/rl/history/sessions/{sessionId}/games'].get.responses[200].content['application/json'].schema.properties.items.items;
  assert.equal(listedGame.$ref, '#/components/schemas/RlRecordedGameSummary');
  assert.ok(openapi.components.schemas.RlRecordedGameSummary.required.includes('score'));
  assert.equal(Object.hasOwn(games.items[0], 'initialState'), false);
  assert.ok(openapi.components.schemas.RlResult.required.includes('gameId'));
  assert.ok(openapi.paths['/api/rl/sessions/{sessionId}/step'].post.requestBody.content['application/json'].schema.properties.requestId);
});
