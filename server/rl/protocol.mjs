export const ENGINE_RULES_VERSION = 'reconstruction-v1';
export const SCORE_RULES_VERSION = 2;
export const ACTION_COUNT = 3 * 8 * 8;
export const MAX_SEED = 2147483646;
export const DEFAULT_NUM_ENVS = 256;
export const MAX_ENVS = 512;
export const DEFAULT_WORKER_COUNT = 4;

// Per-environment streams depend on logical IDs, never on worker assignment.
// Integer arithmetic stays below Number.MAX_SAFE_INTEGER for supported IDs.
export function episodeSeed(baseSeed, envId, episodeId) {
  let value = (baseSeed - 1 + (envId + 1) * 104729) % MAX_SEED;
  value = (value + (episodeId % MAX_SEED) * 13007) % MAX_SEED;
  return value + 1;
}

export const rulesVersions = Object.freeze({
  engineRulesVersion: ENGINE_RULES_VERSION,
  scoreRulesVersion: SCORE_RULES_VERSION,
});
