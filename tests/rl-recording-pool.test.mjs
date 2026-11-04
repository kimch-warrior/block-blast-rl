import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { createRlPool } from '../server/rl/pool.mjs';
import { createHistoryStore } from '../server/rl/history-store.mjs';
import { episodeSeed } from '../server/rl/protocol.mjs';
import { createGame } from '../public/game/engine.js';
import { replayGameRecord } from '../server/rl/replay.mjs';

const firstAction = result => result.actionMask.findIndex(Boolean);
const actionsFor = batch => batch.results.map(firstAction);
const errorIs = (status, code) => error => error.status === status && (!code || error.code === code);
const temporaryRoot = resolve('outputs/rl-recording-pool-tests');

async function fixture(context, decorate = history => history) {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(`${temporaryRoot}/run-`);
  const value = { directory, history: createHistoryStore(directory), pool: null };
  value.pool = createRlPool({ workerCount: 2, historyStore: decorate(value.history) });
  context.after(async () => {
    await value.pool.close();
    value.history.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), temporaryRoot);
    assert.ok(basename(absolute).startsWith('run-'));
    await rm(absolute, { recursive: true, force: true });
  });
  return value;
}

test('new game identities and exact generation seeds survive manual resets and session deletion', async context => {
  const { pool, history } = await fixture(context);
  const policyMetadata = { name: 'policy', version: 'v1', weights: { checkpoint: 'model.pt' }, experimentTags: ['test'] };
  let batch = await pool.create({ numEnvs: 2, seed: 71, policyMetadata, requestId: 'create' });
  const original = batch.results.map(result => result.gameId);
  assert.equal(new Set(original).size, 2);
  const header = history.getGame(batch.sessionId, original[0]);
  assert.equal(header.baseSeed, 71);
  assert.equal(header.gameBaseSeed, 71);
  assert.equal(header.initialGameSeed, episodeSeed(71, 0, 0));
  assert.deepEqual(header.initialState, createGame(header.initialGameSeed));
  assert.deepEqual(header.policyMetadata, policyMetadata);
  assert.equal(Object.hasOwn(batch.results[0].observation, 'initialGameSeed'), false);
  assert.equal(Object.hasOwn(batch.results[0].observation, 'seed'), false);
  const placed = await pool.step(batch.sessionId, {
    version: batch.version, requestId: 'first', actions: [firstAction(batch.results[0]), null],
  });
  assert.equal(placed.results[0].gameId, original[0]);
  assert.equal(history.listSteps(batch.sessionId, original[0]).total, 1);
  assert.equal(history.listSteps(batch.sessionId, original[1]).total, 0);
  batch = await pool.reset(batch.sessionId, { version: placed.version, requestId: 'reset-one', envIds: [0] });
  const secondGame = batch.results[0].gameId;
  assert.notEqual(secondGame, original[0]);
  assert.equal(batch.results[1].gameId, original[1]);
  assert.equal(history.getGame(batch.sessionId, original[0]).endReason, 'manual_reset');
  batch = await pool.reset(batch.sessionId, { version: batch.version, requestId: 'reset-explicit', envIds: [0], seed: 123 });
  const explicit = history.getGame(batch.sessionId, batch.results[0].gameId);
  assert.equal(explicit.episodeId, 2);
  assert.equal(explicit.baseSeed, 71);
  assert.equal(explicit.gameBaseSeed, 123);
  assert.equal(explicit.initialGameSeed, episodeSeed(123, 0, 0));
  assert.notEqual(explicit.initialGameSeed, episodeSeed(123, 0, explicit.episodeId));
  assert.deepEqual(explicit.initialState, createGame(explicit.initialGameSeed));
  batch = await pool.step(batch.sessionId, { version: batch.version, requestId: 'explicit-move', actions: actionsFor(batch) });
  const currentId = batch.results[0].gameId;
  const final = await pool.snapshot(batch.sessionId, 0);
  await pool.delete(batch.sessionId);
  assert.equal(history.getGame(batch.sessionId, currentId).endReason, 'session_closed');
  assert.equal(history.getGame(batch.sessionId, secondGame).endReason, 'manual_reset');
  const recorded = history.getGame(batch.sessionId, currentId);
  const replay = replayGameRecord(recorded, history.getStepsForReplay(batch.sessionId, currentId));
  assert.equal(replay.valid, true);
  assert.deepEqual(replay.state, final.state);
});

test('successful request IDs deduplicate concurrent and late retries before version checks', async context => {
  const { pool, history } = await fixture(context);
  const create = { numEnvs: 1, seed: 9, requestId: 'same-create' };
  const [a, b] = await Promise.all([pool.create(create), pool.create({ ...create })]);
  assert.deepEqual(a, b);
  assert.equal(pool.stats().totalEnvs, 1);
  const command = { version: a.version, requestId: 'same-step', actions: actionsFor(a) };
  const [first, retry] = await Promise.all([pool.step(a.sessionId, command), pool.step(a.sessionId, { ...command })]);
  assert.deepEqual(first, retry);
  assert.equal(history.listSteps(a.sessionId, a.results[0].gameId).total, 1);
  await assert.rejects(pool.step(a.sessionId, { ...command, actions: [(command.actions[0] + 1) % 192] }), errorIs(409, 'REQUEST_ID_CONFLICT'));
  const later = await pool.step(a.sessionId, { version: first.version, requestId: 'next-step', actions: actionsFor(first) });
  assert.deepEqual(await pool.step(a.sessionId, command), first);
  assert.equal((await pool.get(a.sessionId)).version, later.version);
  const reset = { version: later.version, requestId: 'same-reset', seed: 21 };
  const [resetA, resetB] = await Promise.all([pool.reset(a.sessionId, reset), pool.reset(a.sessionId, { ...reset })]);
  assert.deepEqual(resetA, resetB);
  assert.notEqual(resetA.results[0].gameId, a.results[0].gameId);
  assert.equal(history.listGames(a.sessionId).total, 2);
  await assert.rejects(pool.step(a.sessionId, { ...command, requestId: 'same-reset' }), errorIs(409, 'REQUEST_ID_CONFLICT'));
  await pool.delete(a.sessionId);
  assert.deepEqual(await pool.step(a.sessionId, command), first);
});

test('only accepted attempts are recorded and attempt limits retain their original ending reason', async context => {
  const { pool, history } = await fixture(context);
  let batch = await pool.create({ numEnvs: 2, invalidActionMode: 'transition', maxEpisodeSteps: 2, requestId: 'create-invalid' });
  const gameId = batch.results[0].gameId;
  const illegal = batch.results[0].actionMask.findIndex(value => value === 0);
  batch = await pool.step(batch.sessionId, { version: batch.version, requestId: 'invalid', actions: [illegal, null] });
  let steps = history.listSteps(batch.sessionId, gameId).items;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step, 0);
  assert.equal(steps[0].requestId, 'invalid');
  assert.equal(steps[0].actionValid, false);
  assert.equal(steps[0].scoreDelta, 0);
  assert.equal(steps[0].blockId, history.getGame(batch.sessionId, gameId).initialState.tray[steps[0].slot]);
  batch = await pool.step(batch.sessionId, { version: batch.version, requestId: 'valid', actions: [firstAction(batch.results[0]), null] });
  const ended = history.getGame(batch.sessionId, gameId);
  assert.equal(ended.endReason, 'max_episode_steps');
  assert.equal(ended.attemptCount, 2);
  assert.equal(ended.placementCount, 1);
  assert.equal(history.listSteps(batch.sessionId, batch.results[1].gameId).total, 0);
  assert.deepEqual(replayGameRecord(ended, history.getStepsForReplay(batch.sessionId, gameId)).state, ended.finalState);
  batch = await pool.reset(batch.sessionId, { version: batch.version, envIds: [0] });
  assert.equal(history.getGame(batch.sessionId, gameId).endReason, 'max_episode_steps');
  const strict = await pool.create({ numEnvs: 1 });
  const invalid = strict.results[0].actionMask.findIndex(value => value === 0);
  await assert.rejects(pool.step(strict.sessionId, { version: strict.version, requestId: 'rejected', actions: [invalid] }), errorIs(422, 'ILLEGAL_ACTION'));
  assert.equal(history.listSteps(strict.sessionId, strict.results[0].gameId).total, 0);
});

test('records and successful request responses survive pool/store reopening without resuming execution', async context => {
  const h = await fixture(context);
  const create = { numEnvs: 1, seed: 33, requestId: 'durable-create' };
  const initial = await h.pool.create(create);
  const command = { version: initial.version, requestId: 'durable-step', actions: actionsFor(initial) };
  const placed = await h.pool.step(initial.sessionId, command);
  await h.pool.close();
  h.history.close();
  h.history = createHistoryStore(h.directory);
  h.pool = createRlPool({ workerCount: 2, historyStore: h.history });
  const record = h.history.getGame(initial.sessionId, initial.results[0].gameId);
  assert.equal(record.endReason, 'interrupted');
  assert.equal(record.attemptCount, 1);
  assert.deepEqual(await h.pool.step(initial.sessionId, command), placed);
  assert.deepEqual(await h.pool.create(create), initial);
  assert.equal(h.pool.stats().totalEnvs, 0);
  await assert.rejects(h.pool.get(initial.sessionId), errorIs(404, 'RL_SESSION_NOT_FOUND'));
});

test('a complete game records refills and clears, replays its final state and keeps its game-over reason', async context => {
  const { pool, history } = await fixture(context);
  let batch = await pool.create({ numEnvs: 1, seed: 123, maxEpisodeSteps: 1000 });
  const gameId = batch.results[0].gameId;
  while (!batch.results[0].terminated && !batch.results[0].truncated) {
    const result = batch.results[0], legal = [];
    result.actionMask.forEach((allowed, action) => { if (allowed) legal.push(action); });
    const action = legal[(result.observation.moves * 7919 + 17) % legal.length];
    batch = await pool.step(batch.sessionId, { version: batch.version, actions: [action] });
  }
  assert.equal(batch.results[0].terminated, true);
  const record = history.getGame(batch.sessionId, gameId);
  const steps = history.getStepsForReplay(batch.sessionId, gameId);
  assert.equal(record.endReason, 'game_over');
  assert.ok(steps.some(step => step.refilled));
  assert.ok(steps.some(step => step.clearedRows.length || step.clearedCols.length));
  assert.deepEqual(replayGameRecord(record, steps).state, record.finalState);
  assert.equal(record.finalState.score, batch.results[0].observation.score);
  assert.equal(record.finalState.combo, batch.results[0].observation.combo);
  const reset = await pool.reset(batch.sessionId, { version: batch.version });
  assert.notEqual(reset.results[0].gameId, gameId);
  assert.equal(history.getGame(batch.sessionId, gameId).endReason, 'game_over');
});

test('a recording failure never publishes the applied worker state or inserts the failed action', async context => {
  let failCommit = false;
  const h = await fixture(context, history => ({
    lookupRequest: history.lookupRequest,
    commit(batch) {
      if (failCommit && batch.steps.length) throw new Error('Injected disk failure');
      return history.commit(batch);
    },
    closeSession: history.closeSession,
  }));
  let batch = await h.pool.create({ numEnvs: 2 });
  batch = await h.pool.step(batch.sessionId, { version: batch.version, requestId: 'accepted-before-failure', actions: actionsFor(batch) });
  const old = batch;
  failCommit = true;
  await assert.rejects(h.pool.step(batch.sessionId, { version: batch.version, requestId: 'failed-save', actions: actionsFor(batch) }), errorIs(503, 'RL_RECORDING_FAILED'));
  await h.pool.drainRecording();
  await assert.rejects(h.pool.get(batch.sessionId), errorIs(404));
  for (const result of old.results) {
    const record = h.history.getGame(old.sessionId, result.gameId);
    assert.equal(record.attemptCount, 1);
    assert.equal(record.endReason, 'interrupted');
    assert.equal(record.finalState.moves, 1);
    assert.equal(h.history.listSteps(old.sessionId, result.gameId).total, 1);
  }
});

test('viewer state remains committed while a durable write is pending', async context => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const h = await fixture(context, history => ({
    lookupRequest: history.lookupRequest,
    async commit(batch) {
      if (batch.steps.length) { entered(); await gate; }
      return history.commit(batch);
    },
    closeSession: history.closeSession,
  }));
  context.after(() => release());
  const initial = await h.pool.create({ numEnvs: 1 });
  const advancing = h.pool.step(initial.sessionId, { version: initial.version, requestId: 'pending-save', actions: actionsFor(initial) });
  await waiting;
  assert.equal((await h.pool.snapshot(initial.sessionId, 0)).state.moves, 0);
  assert.equal((await h.pool.get(initial.sessionId)).version, initial.version);
  assert.equal(h.history.listSteps(initial.sessionId, initial.results[0].gameId).total, 0);
  release();
  const next = await advancing;
  assert.equal(next.results[0].observation.moves, 1);
  assert.equal((await h.pool.snapshot(initial.sessionId, 0)).state.moves, 1);
});

test('partial worker failure preserves prior records and does not record the rejected batch', async context => {
  const OriginalWorker = workerThreads.Worker, captured = [];
  workerThreads.Worker = class extends OriginalWorker {
    constructor(...args) { super(...args); captured.push(this); }
  };
  syncBuiltinESMExports();
  context.after(() => { workerThreads.Worker = OriginalWorker; syncBuiltinESMExports(); });
  const { pool, history } = await fixture(context);
  const initial = await pool.create({ numEnvs: 3 });
  const unaffected = await pool.create({ numEnvs: 1 });
  const terminating = captured[0].terminate();
  const advancing = pool.step(initial.sessionId, { version: initial.version, requestId: 'worker-failure', actions: actionsFor(initial) });
  await assert.rejects(advancing, errorIs(503, 'RL_WORKER_FAILED'));
  await terminating;
  await pool.drainRecording();
  for (const result of initial.results) {
    assert.equal(history.listSteps(initial.sessionId, result.gameId).total, 0);
    assert.equal(history.getGame(initial.sessionId, result.gameId).endReason, 'interrupted');
  }
  assert.equal((await pool.get(unaffected.sessionId)).results[0].gameId, unaffected.results[0].gameId);
  assert.equal(history.getGame(unaffected.sessionId, unaffected.results[0].gameId).endReason, null);
});

test('a worker failure during a delayed recording adapter cannot commit the acknowledged worker computation', async context => {
  const OriginalWorker = workerThreads.Worker, captured = [];
  workerThreads.Worker = class extends OriginalWorker {
    constructor(...args) { super(...args); captured.push(this); }
  };
  syncBuiltinESMExports();
  context.after(() => { workerThreads.Worker = OriginalWorker; syncBuiltinESMExports(); });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const h = await fixture(context, history => ({
    lookupRequest: history.lookupRequest,
    async commit(batch) {
      if (batch.steps.length) { entered(); await gate; }
      return history.commit(batch);
    },
    closeSession: history.closeSession,
  }));
  context.after(() => release());
  const initial = await h.pool.create({ numEnvs: 2 });
  const advancing = h.pool.step(initial.sessionId, { version: initial.version, requestId: 'failed-during-save', actions: actionsFor(initial) });
  const rejected = assert.rejects(advancing, errorIs(503, 'RL_WORKER_FAILED'));
  await waiting;
  // All computations returned, but the batch is not yet durable or visible.
  assert.equal((await h.pool.snapshot(initial.sessionId, 0)).state.moves, 0);
  await captured[0].terminate();
  release();
  await rejected;
  await h.pool.drainRecording();
  for (const result of initial.results) {
    assert.equal(h.history.listSteps(initial.sessionId, result.gameId).total, 0);
    assert.equal(h.history.getGame(initial.sessionId, result.gameId).endReason, 'interrupted');
  }
  assert.equal(h.history.lookupRequest(initial.sessionId, 'failed-during-save', 'any-fingerprint'), null);
});
