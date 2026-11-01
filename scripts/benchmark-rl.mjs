import { performance } from 'node:perf_hooks';
import { createRlPool } from '../server/rl/pool.mjs';
import { DEFAULT_NUM_ENVS, MAX_ENVS } from '../server/rl/protocol.mjs';

const options = { envs: DEFAULT_NUM_ENVS, batches: 200, warmup: 20, workers: '1,4' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.slice(2), value = process.argv[i + 1];
  if (!process.argv[i]?.startsWith('--') || !(key in options) || value === undefined) throw new Error(`Usage: node scripts/benchmark-rl.mjs [--envs ${DEFAULT_NUM_ENVS}] [--batches 200] [--warmup 20] [--workers 1,4]`);
  options[key] = key === 'workers' ? value : Number(value);
}
for (const [key, min, max] of [['envs', 1, MAX_ENVS], ['batches', 1, 2000], ['warmup', 0, 2000]]) {
  if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`Invalid --${key}`);
}
const counts = options.workers.split(',').map(Number);
if (!counts.length || counts.some(count => !Number.isInteger(count) || count < 1 || count > 16)) throw new Error('Invalid --workers');
for (const workerCount of counts) {
  const pool = createRlPool({ workerCount, maxEnvs: MAX_ENVS });
  let batch;
  try {
    batch = await pool.create({ numEnvs: options.envs, seed: 123, maxEpisodeSteps: 200 });
    let resetCount = 0, totalReward = 0;
    const advance = async measured => {
      const done = batch.results.filter(result => result.terminated || result.truncated).map(result => result.envId);
      if (done.length) {
        batch = await pool.reset(batch.sessionId, { version: batch.version, envIds: done });
        if (measured) resetCount += done.length;
      }
      const actions = batch.results.map(result => {
        const valid = [];
        result.actionMask.forEach((allowed, action) => { if (allowed) valid.push(action); });
        if (!valid.length) throw new Error(`No valid action for env ${result.envId}`);
        return valid[(result.observation.moves * 7919 + result.envId * 101) % valid.length];
      });
      batch = await pool.step(batch.sessionId, { version: batch.version, actions });
      if (measured) totalReward += batch.results.reduce((sum, result) => sum + result.reward, 0);
    };
    for (let i = 0; i < options.warmup; i++) await advance(false);
    const timings = [], started = performance.now();
    for (let i = 0; i < options.batches; i++) {
      const time = performance.now();
      await advance(true);
      timings.push(performance.now() - time);
    }
    const seconds = (performance.now() - started) / 1000;
    timings.sort((a, b) => a - b);
    const steps = options.envs * options.batches;
    console.log(JSON.stringify({ workerCount, envs: options.envs, batches: options.batches, steps, seconds,
      stepsPerSecond: steps / seconds, batchMsP50: timings[Math.floor((timings.length - 1) * 0.5)],
      batchMsP95: timings[Math.floor((timings.length - 1) * 0.95)], resetCount, totalReward,
      stats: await pool.stats(),
      includes: 'worker IPC, observations, action masks, block generation and explicit terminal resets; excludes HTTP, disk logging and model inference' }));
  } finally { await pool.close(); }
}
