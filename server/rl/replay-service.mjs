import { Worker } from 'node:worker_threads';
import { ApiError } from '../../app/api/_lib/service.js';

// Replays use a read transaction in a separate worker. A long game must not
// block live environments or load every action into the HTTP process at once.
export function createReplayService(recordsDir, { maxConcurrent = 2, timeoutMs = 60000 } = {}) {
  const jobs = new Set();
  let closed = false;

  return {
    run(sessionId, gameId) {
      if (closed) throw new ApiError(503, 'RL_REPLAY_CLOSED', '재생 작업이 종료되었습니다.');
      if (jobs.size >= maxConcurrent) throw new ApiError(429, 'REPLAY_OVERLOADED', '진행 중인 재생 검증이 많습니다. 잠시 후 다시 시도해주세요.');
      const worker = new Worker(new URL('./replay-worker.mjs', import.meta.url), {
        execArgv: [],
        workerData: { recordsDir, sessionId, gameId },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      return new Promise((resolve, reject) => {
        let finished = false;
        const job = { worker, fail: error => finish(error) };
        const timer = setTimeout(() => finish(new ApiError(503, 'REPLAY_TIMEOUT', '재생 검증 제한 시간을 초과했습니다.')), timeoutMs);
        timer.unref();
        jobs.add(job);

        function finish(error, value) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          jobs.delete(job);
          void worker.terminate().catch(() => {});
          if (error) reject(error);
          else resolve(value);
        }
        worker.once('message', message => {
          if (message.error) finish(new ApiError(message.error.status, message.error.code, message.error.message));
          else finish(null, message.result);
        });
        worker.once('error', () => finish(new ApiError(503, 'REPLAY_WORKER_FAILED', '재생 검증 작업자가 종료되었습니다.')));
        worker.once('exit', () => {
          if (!finished) finish(new ApiError(503, 'REPLAY_WORKER_FAILED', '재생 검증 결과를 받지 못했습니다.'));
        });
      });
    },

    async close() {
      closed = true;
      const pending = [...jobs];
      for (const job of pending) job.fail(new ApiError(503, 'RL_REPLAY_CLOSED', '서버 종료로 재생 검증을 중단했습니다.'));
      await Promise.all(pending.map(job => job.worker.terminate()));
    },
  };
}
