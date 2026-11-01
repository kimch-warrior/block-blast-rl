import { getShape } from '../shapes.js';
import { SIZE, EMPTY, canPlace, place as simulate } from '../engine.js';

export function createGameInput({
  view,
  getSnapshot,
  isBusy,
  readOnly = false,
  onPlace,
  window,
  document,
}) {
  const { boardEl, trayEl, ghost, cells, pieceElement, colorStyle } = view;
  const listeners = [];
  let selected = -1;
  let preview = null;
  let drag = null;
  let keyboardPosition = { row: 0, col: 0 };
  let suppressClickUntil = 0;
  let bound = false;
  let disposed = false;

  function legalFor(snapshot, slot) {
    return snapshot?.legalMoves?.find(item => item.slot === slot)?.positions || [];
  }

  function clearPreview() {
    const snapshot = getSnapshot();
    cells.forEach((cell, index) => {
      cell.classList.remove('preview', 'invalid', 'will-clear', 'keyboard-cursor');
      const value = snapshot?.state.board[Math.floor(index / SIZE)][index % SIZE];
      if (value !== undefined && value !== EMPTY) colorStyle(cell, value);
    });
    preview = null;
  }

  function showPreview(row, col, keyboard = false) {
    clearPreview();
    const snapshot = getSnapshot();
    if (disposed || readOnly || !snapshot || selected < 0 || isBusy()) return;

    const shapeId = snapshot.state.tray[selected];
    const shape = getShape(shapeId);
    if (!shape) return;

    const valid = canPlace(snapshot.state.board, shapeId, row, col);
    preview = { row, col, valid };
    for (const { x, y } of shape.cells) {
      const r = row + y;
      const c = col + x;
      if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) continue;
      const cell = cells[r * SIZE + c];
      colorStyle(cell, snapshot.state.colors[selected]);
      cell.classList.add('preview');
      cell.classList.toggle('invalid', !valid);
    }

    if (keyboard && row >= 0 && row < SIZE && col >= 0 && col < SIZE) {
      cells[row * SIZE + col].classList.add('keyboard-cursor');
    }
    if (!valid) return;

    const hypothetical = simulate(snapshot.state, selected, row, col);
    if (!hypothetical) return;
    for (const r of hypothetical.clearedRows) {
      for (let c = 0; c < SIZE; c++) cells[r * SIZE + c].classList.add('will-clear');
    }
    for (const c of hypothetical.clearedCols) {
      for (let r = 0; r < SIZE; r++) cells[r * SIZE + c].classList.add('will-clear');
    }
  }

  function selectSlot(slot, keyboard = false) {
    const snapshot = getSnapshot();
    if (disposed || readOnly || !snapshot || isBusy() || snapshot.gameOver ||
        !Number.isInteger(slot) || slot < 0 || slot >= snapshot.state.tray.length ||
        snapshot.state.tray[slot] === -1) return;

    selected = slot;
    clearPreview();
    trayEl.querySelectorAll('.slot').forEach((button, index) => {
      button.classList.toggle('selected', index === slot);
      button.setAttribute('aria-pressed', String(index === slot));
    });
    view.announce(`${slot + 1}번 블록 선택. 방향키로 이동하고 Enter로 배치하세요.`);

    if (keyboard) {
      const first = legalFor(snapshot, slot)[0];
      if (first) keyboardPosition = { row: first.row, col: first.col };
      showPreview(keyboardPosition.row, keyboardPosition.col, true);
      boardEl.focus({ preventScroll: true });
    }
  }

  function geometry() {
    const rect = boardEl.getBoundingClientRect();
    const gap = parseFloat(window.getComputedStyle(boardEl).gap) || 5;
    return {
      rect,
      cell: (rect.width - (SIZE - 1) * gap) / SIZE,
      pitch: (rect.width + gap) / SIZE,
    };
  }

  function pointerCell(event) {
    const { rect, pitch } = geometry();
    return {
      row: Math.floor((event.clientY - rect.top) / pitch),
      col: Math.floor((event.clientX - rect.left) / pitch),
    };
  }

  function onSlotDown(event, slot, button) {
    const snapshot = getSnapshot();
    if (disposed || readOnly || event.button !== 0 || isBusy() || !snapshot ||
        snapshot.state.tray[slot] === -1) return;

    event.preventDefault();
    selectSlot(slot);
    const shape = getShape(snapshot.state.tray[slot]);
    const piece = button.querySelector('.piece');
    if (!shape || !piece) return;

    const rect = piece.getBoundingClientRect();
    const pitch = rect.width / shape.width;
    drag = {
      pointerId: event.pointerId,
      slot,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      anchorCol: Math.max(0, Math.min(shape.width - 1, Math.floor((event.clientX - rect.left) / pitch))),
      anchorRow: Math.max(0, Math.min(shape.height - 1, Math.floor((event.clientY - rect.top) / pitch))),
      touch: event.pointerType === 'touch',
      button,
    };
    try { button.setPointerCapture(event.pointerId); } catch {}
  }

  function onPointerMove(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;

    const snapshot = getSnapshot();
    if (!snapshot) return;
    if (!drag.started) {
      drag.started = true;
      ghost.replaceChildren(pieceElement(snapshot.state.tray[drag.slot], snapshot.state.colors[drag.slot], geometry().cell));
      ghost.style.display = 'block';
      drag.button.querySelector('.piece').style.opacity = '.25';
    }

    const { rect, pitch, cell } = geometry();
    const lift = drag.touch ? Math.min(64, pitch * 1.3) : 0;
    const x = event.clientX - (drag.anchorCol + .5) * pitch;
    const y = event.clientY - lift - (drag.anchorRow + .5) * pitch;
    ghost.style.transform = `translate(${x}px,${y}px)`;
    ghost.querySelector('.piece').style.setProperty('--block-size', `${cell}px`);

    const row = Math.floor((event.clientY - lift - rect.top) / pitch) - drag.anchorRow;
    const col = Math.floor((event.clientX - rect.left) / pitch) - drag.anchorCol;
    const overBoard = event.clientX > rect.left - pitch && event.clientX < rect.right + pitch &&
      event.clientY - lift > rect.top - pitch && event.clientY - lift < rect.bottom + pitch;
    if (overBoard) showPreview(row, col);
    else clearPreview();
  }

  function cancelDrag() {
    if (drag?.button) {
      const piece = drag.button.querySelector('.piece');
      if (piece) piece.style.opacity = '';
      try { drag.button.releasePointerCapture(drag.pointerId); } catch {}
    }
    drag = null;
    ghost.style.display = 'none';
    ghost.replaceChildren();
  }

  function onPointerUp(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const wasDragging = drag.started;
    const target = preview ? { ...preview } : null;
    const slot = drag.slot;
    cancelDrag();
    if (!wasDragging) return;

    suppressClickUntil = Date.now() + 350;
    clearPreview();
    if (target?.valid) onPlace(slot, target.row, target.col);
    else view.invalidFeedback('이 블록이 들어갈 빈칸을 찾아보세요.');
  }

  function onBoardMove(event) {
    if (readOnly || drag || selected < 0 || event.pointerType === 'touch') return;
    const { row, col } = pointerCell(event);
    showPreview(row, col);
  }

  function onBoardLeave() {
    if (!drag) clearPreview();
  }

  function onBoardClick(event) {
    const snapshot = getSnapshot();
    if (readOnly || Date.now() < suppressClickUntil || selected < 0 || isBusy() || !snapshot) return;
    const position = pointerCell(event);
    keyboardPosition = position;
    if (canPlace(snapshot.state.board, snapshot.state.tray[selected], position.row, position.col)) {
      onPlace(selected, position.row, position.col);
    } else {
      showPreview(position.row, position.col);
      view.invalidFeedback('겹치지 않는 빈칸에 놓아주세요.');
    }
  }

  function onKeyDown(event) {
    const snapshot = getSnapshot();
    if (readOnly || document.querySelector('dialog[open]') ||
        event.target?.matches?.('input,textarea,select') || event.ctrlKey || event.metaKey || event.altKey || !snapshot) return;

    if (/^[123]$/.test(event.key)) {
      event.preventDefault();
      selectSlot(Number(event.key) - 1, true);
      return;
    }
    if (event.key === 'Escape') {
      selected = -1;
      cancelDrag();
      clearPreview();
      view.renderTray(snapshot, { busy: isBusy(), selected });
      return;
    }
    if (selected < 0 || isBusy() || event.target?.closest?.('button,a')) return;

    const shape = getShape(snapshot.state.tray[selected]);
    if (!shape) return;
    const delta = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    }[event.key];
    if (delta) {
      event.preventDefault();
      keyboardPosition.row = Math.max(0, Math.min(SIZE - shape.height, keyboardPosition.row + delta[0]));
      keyboardPosition.col = Math.max(0, Math.min(SIZE - shape.width, keyboardPosition.col + delta[1]));
      showPreview(keyboardPosition.row, keyboardPosition.col, true);
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const position = preview || keyboardPosition;
      if (canPlace(snapshot.state.board, snapshot.state.tray[selected], position.row, position.col)) {
        onPlace(selected, position.row, position.col);
      } else {
        view.invalidFeedback('이 자리에는 놓을 수 없어요.');
      }
    }
  }

  function reset() {
    cancelDrag();
    clearPreview();
    selected = -1;
  }

  function onCancel() {
    cancelDrag();
    clearPreview();
  }

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push({ target, type, handler, options });
  }

  function bind() {
    if (bound || disposed || readOnly) return;
    bound = true;
    listen(boardEl, 'pointermove', onBoardMove);
    listen(boardEl, 'pointerleave', onBoardLeave);
    listen(boardEl, 'click', onBoardClick);
    listen(window, 'pointermove', onPointerMove, { passive: true });
    listen(window, 'pointerup', onPointerUp);
    listen(window, 'pointercancel', onCancel);
    listen(window, 'blur', onCancel);
    listen(window, 'keydown', onKeyDown);
    listen(window, 'resize', onCancel);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const { target, type, handler, options } of listeners) {
      target.removeEventListener(type, handler, options);
    }
    listeners.length = 0;
    bound = false;
    reset();
  }

  return {
    bind,
    reset,
    dispose,
    isDragging: () => drag !== null,
    onSlotDown,
    selectSlot,
  };
}
