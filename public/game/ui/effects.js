/** Transient feedback and dialogs, independent of input and network state. */
export function createGameEffects({ document, window, boardEl, cells, readOnly }) {
  const element = id => document.getElementById(id);
  const timers = new Set();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let toastTimer;
  let announceTimer;
  let shakeTimer;
  let pulseTimer;
  let gameOverTimer;
  let gameOverShown = null;
  let snapshotKey = null;
  let gameOver = false;

  function later(callback, delay) {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  }

  function cancel(timer) {
    window.clearTimeout(timer);
    timers.delete(timer);
  }

  function toast(message) {
    cancel(toastTimer);
    const toastEl = element('toast');
    toastEl.textContent = message;
    toastEl.classList.add('visible');
    toastTimer = later(() => toastEl.classList.remove('visible'), 2600);
  }

  function announce(message) {
    element('announcement').textContent = message;
  }

  function invalidFeedback(message) {
    toast(message);
    cancel(shakeTimer);
    boardEl.classList.remove('shake');
    void boardEl.offsetWidth;
    boardEl.classList.add('shake');
    shakeTimer = later(() => boardEl.classList.remove('shake'), 220);
  }

  function celebrate(previous, move) {
    if (reducedMotion) return;

    const layer = element('celebration');
    const frame = layer.getBoundingClientRect();
    const locations = new Set();
    for (const row of move.clearedRows || []) {
      for (let col = 0; col < 8; col++) locations.add(row * 8 + col);
    }
    for (const col of move.clearedCols || []) {
      for (let row = 0; row < 8; row++) locations.add(row * 8 + col);
    }

    for (const index of locations) {
      const rect = cells[index].getBoundingClientRect();
      const particle = document.createElement('i');
      const color = previous.state.board[Math.floor(index / 8)][index % 8];
      particle.className = 'particle';
      particle.style.cssText = [
        `left:${rect.left - frame.left + rect.width * 0.25}px`,
        `top:${rect.top - frame.top + rect.height * 0.25}px`,
        `width:${rect.width * 0.5}px`,
        `height:${rect.height * 0.5}px`,
        `background:var(--color-${color > 0 ? color : 2})`,
        `--tx:${(Math.random() - 0.5) * 90}px`,
        `--ty:${-30 - Math.random() * 65}px`,
        `--rotate:${Math.random() * 180 - 90}deg`,
      ].join(';');
      layer.append(particle);
      later(() => particle.remove(), 650);
    }
  }

  function showMove(previous, next, move) {
    if (move.points > 0) {
      const scoreAdd = element('score-add');
      scoreAdd.textContent = `+${move.points}`;
      scoreAdd.classList.remove('score-pop');
      void scoreAdd.offsetWidth;
      scoreAdd.classList.add('score-pop');
    }

    const cleared = (move.clearedRows?.length || 0) + (move.clearedCols?.length || 0);
    if (cleared) celebrate(previous, move);
    if (move.refilled) {
      announceTimer = later(() => announce('새로운 블록 세 개가 도착했습니다.'), 300);
    } else {
      announce(`${move.points}점 획득. 현재 ${next.state.score}점.`);
    }
  }

  function closeGameOver() {
    const dialog = element('over-dialog');
    if (dialog.open) dialog.close();
  }

  function presentTransition(previous, next, { move = null, external = false } = {}) {
    cancel(announceTimer);
    const key = `${next.id}:${next.version}`;
    if (key !== snapshotKey || !next.gameOver) cancel(gameOverTimer);
    snapshotKey = key;
    gameOver = next.gameOver;

    if (!gameOver) {
      gameOverShown = null;
      closeGameOver();
    }
    if (move && previous) showMove(previous, next, move);
    if (external) {
      cancel(pulseTimer);
      boardEl.classList.add('api-pulse');
      pulseTimer = later(() => boardEl.classList.remove('api-pulse'), 850);
    }

    if (!readOnly && gameOver && gameOverShown !== key) {
      gameOverShown = key;
      element('final-score').textContent = next.state.score.toLocaleString('ko-KR');
      gameOverTimer = later(() => {
        if (snapshotKey === key && gameOver && !document.querySelector('dialog[open]')) {
          element('over-dialog').showModal();
        }
      }, 550);
    }
  }

  function dispose() {
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
    boardEl.classList.remove('shake', 'api-pulse');
    element('toast').classList.remove('visible');
    element('celebration').replaceChildren();
    closeGameOver();
  }

  return { toast, announce, invalidFeedback, presentTransition, closeGameOver, dispose };
}
