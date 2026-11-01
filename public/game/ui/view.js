import { getShape } from '../shapes.js';
import { EMPTY, SIZE } from '../engine.js';
import { createGameEffects } from './effects.js';

/** Draw authoritative snapshots without owning game or interaction state. */
export function createGameView({ document, window, mode, storage }) {
  const element = id => document.getElementById(id);
  const boardEl = element('board');
  const trayEl = element('tray');
  const ghost = element('drag-ghost');
  const elements = {
    restart: element('restart'),
    playAgain: element('play-again'),
    retry: element('retry'),
    overDialog: element('over-dialog'),
  };
  const cells = [];
  let slotHandlers = {};
  let unbindControls = () => {};
  let best = mode.readOnly ? 0 : Number(storage.get('best', 0)) || 0;

  if (mode.readOnly) {
    document.title = `학습 환경 ${Number.isInteger(mode.envId) ? mode.envId : '?'} · Block Blast`;
    elements.restart.hidden = true;
    elements.playAgain.hidden = true;
    boardEl.removeAttribute('tabindex');
    boardEl.setAttribute('aria-readonly', 'true');
    boardEl.setAttribute('aria-label', '8행 8열 학습 환경 관찰 화면');
  }

  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = row;
      cell.dataset.col = col;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-rowindex', row + 1);
      cell.setAttribute('aria-colindex', col + 1);
      boardEl.append(cell);
      cells.push(cell);
    }
  }

  const effects = createGameEffects({ document, window, boardEl, cells, readOnly: mode.readOnly });

  function colorStyle(target, color) {
    const number = Math.max(1, Math.min(7, color || 1));
    target.style.setProperty('--piece-color', `var(--color-${number})`);
  }

  function pieceElement(id, color, size) {
    const shape = getShape(id);
    const piece = document.createElement('div');
    piece.className = 'piece';
    if (!shape) return piece;

    piece.style.setProperty('--cols', shape.width);
    piece.style.setProperty('--rows', shape.height);
    if (size) piece.style.setProperty('--block-size', `${size}px`);
    colorStyle(piece, color);
    for (const { x, y } of shape.cells) {
      const block = document.createElement('i');
      block.className = 'block-cell';
      block.style.gridColumn = x + 1;
      block.style.gridRow = y + 1;
      piece.append(block);
    }
    return piece;
  }

  function renderBoard(snapshot) {
    snapshot.state.board.forEach((row, r) => row.forEach((value, c) => {
      const cell = cells[r * SIZE + c];
      cell.className = 'cell';
      cell.classList.toggle('filled', value !== EMPTY);
      if (value !== EMPTY) colorStyle(cell, value);
      cell.setAttribute('aria-label', `${r + 1}행 ${c + 1}열 ${value === EMPTY ? '빈칸' : '블록 있음'}`);
    }));
  }

  function renderTray(snapshot, { busy = false, selected = -1, deal = false } = {}) {
    trayEl.replaceChildren();
    if (!snapshot) return;

    snapshot.state.tray.forEach((id, slot) => {
      const button = document.createElement('button');
      const shape = getShape(id);
      const used = id === -1;
      const legal = snapshot.legalMoves?.find(item => item.slot === slot)?.positions || [];
      button.className = 'slot';
      button.dataset.slot = slot;
      button.disabled = mode.readOnly || used || busy;
      button.classList.toggle('used', used);
      button.classList.toggle('unplaceable', !used && !legal.length);
      button.classList.toggle('selected', selected === slot);
      button.classList.toggle('dealing', deal && !used);
      button.setAttribute('aria-pressed', String(selected === slot));
      button.setAttribute('aria-label', used
        ? `${slot + 1}번 블록 사용 완료`
        : `${slot + 1}번 블록, ${shape?.width}열 ${shape?.height}행, ${legal.length}곳에 배치 가능`);

      if (used) {
        button.innerHTML = '<svg class="slot-check" aria-hidden="true"><use href="#i-check"/></svg>';
      } else {
        const size = shape?.width === 5 && window.innerWidth < 390 ? 17 : undefined;
        button.append(pieceElement(id, snapshot.state.colors[slot], size));
      }
      const number = document.createElement('span');
      number.className = 'slot-number';
      number.textContent = slot + 1;
      number.setAttribute('aria-hidden', 'true');
      button.append(number);

      if (!mode.readOnly) {
        button.addEventListener('pointerdown', event => slotHandlers.onSlotDown?.(event, slot, button));
        button.addEventListener('click', event => {
          if (event.detail === 0) slotHandlers.onSlotClick?.(slot, true);
        });
      }
      trayEl.append(button);
    });
  }

  function renderStats(snapshot, busy) {
    if (!snapshot) return;
    const state = snapshot.state;
    element('score').textContent = state.score.toLocaleString('ko-KR');
    if (!mode.readOnly) {
      best = Math.max(best, state.score);
      storage.set('best', best);
    }

    const combo = element('combo-badge');
    combo.hidden = state.combo < 2 || state.unEliminateTimes > 0;
    // Original ComboBase shows no number at internal count 2, then count - 1.
    combo.textContent = state.combo === 2 ? 'COMBO' : `COMBO ${state.combo - 1}`;
    elements.restart.disabled = mode.readOnly || busy;
  }

  function render(snapshot, { busy = false, selected = -1, deal = false } = {}) {
    if (!snapshot) return;
    renderBoard(snapshot);
    renderTray(snapshot, { busy, selected, deal });
    renderStats(snapshot, busy);
  }

  function setBusy(busy, snapshot) {
    document.body.classList.toggle('busy', busy);
    renderStats(snapshot, busy);
    trayEl.querySelectorAll('.slot').forEach((button, slot) => {
      button.disabled = mode.readOnly || busy || snapshot?.state.tray[slot] === -1;
    });
  }

  function showLoading(message, { retry = false } = {}) {
    element('board-loading').hidden = false;
    element('loading-message').textContent = message;
    elements.retry.hidden = !retry;
    elements.retry.textContent = '다시 연결';
  }

  function hideLoading() {
    element('board-loading').hidden = true;
    elements.retry.hidden = true;
  }

  function bindControls({ onRestart, onPlayAgain, onRetry }) {
    unbindControls();
    const listeners = [];
    function listen(target, event, callback) {
      target.addEventListener(event, callback);
      listeners.push(() => target.removeEventListener(event, callback));
    }

    listen(elements.restart, 'click', () => {
      if (!mode.readOnly) onRestart?.();
    });
    listen(elements.playAgain, 'click', () => {
      if (mode.readOnly) return;
      effects.closeGameOver();
      onPlayAgain?.();
    });
    listen(elements.retry, 'click', () => onRetry?.());

    for (const button of document.querySelectorAll('[data-close]')) {
      listen(button, 'click', () => button.closest('dialog').close());
    }
    for (const dialog of document.querySelectorAll('dialog')) {
      listen(dialog, 'click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right ||
            event.clientY < rect.top || event.clientY > rect.bottom) {
          dialog.close();
        }
      });
    }

    unbindControls = () => {
      for (const removeListener of listeners) removeListener();
    };
    return unbindControls;
  }

  function dispose() {
    unbindControls();
    slotHandlers = {};
    document.body.classList.remove('busy');
    effects.dispose();
  }

  return {
    boardEl,
    trayEl,
    ghost,
    cells,
    elements,
    pieceElement,
    colorStyle,
    render,
    renderTray,
    setBusy,
    setSlotHandlers: handlers => { slotHandlers = handlers ?? {}; },
    bindControls,
    showLoading,
    hideLoading,
    isLoading: () => !element('board-loading').hidden,
    toast: effects.toast,
    announce: effects.announce,
    invalidFeedback: effects.invalidFeedback,
    presentTransition: effects.presentTransition,
    closeGameOver: effects.closeGameOver,
    dispose,
  };
}
