import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createGame, place, placements } from '../public/game/engine.js';
import { createHistoryStore } from '../server/rl/history-store.mjs';
import { replayGameRecord, replayStoredGame } from '../server/rl/replay.mjs';
import { episodeSeed, rulesVersions } from '../server/rl/protocol.mjs';

const testRoot = resolve('outputs/history-store-tests');
const errorIs = (status, code) => error => error.status === status && error.code === code;
function fixture(context) {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(join(testRoot, 'run-'));
  let store = createHistoryStore(directory);
  context.after(() => {
    store.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), testRoot);
    assert.ok(basename(absolute).startsWith('run-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  return { directory, get store() { return store; }, reopen() { store.close(); store = createHistoryStore(directory); return store; } };
}
function session(sessionId = 'session-a', overrides = {}) {
  return { sessionId, baseSeed: 17, numEnvs: 1, maxEpisodeSteps: 100, invalidActionMode: 'transition',
    policyMetadata: { name: 'policy', version: 'v1', weights: { sha256: 'example' }, experimentTags: ['test'] },
    startedAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', version: 1,
    status: 'in_progress', ...overrides };
}
function header(owner, gameId = 'game-a', overrides = {}) {
  const initialGameSeed = overrides.initialGameSeed ?? episodeSeed(owner.baseSeed, 0, 0);
  return { schemaVersion: 1, sessionId: owner.sessionId, gameId, envId: 0, episodeId: 0,
    baseSeed: owner.baseSeed, gameBaseSeed: owner.baseSeed, initialGameSeed,
    initialState: createGame(initialGameSeed), ...rulesVersions,
    execution: { maxEpisodeSteps: owner.maxEpisodeSteps, invalidActionMode: owner.invalidActionMode },
    policyMetadata: owner.policyMetadata, startedAt: owner.startedAt, ...overrides };
}
function actionFor(state) {
  for (let slot = 0; slot < 3; slot++) {
    const position = placements(state.board, state.tray[slot])[0];
    if (position) return slot * 64 + position.row * 8 + position.col;
  }
  throw new Error('No action available');
}
function transition(game, state, step, action = actionFor(state), requestId = `request-${step}`) {
  const slot = Math.floor(action / 64), y = Math.floor((action % 64) / 8), x = action % 8;
  const move = place(state, slot, y, x), stateAfter = move?.state ?? structuredClone(state);
  return { sessionId: game.sessionId, gameId: game.gameId, envId: game.envId, episodeId: game.episodeId,
    step, requestId, action, slot, blockId: state.tray[slot], x, y, actionValid: Boolean(move),
    scoreDelta: move?.points ?? 0, scoreAfter: stateAfter.score, comboAfter: stateAfter.combo,
    clearedRows: move?.clearedRows ?? [], clearedCols: move?.clearedCols ?? [], refilled: move?.refilled ?? false,
    trayAfter: stateAfter.tray, colorsAfter: stateAfter.colors,
    scoreBreakdown: move?.scoreBreakdown ?? { placement: 0, elimination: 0, allClear: 0 }, stateAfter };
}
const gameFile = (directory, owner, game, extension) => join(directory, 'sessions', owner.sessionId, 'games', game.gameId + extension);

test('durable headers, request responses and completed JSON/JSONL replay exact explicit reset seeds', context => {
  const f = fixture(context), owner = session('explicit-seed', { maxEpisodeSteps: 4 });
  // Logical episode 37 deliberately uses derivation episode 0 after reset(seed).
  const initialGameSeed = episodeSeed(456, 0, 0);
  const game = header(owner, 'game-reset-37', { episodeId: 37, gameBaseSeed: 456, initialGameSeed, initialState: createGame(initialGameSeed) });
  f.store.commit({ session: owner, starts: [game], request: { scope: '$create', requestId: 'create', fingerprint: 'create-v1', response: { sessionId: owner.sessionId } } });
  let state = game.initialState, placementsMade = 0, firstAction;
  for (let step = 0; step < 4; step++) {
    const action = step === 1 ? firstAction : actionFor(state);
    firstAction ??= action;
    const event = transition(game, state, step, action);
    placementsMade += Number(event.actionValid);
    const ends = step === 3 ? [{ sessionId: owner.sessionId, gameId: game.gameId, endReason: 'max_episode_steps',
      endedAt: '2026-11-05T00:00:01.000Z', finalState: event.stateAfter, attemptCount: 4, placementCount: placementsMade, terminated: false, truncated: true }] : [];
    f.store.commit({ steps: [event], ends, request: { scope: owner.sessionId, requestId: event.requestId, fingerprint: `fingerprint-${step}`, response: { version: step + 2 } } });
    state = event.stateAfter;
  }
  assert.equal(placementsMade, 3);
  const saved = f.store.getGame(owner.sessionId, game.gameId);
  assert.equal(saved.initialGameSeed, initialGameSeed);
  assert.equal(saved.baseSeed, 17);
  assert.equal(saved.episodeId, 37);
  assert.equal(saved.status, 'finished');
  assert.equal(saved.endReason, 'max_episode_steps');
  assert.equal(saved.attemptCount, 4);
  assert.equal(saved.placementCount, 3);
  const records = f.store.getStepsForReplay(owner.sessionId, game.gameId);
  assert.equal(records[1].actionValid, false);
  assert.equal(records[1].blockId, -1);
  assert.equal(Object.hasOwn(records[0], 'stateAfter'), false);
  assert.match(records[0].stateHashAfter, /^[a-f0-9]{64}$/);
  assert.deepEqual(replayGameRecord(saved, records).state, state);
  assert.deepEqual(replayStoredGame(f.directory, owner.sessionId, game.gameId).state, state);
  const jsonl = readFileSync(gameFile(f.directory, owner, game, '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(jsonl.map(line => line.type), ['header', 'step', 'step', 'step', 'step', 'end']);
  const document = JSON.parse(readFileSync(gameFile(f.directory, owner, game, '.json'), 'utf8'));
  assert.equal(document.steps.length, 4);
  assert.deepEqual(document.finalState, state);
  assert.deepEqual(f.store.lookupRequest(owner.sessionId, 'request-3', 'fingerprint-3'), { version: 5 });
  assert.throws(() => f.store.lookupRequest(owner.sessionId, 'request-3', 'different'), errorIs(409, 'REQUEST_ID_CONFLICT'));
  f.reopen();
  assert.equal(f.store.getGame(owner.sessionId, game.gameId).endReason, 'max_episode_steps');
  assert.deepEqual(f.store.lookupRequest(owner.sessionId, 'request-3', 'fingerprint-3'), { version: 5 });
});

test('request replay cannot duplicate a transition and reset keeps the older game addressable', context => {
  const f = fixture(context), owner = session(), old = header(owner);
  f.store.commit({ session: owner, starts: [old] });
  const event = transition(old, old.initialState, 0);
  const request = { scope: owner.sessionId, requestId: event.requestId, fingerprint: 'one-action', response: { result: 'accepted' } };
  f.store.commit({ steps: [event], request });
  assert.deepEqual(f.store.commit({ steps: [event], request }), request.response);
  assert.equal(f.store.listSteps(owner.sessionId, old.gameId).total, 1);
  const fresh = header(owner, 'game-b', { episodeId: 1, startedAt: '2026-11-05T00:01:00.000Z' });
  f.store.commit({ starts: [fresh], ends: [{ sessionId: owner.sessionId, gameId: old.gameId,
    endedAt: fresh.startedAt, endReason: 'manual_reset', finalState: event.stateAfter,
    attemptCount: 1, placementCount: 1, terminated: false, truncated: false }] });
  f.store.closeSession(owner.sessionId);
  assert.equal(f.store.getGame(owner.sessionId, old.gameId).endReason, 'manual_reset');
  assert.equal(f.store.getGame(owner.sessionId, fresh.gameId).endReason, 'session_closed');
  assert.equal(f.store.listGames(owner.sessionId).total, 2);
  assert.equal(f.store.listSteps(owner.sessionId, old.gameId).total, 1);
});

test('startup repairs uncommitted export tails and closes only in-progress games as interrupted', context => {
  const f = fixture(context), owner = session(), game = header(owner);
  f.store.commit({ session: owner, starts: [game] });
  const event = transition(game, game.initialState, 0);
  f.store.commit({ steps: [event], request: { scope: owner.sessionId, requestId: 'saved', fingerprint: 'saved', response: { accepted: true } } });
  appendFileSync(gameFile(f.directory, owner, game, '.jsonl'), '{"type":"step","step":999}\n');
  writeFileSync(gameFile(f.directory, owner, game, '.json'), '{"uncommitted":true}');
  const manifest = { sessionIds: [owner.sessionId], games: [{ sessionId: owner.sessionId, gameId: game.gameId }] };
  writeFileSync(join(f.directory, '.pending', `${randomUUID()}.json`), JSON.stringify(manifest));
  f.reopen();
  const saved = f.store.getGame(owner.sessionId, game.gameId);
  assert.equal(saved.endReason, 'interrupted');
  assert.equal(saved.attemptCount, 1);
  assert.deepEqual(saved.finalState, event.stateAfter);
  const jsonl = readFileSync(gameFile(f.directory, owner, game, '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(jsonl.map(line => line.type), ['header', 'step', 'end']);
  assert.equal(jsonl[1].step, 0);
  assert.equal(readdirSync(join(f.directory, '.pending')).length, 0);
  assert.deepEqual(f.store.lookupRequest(owner.sessionId, 'saved', 'saved'), { accepted: true });
  assert.equal(replayStoredGame(f.directory, owner.sessionId, game.gameId).valid, true);
});

test('a failed export rolls back all games and request responses, including an already-appended file', context => {
  const f = fixture(context), owner = session(), first = header(owner, 'first'), second = header(owner, 'second', { envId: 1 });
  f.store.commit({ session: owner, starts: [first, second] });
  const blocked = gameFile(f.directory, owner, second, '.jsonl');
  unlinkSync(blocked);
  mkdirSync(blocked); // A deterministic write error, confined to this test.
  const events = [transition(first, first.initialState, 0), transition(second, second.initialState, 0)];
  assert.throws(() => f.store.commit({ steps: events,
    request: { scope: owner.sessionId, requestId: 'failed', fingerprint: 'failed', response: { accepted: true } } }), errorIs(503, 'RL_RECORDING_FAILED'));
  assert.equal(f.store.listSteps(owner.sessionId, first.gameId).total, 0);
  assert.equal(f.store.listSteps(owner.sessionId, second.gameId).total, 0);
  assert.equal(f.store.lookupRequest(owner.sessionId, 'failed', 'failed'), null);
  assert.equal(readFileSync(gameFile(f.directory, owner, first, '.jsonl'), 'utf8').trim().split('\n').length, 1);
  rmdirSync(blocked);
  f.reopen();
  assert.equal(f.store.getGame(owner.sessionId, first.gameId).endReason, 'interrupted');
  assert.equal(f.store.getGame(owner.sessionId, first.gameId).attemptCount, 0);
  assert.equal(f.store.getGame(owner.sessionId, second.gameId).attemptCount, 0);
});

test('history lists paginate and a second writer cannot interrupt a live store', context => {
  const f = fixture(context), a = session('session-a'), b = session('session-b', { startedAt: '2026-11-05T01:00:00.000Z' });
  f.store.commit({ session: a, starts: [header(a, 'first'), header(a, 'second', { envId: 1 })] });
  f.store.commit({ session: b, starts: [header(b, 'third')] });
  assert.throws(() => createHistoryStore(f.directory), errorIs(503, 'RL_RECORDING_IN_USE'));
  assert.equal(f.store.health(), true);
  const sessions = f.store.listSessions({ limit: 1 });
  assert.equal(sessions.total, 2);
  assert.equal(sessions.items[0].sessionId, b.sessionId);
  assert.equal(sessions.hasMore, true);
  assert.equal(f.store.listSessions({ limit: 1, offset: 1 }).items[0].sessionId, a.sessionId);
  const games = f.store.listGames(a.sessionId, { limit: 1 });
  assert.equal(games.total, 2);
  assert.equal(games.hasMore, true);
  assert.equal(f.store.listGames(a.sessionId, { limit: 1, offset: 1 }).items.length, 1);
  assert.throws(() => f.store.listGames('missing'), errorIs(404, 'RL_HISTORY_SESSION_NOT_FOUND'));
  assert.throws(() => f.store.getGame(a.sessionId, 'missing'), errorIs(404, 'RL_HISTORY_GAME_NOT_FOUND'));
  assert.throws(() => f.store.listGames('../outside'), errorIs(400, 'INVALID_HISTORY_ID'));
  for (const options of [{ limit: 0 }, { limit: 1001 }, { offset: -1 }, { offset: 1.5 }]) {
    assert.throws(() => f.store.listSessions(options), errorIs(400, 'INVALID_PAGINATION'));
  }
});

test('post-COMMIT marker cleanup failure cannot reject an already durable successful operation', context => {
  const f = fixture(context), owner = session(), game = header(owner);
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = path => {
    if (String(path).includes(`${join(f.directory, '.pending')}`) && String(path).endsWith('.json')) {
      throw Object.assign(new Error('Simulated marker cleanup failure'), { code: 'EACCES' });
    }
    return originalUnlink(path);
  };
  syncBuiltinESMExports();
  try {
    const response = f.store.commit({ session: owner, starts: [game], request: {
      scope: '$create', requestId: 'create', fingerprint: 'create', response: { accepted: true },
    } });
    assert.deepEqual(response, { accepted: true });
    assert.equal(f.store.getGame(owner.sessionId, game.gameId).status, 'in_progress');
    assert.deepEqual(f.store.lookupRequest('$create', 'create', 'create'), { accepted: true });
    assert.equal(readdirSync(join(f.directory, '.pending')).length, 1);
  } finally {
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
  }
  f.reopen();
  assert.equal(f.store.getGame(owner.sessionId, game.gameId).endReason, 'interrupted');
  assert.equal(readdirSync(join(f.directory, '.pending')).length, 0);
});

test('a failed active-session guard writes no manifest, transition or request response', context => {
  const f = fixture(context), owner = session(), game = header(owner);
  f.store.commit({ session: owner, starts: [game] });
  const failure = Object.assign(new Error('Worker failed before delayed commit'), { status: 503, code: 'RL_WORKER_FAILED' });
  const event = transition(game, game.initialState, 0);
  assert.throws(() => f.store.commit({ steps: [event],
    request: { scope: owner.sessionId, requestId: 'cancelled', fingerprint: 'cancelled', response: { accepted: true } },
    assertActive() { throw failure; },
  }), error => error === failure);
  assert.equal(f.store.listSteps(owner.sessionId, game.gameId).total, 0);
  assert.equal(f.store.lookupRequest(owner.sessionId, 'cancelled', 'cancelled'), null);
  assert.equal(readdirSync(join(f.directory, '.pending')).length, 0);
  assert.equal(readFileSync(gameFile(f.directory, owner, game, '.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('replay rejects tampered coordinates, block identities, state hashes and unsupported rules', context => {
  const f = fixture(context), owner = session(), game = header(owner);
  const event = transition(game, game.initialState, 0);
  f.store.commit({ session: owner, starts: [game], steps: [event] });
  const saved = f.store.getGame(owner.sessionId, game.gameId), steps = f.store.getStepsForReplay(owner.sessionId, game.gameId);
  for (const change of [{ x: 7 }, { blockId: 999 }, { stateHashAfter: 'tampered' }, { scoreAfter: 999 },
    { attemptCount: 99 }, { placementCount: 99 }, { terminated: true }, { truncated: true }]) {
    assert.throws(() => replayGameRecord(saved, [{ ...steps[0], ...change }]), errorIs(422, 'REPLAY_MISMATCH'));
  }
  assert.throws(() => replayGameRecord({ ...saved, engineRulesVersion: 'unknown' }, steps), errorIs(409, 'UNSUPPORTED_RULES'));
  assert.throws(() => replayGameRecord({ ...saved, schemaVersion: 999 }, steps), errorIs(409, 'UNSUPPORTED_RULES'));
});
