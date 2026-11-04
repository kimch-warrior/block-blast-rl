import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const END_REASONS = new Set(['game_over', 'max_episode_steps', 'manual_reset', 'session_closed', 'interrupted']);

export function historyError(status, code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { status, code });
}

export function validateIdentifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw historyError(400, 'INVALID_HISTORY_ID', '기록 식별자가 올바르지 않습니다.');
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function stateDigest(state) {
  return createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
}

export function decodeGameRow(row) {
  if (!row) return null;
  return {
    ...JSON.parse(row.header_json),
    status: row.status,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    attemptCount: row.attempt_count,
    placementCount: row.placement_count,
    terminated: Boolean(row.terminated),
    truncated: Boolean(row.truncated),
    latestState: JSON.parse(row.latest_state_json),
    finalState: row.final_state_json ? JSON.parse(row.final_state_json) : null,
  };
}
