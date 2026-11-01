import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameController } from '../public/game/client/controller.js';
import { readGameMode } from '../public/game/client/api.js';
import { createGame } from '../public/game/engine.js';

const snapshot = version => ({
  id: 'game', version, state: { ...createGame(123), moves: version - 1 },
  gameOver: false, canUndo: version > 1, legalMoves: [], lastMove: null,
});
const apiError = (status, data = {}) => Object.assign(new Error('API failure'), { status, data });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(handler, search = '') {
  const requests = [], rendered = [], transitions = [], saved = [], toasts = [], invalid = [];
  const intervals = new Map();
  const document = new EventTarget();
  document.hidden = false;
  let loading = false;
  const input = {
    dragging: false, binds: 0, resets: 0, disposals: 0,
    onSlotDown() {}, selectSlot() {},
    bind() { this.binds++; }, reset() { this.resets++; },
    dispose() { this.disposals++; }, isDragging() { return this.dragging; },
  };
  const view = {
    disposals: 0,
    setSlotHandlers(handlers) { this.slotHandlers = handlers; },
    bindControls(handlers) { this.controls = handlers; },
    render(next, options) { rendered.push({ next, options }); },
    presentTransition(previous, next, options) { transitions.push({ previous, next, options }); },
    showLoading() { loading = true; }, hideLoading() { loading = false; },
    isLoading() { return loading; }, setBusy() {},
    toast(message) { toasts.push(message); },
    invalidFeedback(message) { invalid.push(message); },
    dispose() { this.disposals++; },
  };
  const window = {
    CustomEvent,
    crypto: { randomUUID: () => 'request-id' },
    console: { error() {} },
    setInterval(callback, delay) { const id = intervals.size + 1; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
  const api = {
    async request(path, options) { requests.push({ path, options }); return handler(path, options); },
  };
  const storage = { set(key, value) { saved.push({ key, value }); } };
  const controller = createGameController({ api, mode: readGameMode(search), view, storage, window, document });
  return { controller, input, view, document, requests, rendered, transitions, saved, toasts, invalid, intervals };
}

test('normal startup creates a missing game and publishes independent snapshot events', async t => {
  const initial = snapshot(1);
  const h = harness(path => {
    if (path === '/api/state') throw apiError(404);
    assert.equal(path, '/api/games');
    return initial;
  });
  t.after(() => h.controller.dispose());
  h.document.addEventListener('blockblast:state', event => { event.detail.state.score = 999; });
  await h.controller.start(h.input);
  assert.deepEqual(h.requests.map(request => request.path), ['/api/state', '/api/games']);
  assert.deepEqual(h.requests[1].options, { method: 'POST', body: {} });
  assert.equal(h.controller.getSnapshot().state.score, 0);
  assert.deepEqual(h.saved, [{ key: 'game-id', value: 'game' }]);
  assert.equal(h.rendered.length, 1);
  assert.equal([...h.intervals.values()][0].delay, 1600);
  await h.controller.start(h.input);
  assert.equal(h.input.binds, 1);
});

test('invalid or missing observer sessions never create games or permit commands', async t => {
  for (const search of ['?session=missing&env=511', '?env=512']) {
    const h = harness(() => { throw apiError(404); }, search);
    t.after(() => h.controller.dispose());
    await h.controller.start(h.input);
    assert.ok(h.requests.every(request => request.path.startsWith('/api/rl/sessions/')));
    assert.equal(h.requests.length, search.includes('missing') ? 1 : 0);
    assert.equal(h.view.isLoading(), true);
    assert.deepEqual(h.saved, []);
    await assert.rejects(h.controller.place(0, 0, 0), /관찰 화면/);
    await assert.rejects(h.controller.reset(), /관찰 화면/);
    await assert.rejects(h.controller.undo(), /관찰 화면/);
  }
});

test('pending commands suppress duplicate placements and polling, then display the authoritative result', async t => {
  const pending = deferred();
  const initial = snapshot(1), next = snapshot(2);
  next.lastMove = { points: 4, refilled: false };
  const h = harness(path => path === '/api/state' ? initial : pending.promise);
  t.after(() => h.controller.dispose());
  await h.controller.start(h.input);
  const placing = h.controller.place(0, 2, 3);
  assert.equal(h.controller.isBusy(), true);
  await h.controller.place(1, 0, 0);
  await h.controller.poll();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1], {
    path: '/api/games/game/place',
    options: { method: 'POST', body: { slot: 0, row: 2, col: 3, version: 1, requestId: 'request-id' } },
  });
  pending.resolve(next);
  const returned = await placing;
  assert.equal(h.controller.isBusy(), false);
  assert.equal(h.controller.getSnapshot().version, 2);
  assert.deepEqual(h.transitions.at(-1).options.move, next.lastMove);
  returned.state.score = 999;
  assert.equal(h.controller.getSnapshot().state.score, 0);
});

test('version conflicts recover the latest snapshot and invalid moves retain feedback', async t => {
  let failure = apiError(409, snapshot(3));
  const h = harness(path => {
    if (path === '/api/state') return snapshot(1);
    throw failure;
  });
  t.after(() => h.controller.dispose());
  await h.controller.start(h.input);
  await h.controller.place(0, 0, 0);
  assert.equal(h.controller.getSnapshot().version, 3);
  assert.match(h.toasts.at(-1), /최신 상태/);
  failure = apiError(422);
  await h.controller.place(0, 0, 0);
  assert.match(h.invalid.at(-1), /놓을 수 없어요/);
  assert.equal(h.controller.isBusy(), false);
});

test('polling ignores stale snapshots and pauses while hidden or dragging', async t => {
  let current = snapshot(2);
  const h = harness(() => current);
  t.after(() => h.controller.dispose());
  await h.controller.start(h.input);
  current = snapshot(1);
  await h.controller.poll();
  assert.equal(h.rendered.length, 1);
  h.document.hidden = true;
  await h.controller.poll();
  h.document.hidden = false;
  h.input.dragging = true;
  await h.controller.poll();
  assert.equal(h.requests.length, 2);
  h.input.dragging = false;
  current = snapshot(3);
  await h.controller.poll();
  assert.equal(h.controller.getSnapshot().version, 3);
  assert.equal(h.transitions.at(-1).options.external, true);
});

test('observer polling reconnects and disposal prevents pending responses from rendering', async () => {
  let current = snapshot(1);
  const pending = deferred();
  const h = harness(() => {
    if (current instanceof Error) throw current;
    return current;
  }, '?session=training&env=511');
  await h.controller.start(h.input);
  assert.equal([...h.intervals.values()][0].delay, 500);
  current = apiError(404);
  await h.controller.poll();
  assert.equal(h.view.isLoading(), true);
  current = snapshot(1);
  await h.controller.poll();
  assert.equal(h.view.isLoading(), false);
  assert.equal(h.transitions.at(-1).options.external, false);
  assert.deepEqual(h.saved, []);
  current = pending.promise;
  const polling = h.controller.poll();
  const renderCount = h.rendered.length;
  h.controller.dispose();
  pending.resolve(snapshot(2));
  await polling;
  assert.equal(h.rendered.length, renderCount);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.input.disposals, 1);
  assert.equal(h.view.disposals, 1);
});
