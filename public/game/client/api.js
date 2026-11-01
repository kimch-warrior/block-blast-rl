export function readGameMode(search = '') {
  const query = new URLSearchParams(search);
  const readOnly = query.has('session') || query.has('env');
  const sessionId = query.get('session') || '';
  const envText = query.get('env') ?? '0';
  const envId = Number(envText);
  const validViewer = /^[a-zA-Z0-9_-]{1,100}$/.test(sessionId) &&
    /^\d+$/.test(envText) && Number.isInteger(envId) && envId >= 0 && envId < 512;

  return Object.freeze({
    readOnly,
    sessionId,
    envId,
    valid: !readOnly || validViewer,
    statePath: readOnly
      ? `/api/rl/sessions/${encodeURIComponent(sessionId)}/envs/${envId}`
      : '/api/state',
    pollIntervalMs: readOnly ? 500 : 1600,
  });
}

export function createGameApi({ fetch = globalThis.fetch, timeoutMs = 12000 } = {}) {
  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        ...(body ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        } : {}),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const error = new Error(data.error?.message || `요청을 처리하지 못했어요 (${response.status}).`);
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return { request };
}
