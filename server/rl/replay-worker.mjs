import { parentPort, workerData } from 'node:worker_threads';
import { replayStoredGame } from './replay.mjs';

try {
  const result = replayStoredGame(workerData.recordsDir, workerData.sessionId, workerData.gameId);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: {
    status: error.status ?? 503,
    code: error.code ?? 'REPLAY_FAILED',
    message: error.status ? error.message : '저장된 게임을 재생하지 못했습니다.',
  } });
} finally {
  parentPort.close();
}
