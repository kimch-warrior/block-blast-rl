// Dependency-free CPU environment demo. Replace chooseAction with your policy.
import { DEFAULT_NUM_ENVS, MAX_ENVS } from '../server/rl/protocol.mjs';
import { randomUUID } from 'node:crypto';

const options = { url: process.env.BLOCK_BLAST_URL || 'http://127.0.0.1:5173', envs: DEFAULT_NUM_ENVS, batches: 200, seed: 123, 'delay-ms': 0, mask: 'true' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.slice(2), value = process.argv[i + 1];
  if (!process.argv[i]?.startsWith('--') || !(key in options) || value === undefined) {
    throw new Error(`Usage: node examples/rl-client.mjs [--url URL] [--envs ${DEFAULT_NUM_ENVS}] [--batches 200] [--seed 123] [--delay-ms 0] [--mask true|false]`);
  }
  options[key] = key === 'url' || key === 'mask' ? value : Number(value);
}
if (!['true', 'false'].includes(options.mask)) throw new Error('Invalid --mask: use true or false');
const useMask = options.mask === 'true';
for (const [key, min, max] of [['envs', 1, MAX_ENVS], ['batches', 1, 1_000_000], ['seed', 1, 2147483646], ['delay-ms', 0, 60_000]]) {
  if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`Invalid --${key}`);
}
const base = options.url.replace(/\/$/, '');
async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  // Allocate once, before sending. A network retry must keep both this key and
  // the original version/actions instead of accidentally executing another step.
  const payload = method === 'POST' ? { ...body, requestId: body?.requestId ?? randomUUID() } : body;
  const encoded = payload === undefined ? undefined : JSON.stringify(payload);
  let response, text;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(base + path, {
        method, signal: AbortSignal.timeout(30_000),
        ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }),
      });
      text = await response.text();
      break;
    } catch (error) {
      if (method !== 'POST' || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${data?.error?.code || ''}: ${data?.error?.message || text}`);
  return data;
}
let policySeed = options.seed;
function chooseAction(mask) {
  policySeed = policySeed * 16807 % 2147483647;
  if (!useMask) return policySeed % 192;
  const valid = [];
  mask.forEach((allowed, action) => { if (allowed) valid.push(action); });
  if (!valid.length) throw new Error('Running environment has no valid action');
  return valid[policySeed % valid.length];
}
let stop = false, sessionId;
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
try {
  let batch = await request('/api/rl/sessions', { numEnvs: options.envs, seed: options.seed, maxEpisodeSteps: 10_000,
    invalidActionMode: useMask ? 'reject' : 'transition',
    policyMetadata: { name: 'random-demo', version: '1', experimentTags: [useMask ? 'masked' : 'unmasked'] } });
  sessionId = batch.sessionId;
  const path = `/api/rl/sessions/${sessionId}`;
  console.log(JSON.stringify({ sessionId, envs: batch.numEnvs, mask: useMask, invalidActionMode: batch.invalidActionMode,
    gameId: batch.results[0].gameId,
    viewer: `${base}/game/index.html?session=${sessionId}&env=0`,
    history: `${base}/api/rl/history/sessions/${sessionId}/games` }));
  let attempts = 0, successfulPlacements = 0, invalidActions = 0, reward = 0, episodes = 0;
  const start = performance.now();
  for (let i = 0; i < options.batches && !stop; i++) {
    const finished = batch.results.filter(result => result.terminated || result.truncated).map(result => result.envId);
    if (finished.length) {
      episodes += finished.length;
      batch = await request(`${path}/reset`, { version: batch.version, envIds: finished });
    }
    const actions = batch.results.map(result => chooseAction(result.actionMask));
    batch = await request(`${path}/step`, { version: batch.version, actions });
    attempts += actions.length;
    successfulPlacements += batch.results.filter(result => result.info.actionValid === true).length;
    invalidActions += batch.results.filter(result => result.info.actionValid === false).length;
    reward += batch.results.reduce((sum, result) => sum + result.reward, 0);
    if ((i + 1) % 50 === 0 || i + 1 === options.batches) {
      const seconds = (performance.now() - start) / 1000;
      console.log(JSON.stringify({ batches: i + 1, attempts, successfulPlacements, invalidActions,
        invalidActionRate: invalidActions / attempts, episodes, reward,
        attemptsPerSecond: Math.round(attempts / seconds), placementsPerSecond: Math.round(successfulPlacements / seconds) }));
    }
    if (options['delay-ms']) await new Promise(resolve => setTimeout(resolve, options['delay-ms']));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try { await request(`/api/rl/sessions/${sessionId}`, undefined, 'DELETE'); }
    catch (error) { console.error(`Session cleanup: ${error.message}`); process.exitCode = 1; }
  }
}
