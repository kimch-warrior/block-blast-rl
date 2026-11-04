import { DEFAULT_NUM_ENVS, MAX_ENVS } from './rl/protocol.mjs';
import { rlHistoryPaths, rlHistorySchemas } from './rl-history-openapi.mjs';

const ref = name => ({$ref:`#/components/schemas/${name}`});
const jsonSchema = schema => ({'application/json':{schema}});
const sessionId = {name:'sessionId',in:'path',required:true,schema:{type:'string',format:'uuid'}};
const seed = {type:'integer',minimum:1,maximum:2147483646};
const version = {type:'integer',minimum:1,description:'Latest session version; mutations require it. Concurrent mutations return 409.'};
const requestId = {type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_.:-]+$',description:'Client-generated retry key. Reuse the same ID and identical payload after a lost response: the backend returns the original durable response even if its version is now stale. Changed payloads return 409 REQUEST_ID_CONFLICT. If omitted, a server-generated ID is returned.'};
const result = {description:'Current vector environment batch, ordered by envId',content:jsonSchema(ref('RlBatch'))};
const errors = Object.fromEntries([400,403,404,405,409,413,415,422,429,503].map(status=>[status,{
  description:({400:'Invalid parameters',403:'Cross-origin mutation',404:'Session or environment not found',405:'Wrong method',409:'Stale version, busy session, request ID payload conflict, or global environment limit',413:'Request exceeds 8192 bytes',415:'JSON required',422:'Illegal action or ended episode; no environment in the batch is advanced',429:'Worker pool admission limit reached; retry later',503:'Worker or recording storage failed; no successful response is issued and affected execution sessions are invalidated'})[status],
  content:jsonSchema(ref('Error')),
}]));
const mutation = (summary,properties,required=[]) => ({summary,parameters:[sessionId],
  requestBody:{required:true,content:jsonSchema({type:'object',required:['version',...required],properties:{version,requestId,...properties}})},
  responses:{200:result,...errors},
});

export const rlPaths = {
  ...rlHistoryPaths,
  '/api/rl/stats':{get:{summary:'Read CPU worker thread IDs, load and environment limits',responses:{200:{description:'Worker pool statistics',content:jsonSchema({type:'object'})}}}},
  '/api/rl/sessions':{
    get:{summary:'List in-memory training session metadata',responses:{200:{description:'Sessions',content:jsonSchema({type:'object',properties:{sessions:{type:'array',items:{type:'object'}}}})}}},
    post:{summary:`Create independently seeded environments and durable game headers; global cap ${MAX_ENVS}`,requestBody:{required:true,content:jsonSchema({type:'object',properties:{numEnvs:{type:'integer',minimum:1,maximum:MAX_ENVS,default:DEFAULT_NUM_ENVS},seed,requestId,policyMetadata:ref('RlPolicyMetadata'),maxEpisodeSteps:{type:'integer',minimum:1,maximum:10000000,default:10000},invalidActionMode:{type:'string',enum:['reject','transition'],default:'reject',description:'reject: illegal placement returns 422 without advancing the batch. transition: illegal placement consumes one episode attempt, preserves the board, and returns actionValid=false with scoreDelta=0; the learner chooses any penalty.'}}})},responses:{201:result,...errors}},
  },
  '/api/rl/sessions/{sessionId}':{
    get:{summary:'Read the latest vector batch without advancing games',parameters:[sessionId],responses:{200:result,...errors}},
    delete:{summary:'Close active games as session_closed and release execution capacity; saved records remain available',parameters:[sessionId],responses:{200:{description:'Execution session deleted; durable history retained'},...errors}},
  },
  '/api/rl/sessions/{sessionId}/step':{post:mutation('Advance one action per environment; malformed actions always reject the complete batch, illegal placements follow invalidActionMode',{
    actions:{type:'array',minItems:1,maxItems:MAX_ENVS,description:'Exactly numEnvs entries in envId order. Integer action = slot*64 + row*8 + col. null skips an environment. No automatic reset.',items:{type:['integer','null'],minimum:0,maximum:191}},
  },['actions'])},
  '/api/rl/sessions/{sessionId}/reset':{post:mutation('Close active games as manual_reset and create new game IDs; explicit seed reproduces initial boards',{
    envIds:{type:'array',minItems:1,maxItems:MAX_ENVS,uniqueItems:true,items:{type:'integer',minimum:0,maximum:MAX_ENVS - 1},description:'Omit to reset every environment. Episode IDs and environment versions increase.'},seed,
  })},
  '/api/rl/sessions/{sessionId}/envs/{envId}':{get:{summary:'Debug snapshot for the read-only game viewer; includes internal state, unsuitable as policy input',parameters:[sessionId,{name:'envId',in:'path',required:true,schema:{type:'integer',minimum:0,maximum:MAX_ENVS - 1}}],responses:{200:{description:'Game viewer snapshot',content:jsonSchema(ref('Snapshot'))},...errors}}},
};

export const rlSchemas = {
  ...rlHistorySchemas,
  RlObservation:{type:'object',required:['board','tray','score','combo','unEliminateTimes','round','moves'],description:'Policy input. Internal RNG state and display colors are excluded.',properties:{
    board:{type:'array',minItems:8,maxItems:8,items:{type:'array',minItems:8,maxItems:8,items:{type:'integer',enum:[0,1]}},description:'board[row][col]: 0 empty, 1 occupied'},
    tray:{type:'array',minItems:3,maxItems:3,items:{type:'integer',minimum:-1,maximum:51},description:'Shape IDs; -1 for a consumed slot. Catalogue at /api/shapes.'},
    score:{type:'integer',minimum:0},combo:{type:'integer',minimum:0},unEliminateTimes:{type:'integer',minimum:0},round:{type:'integer',minimum:1},moves:{type:'integer',minimum:0},
  }},
  RlResult:{type:'object',required:['gameId','envId','episodeId','version','observation','actionMask','reward','terminated','truncated','info'],properties:{
    gameId:{type:'string',format:'uuid',description:'Stable for one game. Reset creates a new ID; use (sessionId,gameId) as the history key, never the viewer snapshot id.'},envId:{type:'integer',minimum:0,maximum:MAX_ENVS - 1},episodeId:{type:'integer'},version,
    observation:ref('RlObservation'),actionMask:{type:'array',minItems:192,maxItems:192,items:{type:'integer',enum:[0,1]},description:'Only action indices with value 1 may be placed.'},
    reward:{type:'number',description:'Default reward equals info.scoreDelta. The learner can transform this separately. Skipped environments reward 0.'},
    terminated:{type:'boolean',description:'No legal placement remains.'},truncated:{type:'boolean',description:'Episode attempt limit reached without game over. Reset explicitly.'},info:{type:'object',properties:{scoreDelta:{type:'number',description:'Raw increase in game score for this transition, independent of learner reward shaping.'},actionValid:{type:['boolean','null'],description:'true for a successful placement, false for an illegal placement transition, null on reset or skip.'},invalidActionReason:{type:['string','null'],enum:['illegal_placement',null]},episodeSteps:{type:'integer',minimum:0,description:'Includes unsuccessful attempts in transition mode.'}}},
  }},
  RlBatch:{type:'object',required:['sessionId','version','numEnvs','results'],properties:{
    sessionId:{type:'string',format:'uuid'},requestId,version,numEnvs:{type:'integer',minimum:1,maximum:MAX_ENVS},maxEpisodeSteps:{type:'integer',minimum:1},invalidActionMode:{type:'string',enum:['reject','transition']},policyMetadata:ref('RlPolicyMetadata'),
    engineRulesVersion:{type:'string',const:'reconstruction-v1'},scoreRulesVersion:{type:'integer',const:2},
    results:{type:'array',minItems:1,maxItems:MAX_ENVS,items:ref('RlResult')},
  }},
};
