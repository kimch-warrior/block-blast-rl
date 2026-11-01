// Coordinates server snapshots and commands; view and input own their UI state.
export function createGameController({ api, mode, view, storage, window, document }) {
  let snapshot = null;
  let input = null;
  let busy = false;
  let polling = false;
  let booting = false;
  let started = false;
  let disposed = false;
  let pollTimer;

  function applySnapshot(next, { external = false, move = null } = {}) {
    const previous = snapshot;
    input?.reset();
    snapshot = next;
    if (!mode.readOnly) storage.set('game-id', next.id);
    view.render(next, { busy, deal: move?.refilled });
    view.hideLoading();
    view.presentTransition(previous, next, { move, external });
    document.dispatchEvent(new window.CustomEvent('blockblast:state', {
      detail: structuredClone(next),
    }));
  }

  function setBusy(value) {
    busy = value;
    if (!disposed) view.setBusy(value, snapshot);
  }

  async function boot() {
    if (booting || disposed) return;
    booting = true;
    view.showLoading('게임판을 준비하고 있어요');
    try {
      let next;
      if (mode.readOnly) {
        if (!mode.valid) throw new Error('올바른 session과 env(0~511)를 지정해주세요.');
        next = await api.request(mode.statePath);
      } else {
        try {
          next = await api.request(mode.statePath);
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        if (!next) next = await api.request('/api/games', { method: 'POST', body: {} });
      }
      if (!disposed) applySnapshot(next);
    } catch (error) {
      if (disposed) return;
      const message = mode.readOnly
        ? (mode.valid ? '학습 환경을 찾지 못했어요. 세션과 연결을 확인해주세요.' : error.message)
        : '연결이 잠시 끊겼어요. 다시 시도해주세요.';
      view.showLoading(message, { retry: true });
      window.console.error('Game connection:', error.message);
    } finally {
      booting = false;
    }
  }

  async function command(kind, body = {}) {
    if (mode.readOnly) throw new Error('학습 환경 관찰 화면에서는 게임을 변경할 수 없습니다.');
    if (!snapshot || busy || disposed) return;
    setBusy(true);
    try {
      const requestId = window.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
      const next = await api.request(`/api/games/${snapshot.id}/${kind}`, {
        method: 'POST',
        body: { ...body, version: snapshot.version, requestId },
      });
      if (disposed) return;
      applySnapshot(next, { move: kind === 'place' ? next.lastMove : null });
      if (kind === 'undo') view.toast('한 수 전으로 돌아왔어요.');
      if (kind === 'reset') view.toast('새로운 판, 가볍게 시작해요.');
      return structuredClone(next);
    } catch (error) {
      if (disposed) return;
      if (error.data?.state) applySnapshot(error.data);
      if (error.status === 409) view.toast('판이 바뀌었어요. 최신 상태로 맞췄습니다.');
      else if (error.status === 422) view.invalidFeedback('그 자리에는 놓을 수 없어요.');
      else view.toast('저장되지 않았어요. 연결을 확인한 뒤 다시 시도해주세요.');
    } finally {
      setBusy(false);
    }
  }

  async function poll() {
    if (!snapshot || busy || polling || booting || disposed || document.hidden || input?.isDragging()) return;
    polling = true;
    try {
      const next = await api.request(mode.statePath);
      if (disposed || busy) return;
      const changed = next.id !== snapshot.id || (mode.readOnly
        ? next.version !== snapshot.version
        : next.version > snapshot.version);
      if (changed || view.isLoading()) applySnapshot(next, { external: !mode.readOnly });
    } catch {
      if (mode.readOnly && !disposed) {
        view.showLoading('학습 환경 연결이 끊겼어요. 세션과 연결을 확인해주세요.', { retry: true });
      }
    } finally {
      polling = false;
    }
  }

  function onVisibilityChange() {
    if (!document.hidden) void poll();
  }

  const place = (slot, row, col) => command('place', { slot, row, col });
  const reset = () => command('reset');
  const undo = () => command('undo');

  function start(inputController) {
    if (started || disposed) return;
    started = true;
    input = inputController;
    view.setSlotHandlers({ onSlotDown: input.onSlotDown, onSlotClick: input.selectSlot });
    view.bindControls({ onRestart: reset, onPlayAgain: reset, onRetry: boot });
    input.bind();
    document.addEventListener('visibilitychange', onVisibilityChange);
    pollTimer = window.setInterval(poll, mode.pollIntervalMs);
    return boot();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.clearInterval(pollTimer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    input?.dispose();
    view.dispose();
  }

  return {
    start, boot, poll, place, reset, undo, dispose,
    // Avoid copying on each mouse move. The public facade makes its own copy.
    getSnapshot: () => snapshot,
    isBusy: () => busy,
  };
}
