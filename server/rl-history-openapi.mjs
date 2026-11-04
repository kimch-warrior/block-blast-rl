const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = schema => ({ 'application/json': { schema } });
const sessionId = { name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const gameId = { name: 'gameId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const pagination = defaultLimit => [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: defaultLimit } },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
];
const error = description => ({ description, content: json(ref('Error')) });
const errors = { 400: error('Invalid identifiers or pagination'), 404: error('Saved session or game not found'), 405: error('Use GET for history endpoints'), 503: error('Recording storage or replay worker unavailable') };
const page = item => ({ type: 'object', required: ['items', 'total', 'limit', 'offset', 'hasMore'], properties: {
  items: { type: 'array', items: item }, total: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 1000 }, offset: { type: 'integer', minimum: 0 }, hasMore: { type: 'boolean' },
} });
const endReason = { type: ['string', 'null'], enum: [null, 'game_over', 'max_episode_steps', 'manual_reset', 'session_closed', 'interrupted'] };
const timestamp = { type: 'string', format: 'date-time' };

export const rlHistoryPaths = {
  '/api/rl/history/sessions': { get: {
    summary: 'List durable session records independently of active execution sessions',
    parameters: pagination(50), responses: { 200: { description: 'Saved sessions', content: json(page(ref('RlRecordedSession'))) }, ...errors },
  } },
  '/api/rl/history/sessions/{sessionId}/games': { get: {
    summary: 'List all saved games, including games replaced by reset',
    parameters: [sessionId, ...pagination(50)], responses: { 200: { description: 'Saved game summaries; fetch an individual game for its reproduction header', content: json(page(ref('RlRecordedGameSummary'))) }, ...errors },
  } },
  '/api/rl/history/sessions/{sessionId}/games/{gameId}': { get: {
    summary: 'Read immutable reproduction metadata and the latest or completed result',
    parameters: [sessionId, gameId], responses: { 200: { description: 'Saved game without its step array', content: json(ref('RlRecordedGame')) }, ...errors },
  } },
  '/api/rl/history/sessions/{sessionId}/games/{gameId}/steps': { get: {
    summary: 'Read accepted actions in zero-based step order; null skips and rejected requests are absent',
    parameters: [sessionId, gameId, ...pagination(100)], responses: { 200: { description: 'Ordered saved actions', content: json(page(ref('RlRecordedStep'))) }, ...errors },
  } },
  '/api/rl/history/sessions/{sessionId}/games/{gameId}/replay': { get: {
    summary: 'Reconstruct a saved game from its captured initial seed and actions and verify the result',
    description: 'This operation validates replay; it does not restore an active environment or continue execution.',
    parameters: [sessionId, gameId], responses: {
      200: { description: 'Replay matches the saved state', content: json(ref('RlReplayResult')) },
      409: error('UNSUPPORTED_RULES: recorded schema or rule versions are not supported by this engine'),
      422: error('Replay data or the reconstructed state does not match the saved record'),
      429: error('REPLAY_OVERLOADED: all replay workers are busy; retry later'), ...errors,
    },
  } },
};

export const rlHistorySchemas = {
  RlPolicyMetadata: { type: 'object', description: 'Caller-supplied JSON metadata, stored with the session and each new game, outside policy observations. Weights identify a checkpoint or hash; the backend does not download or load them.', properties: {
    name: { type: 'string' }, version: { type: 'string' },
    weights: { anyOf: [{ type: 'string' }, { type: 'object', properties: { checkpoint: { type: 'string' }, sha256: { type: 'string' } } }] },
    experimentTags: { type: 'array', items: { type: 'string' } },
  }, additionalProperties: true },
  RlRecordedSession: { type: 'object', required: ['sessionId', 'baseSeed', 'startedAt'], properties: {
    sessionId: { type: 'string', format: 'uuid' }, baseSeed: { type: 'integer' }, numEnvs: { type: 'integer', minimum: 1, maximum: 512 },
    maxEpisodeSteps: { type: 'integer', minimum: 1 }, invalidActionMode: { type: 'string', enum: ['reject', 'transition'] },
    policyMetadata: ref('RlPolicyMetadata'), startedAt: timestamp, updatedAt: timestamp,
    endedAt: { type: ['string', 'null'], format: 'date-time' }, status: { type: 'string' },
  } },
  RlRecordedGameSummary: { type: 'object', required: ['sessionId', 'gameId', 'envId', 'episodeId', 'status', 'startedAt', 'endedAt', 'endReason', 'attemptCount', 'placementCount', 'score', 'combo'], properties: {
    sessionId: { type: 'string', format: 'uuid' }, gameId: { type: 'string', format: 'uuid' },
    envId: { type: 'integer', minimum: 0, maximum: 511 }, episodeId: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: ['in_progress', 'finished'] }, startedAt: timestamp,
    endedAt: { type: ['string', 'null'], format: 'date-time' }, endReason,
    attemptCount: { type: 'integer', minimum: 0 }, placementCount: { type: 'integer', minimum: 0 },
    score: { type: 'integer', minimum: 0 }, combo: { type: 'integer', minimum: 0 },
  } },
  RlRecordedGame: { type: 'object', required: ['schemaVersion', 'sessionId', 'gameId', 'envId', 'episodeId', 'baseSeed', 'initialGameSeed', 'initialState', 'startedAt', 'status', 'attemptCount', 'placementCount'], properties: {
    schemaVersion: { type: 'integer', const: 1 }, sessionId: { type: 'string', format: 'uuid' }, gameId: { type: 'string', format: 'uuid' },
    envId: { type: 'integer', minimum: 0, maximum: 511 }, episodeId: { type: 'integer', minimum: 0 },
    baseSeed: { type: 'integer', description: 'Original seed supplied when creating the execution session.' },
    gameBaseSeed: { type: 'integer', description: 'Seed basis used for this game, which can differ after an explicit reset.' },
    initialGameSeed: { type: 'integer', description: 'Exact createGame argument captured when the game was created. Never inferred later from state.seed or episodeId.' },
    initialState: ref('State'), engineRulesVersion: { type: 'string' }, scoreRulesVersion: { type: 'integer' },
    execution: { type: 'object', properties: { maxEpisodeSteps: { type: 'integer' }, invalidActionMode: { type: 'string', enum: ['reject', 'transition'] } } },
    policyMetadata: ref('RlPolicyMetadata'), startedAt: timestamp, endedAt: { type: ['string', 'null'], format: 'date-time' },
    status: { type: 'string', enum: ['in_progress', 'finished'] }, endReason,
    attemptCount: { type: 'integer', minimum: 0 }, placementCount: { type: 'integer', minimum: 0 },
    latestState: ref('State'), finalState: { anyOf: [ref('State'), { type: 'null' }] }, terminated: { type: 'boolean' }, truncated: { type: 'boolean' },
  } },
  RlRecordedStep: { type: 'object', required: ['step', 'requestId', 'action', 'slot', 'blockId', 'x', 'y', 'actionValid', 'scoreDelta', 'scoreAfter', 'comboAfter', 'clearedRows', 'clearedCols', 'refilled', 'trayAfter'], properties: {
    step: { type: 'integer', minimum: 0 }, requestId: { type: 'string' }, action: { type: 'integer', minimum: 0, maximum: 191 },
    slot: { type: 'integer', minimum: 0, maximum: 2 }, blockId: { type: 'integer', description: 'Read from tray[slot] before this action; -1 can occur for an illegal attempt on an already used slot.' },
    x: { type: 'integer', minimum: 0, maximum: 7, description: 'Zero-based column of the block matrix top-left anchor.' },
    y: { type: 'integer', minimum: 0, maximum: 7, description: 'Zero-based row of the block matrix top-left anchor.' },
    actionValid: { type: 'boolean' }, scoreDelta: { type: 'number' }, scoreAfter: { type: 'integer' }, comboAfter: { type: 'integer' },
    clearedRows: { type: 'array', items: { type: 'integer' } }, clearedCols: { type: 'array', items: { type: 'integer' } }, refilled: { type: 'boolean' },
    trayAfter: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'integer' } },
    scoreBreakdown: { type: 'object', properties: { placement: { type: 'integer' }, elimination: { type: 'integer' }, allClear: { type: 'integer' } } },
    stateHashAfter: { type: 'string' }, appliedAt: timestamp,
  } },
  RlReplayResult: { type: 'object', required: ['valid', 'sessionId', 'gameId', 'attemptCount', 'placementCount', 'state', 'terminated', 'truncated'], properties: {
    valid: { type: 'boolean', const: true }, sessionId: { type: 'string', format: 'uuid' }, gameId: { type: 'string', format: 'uuid' },
    attemptCount: { type: 'integer', minimum: 0 }, placementCount: { type: 'integer', minimum: 0 },
    state: ref('State'), terminated: { type: 'boolean' }, truncated: { type: 'boolean' }, stateHash: { type: 'string' },
  } },
};
