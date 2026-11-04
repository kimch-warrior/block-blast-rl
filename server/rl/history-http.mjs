import { ApiError } from '../../app/api/_lib/service.js';

const route = /^\/api\/rl\/history\/sessions(?:\/([^/]+)\/games(?:\/([^/]+)(?:\/(steps|replay))?)?)?$/;
const identifier = /^[a-zA-Z0-9_-]{1,100}$/;

function pagination(searchParams, defaultLimit) {
  const values = {};
  for (const [key, fallback] of [['limit', defaultLimit], ['offset', 0]]) {
    const entries = searchParams.getAll(key);
    if (entries.length > 1 || (entries.length && !/^(0|[1-9]\d*)$/.test(entries[0]))) {
      throw new ApiError(400, 'INVALID_PAGINATION', 'limit와 offset은 중복 없는 정수여야 합니다.');
    }
    const value = entries.length ? Number(entries[0]) : fallback;
    if (!Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || (key === 'limit' && value > 1000)) {
      throw new ApiError(400, 'INVALID_PAGINATION', 'limit는 1~1000, offset은 0 이상의 정수여야 합니다.');
    }
    values[key] = value;
  }
  return values;
}

export function createHistoryApi({ history, rl, replay }) {
  return {
    async handle(request, url, pathname) {
      const match = route.exec(pathname);
      if (!match) throw new ApiError(404, 'ENDPOINT_NOT_FOUND', '기록 API를 찾을 수 없습니다.');
      if (request.method !== 'GET') {
        const error = new ApiError(405, 'METHOD_NOT_ALLOWED', 'GET 요청을 사용해주세요.');
        error.allow = 'GET';
        throw error;
      }
      const [, sessionId, gameId, resource] = match;
      if ((sessionId && !identifier.test(sessionId)) || (gameId && !identifier.test(gameId))) {
        throw new ApiError(400, 'INVALID_HISTORY_ID', '올바른 sessionId와 gameId를 사용해주세요.');
      }
      // Worker failures close histories asynchronously. Readers wait for those
      // closures, then inspect committed data independently of the live pool.
      await rl.drainRecording();
      if (!sessionId) return history.listSessions(pagination(url.searchParams, 50));
      if (!gameId) return history.listGames(sessionId, pagination(url.searchParams, 50));
      if (resource === 'steps') return history.listSteps(sessionId, gameId, pagination(url.searchParams, 100));
      if (resource === 'replay') return replay.run(sessionId, gameId);
      return history.getGame(sessionId, gameId);
    },
  };
}
