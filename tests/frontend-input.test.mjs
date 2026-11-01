import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameInput } from '../public/game/ui/input.js';
import { createGame, canPlace, getShape, placements } from '../public/game/engine.js';

class EventSurface {
  #listeners = new Map();

  addEventListener(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.#listeners.get(type) || []) listener(event);
  }

  get listenerCount() {
    return [...this.#listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

const classList = () => ({ add() {}, remove() {}, toggle() {} });
const keyEvent = key => ({
  key,
  preventDefault() {},
  target: { matches: () => false, closest: () => false },
});

function fixture({ readOnly = false } = {}) {
  const state = createGame(123);
  let snapshot = {
    state,
    gameOver: false,
    legalMoves: state.tray.map((id, slot) => ({ slot, positions: placements(state.board, id) })),
  };
  let busy = false;
  const placed = [];
  const feedback = [];

  function pieceElement(id, color, size = 20) {
    const shape = getShape(id);
    return {
      style: { setProperty() {} },
      getBoundingClientRect: () => ({ left: 10, top: 650, width: shape.width * size }),
    };
  }

  const buttons = state.tray.map(id => {
    const piece = pieceElement(id);
    return {
      classList: classList(),
      setAttribute() {},
      querySelector: () => piece,
      setPointerCapture() {},
      releasePointerCapture() {},
    };
  });
  const board = new EventSurface();
  board.focus = () => {};
  board.getBoundingClientRect = () => ({ left: 100, top: 200, right: 495, bottom: 595, width: 395 });
  const window = new EventSurface();
  window.getComputedStyle = () => ({ gap: '5' });
  const ghost = {
    style: {},
    children: [],
    replaceChildren(...children) { this.children = children; },
    querySelector() { return this.children[0]; },
  };
  const view = {
    boardEl: board,
    trayEl: { querySelectorAll: () => buttons },
    ghost,
    cells: Array.from({ length: 64 }, () => ({ classList: classList() })),
    pieceElement,
    colorStyle() {},
    renderTray() {},
    announce() {},
    invalidFeedback: message => feedback.push(message),
  };
  const input = createGameInput({
    view,
    readOnly,
    getSnapshot: () => snapshot,
    isBusy: () => busy,
    onPlace: (...args) => placed.push(args),
    window,
    document: { querySelector: () => null },
  });

  return {
    input, window, board, buttons, ghost, state, placed, feedback,
    setBusy: value => { busy = value; },
    clearSnapshot: () => { snapshot = null; },
    listenerCount: () => board.listenerCount + window.listenerCount,
  };
}

function pointerDown(pointerId = 1, pointerType = 'mouse') {
  return { button: 0, pointerId, pointerType, clientX: 20, clientY: 660, preventDefault() {} };
}

test('keyboard selection, movement and Enter emit a legal placement; Escape clears selection', t => {
  const context = fixture();
  t.after(() => context.input.dispose());
  context.input.bind();

  context.window.dispatch('keydown', keyEvent('3'));
  context.window.dispatch('keydown', keyEvent('ArrowRight'));
  context.window.dispatch('keydown', keyEvent('Enter'));
  assert.deepEqual(context.placed, [[2, 0, 1]]);
  const [slot, row, col] = context.placed[0];
  assert.ok(canPlace(context.state.board, context.state.tray[slot], row, col));

  context.window.dispatch('keydown', keyEvent('Escape'));
  context.window.dispatch('keydown', keyEvent('Enter'));
  assert.equal(context.placed.length, 1);
  assert.deepEqual(context.feedback, []);
});

test('mouse and touch drag/drop emit legal coordinates while a click-sized gesture does not place', t => {
  for (const pointerType of ['mouse', 'touch']) {
    const context = fixture();
    t.after(() => context.input.dispose());
    context.input.bind();

    context.input.onSlotDown(pointerDown(1, pointerType), 0, context.buttons[0]);
    context.window.dispatch('pointermove', { pointerId: 1, clientX: 22, clientY: 662 });
    context.window.dispatch('pointerup', { pointerId: 1 });
    assert.equal(context.placed.length, 0);
    assert.equal(context.input.isDragging(), false);

    context.input.onSlotDown(pointerDown(2, pointerType), 0, context.buttons[0]);
    assert.equal(context.input.isDragging(), true);
    // The board pitch is 50px. Touch dragging lifts the piece by 64px.
    context.window.dispatch('pointermove', {
      pointerId: 2,
      clientX: 125,
      clientY: pointerType === 'touch' ? 289 : 225,
    });
    context.window.dispatch('pointerup', { pointerId: 2 });
    assert.deepEqual(context.placed, [[0, 0, 0]]);
    assert.ok(canPlace(context.state.board, context.state.tray[0], 0, 0));
    assert.equal(context.input.isDragging(), false);
    assert.equal(context.ghost.style.display, 'none');
    assert.deepEqual(context.feedback, []);
  }
});

test('read-only, busy and missing-snapshot guards prevent placement attempts', t => {
  const observer = fixture({ readOnly: true });
  const context = fixture();
  t.after(() => observer.input.dispose());
  t.after(() => context.input.dispose());

  observer.input.bind();
  observer.input.selectSlot(0, true);
  observer.input.onSlotDown(pointerDown(), 0, observer.buttons[0]);
  observer.window.dispatch('keydown', keyEvent('Enter'));
  assert.equal(observer.listenerCount(), 0);
  assert.equal(observer.input.isDragging(), false);
  assert.deepEqual(observer.placed, []);

  context.input.bind();
  context.setBusy(true);
  context.window.dispatch('keydown', keyEvent('1'));
  context.input.onSlotDown(pointerDown(), 0, context.buttons[0]);
  assert.equal(context.input.isDragging(), false);
  context.window.dispatch('keydown', keyEvent('Enter'));
  assert.deepEqual(context.placed, []);

  context.setBusy(false);
  context.window.dispatch('keydown', keyEvent('1'));
  context.setBusy(true);
  context.window.dispatch('keydown', keyEvent('Enter'));
  assert.deepEqual(context.placed, []);
  context.setBusy(false);
  context.clearSnapshot();
  context.window.dispatch('keydown', keyEvent('Enter'));
  context.input.onSlotDown(pointerDown(), 0, context.buttons[0]);
  assert.equal(context.input.isDragging(), false);
  assert.deepEqual(context.placed, []);
});

test('binding is idempotent and reset/dispose cancel pending gestures and remove listeners', () => {
  const context = fixture();
  context.input.bind();
  const listeners = context.listenerCount();
  assert.ok(listeners > 0);
  context.input.bind();
  assert.equal(context.listenerCount(), listeners);

  context.input.onSlotDown(pointerDown(), 0, context.buttons[0]);
  context.input.reset();
  assert.equal(context.input.isDragging(), false);
  context.window.dispatch('pointerup', { pointerId: 1 });
  assert.deepEqual(context.placed, []);
  assert.equal(context.listenerCount(), listeners);

  context.input.onSlotDown(pointerDown(), 0, context.buttons[0]);
  context.input.dispose();
  context.input.dispose();
  assert.equal(context.listenerCount(), 0);
  assert.equal(context.input.isDragging(), false);
  assert.equal(context.ghost.style.display, 'none');
  context.window.dispatch('keydown', keyEvent('1'));
  context.window.dispatch('keydown', keyEvent('Enter'));
  context.window.dispatch('pointerup', { pointerId: 1 });
  context.input.selectSlot(0, true);
  assert.deepEqual(context.placed, []);
});
