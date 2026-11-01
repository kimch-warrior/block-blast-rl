import { rlPaths, rlSchemas } from './rl-openapi.mjs';

const state = {
  type: 'object', required: ['board','tray','colors','score','combo','unEliminateTimes','scoreRulesVersion','moves','lines','round','seed'],
  properties: {
    board: { type: 'array', minItems: 8, maxItems: 8, description: 'board[row][col], top-left origin. -1 empty; other integer values occupied.',
      items: { type: 'array', minItems: 8, maxItems: 8, items: { type: 'integer' } } },
    tray: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'integer' }, description: 'Shape IDs [left,center,right]; -1 used.' },
    colors: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'integer', minimum: 1, maximum: 7 } },
    score: { type: 'integer', description: 'Placement cells + original-default elimination bonus + eligible 300-point all-clear bonus.' },
    combo: { type: 'integer', description: 'Internal multiplier C. A clearing move increments it; one or two non-clears preserve it, the third resets it. Original displayed combo count is C-1.' },
    unEliminateTimes: { type: 'integer', minimum: 0, description: 'Consecutive non-clearing placements.' },
    scoreRulesVersion: { type: 'integer', const: 2, description: 'Block Blast 10.9.3 baseline Classic scoring after the tutorial; runtime trait overrides are not reproduced.' },
    scoreMigration: { type: 'object', description: 'Present on games upgraded from the earlier simplified scoring. Complete histories are recalculated; incomplete histories carry their accumulated score forward.' },
    moves: { type: 'integer' }, lines: { type: 'integer' },
    round: { type: 'integer' }, seed: { type: 'integer' },
  },
};
const version = { type: 'integer', minimum: 1, description: 'Latest snapshot.version. Stale versions return 409 with the current snapshot.' };
const requestId = { type: 'string', maxLength: 128, description: 'Optional retry ID for the latest successful command.' };
const seed = { type: 'integer', minimum: 1, maximum: 2147483646 };
const result = { description: 'Current authoritative game snapshot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Snapshot' } } } };
const errors = Object.fromEntries([400,403,404,405,409,413,415,422,500].map(code => [String(code), {
  description: ({400:'Invalid JSON or parameters',403:'Cross-origin browser write rejected',404:'Game or endpoint not found',405:'Method not allowed',409:'Version or request ID conflict',413:'Body larger than 8192 bytes',415:'JSON content type required',422:'Illegal move or no undo',500:'Temporary server error'})[code],
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
}]));
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const command = (summary, extra, required=[]) => ({ summary, parameters: [id],
  requestBody: { required: true, content: { 'application/json': { schema: { type:'object', required:['version',...required], properties:{version,requestId,...extra} } } } },
  responses: {200:result,...errors},
});

export const openapi = {
  openapi:'3.1.0', info:{title:'Block Blast Local Game API',version:'1.2.0',
    description:'Shared local game API. No sign-in or API key is required. Browser and container clients using the same game ID share SQLite-backed state. Intended for the local Docker network. This API does not access the original Android game. Indexes are zero-based.'},
  servers:[{url:'/'}],
  paths:{
    ...rlPaths,
    '/healthz':{get:{summary:'Read server and SQLite readiness',responses:{200:{description:'Ready'},503:{description:'Database unavailable'}}}},
    '/api/games':{post:{summary:'Create a new game',requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{seed}}}}},responses:{201:result,...errors}}},
    '/api/state':{get:{summary:'Read the shared active game without knowing its ID; returns 404 NO_ACTIVE_GAME until a game is created',responses:{200:result,...errors}}},
    '/api/place':{post:{summary:'Place a block in the shared active game',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['version','slot','row','col'],properties:{version,requestId,gameId:{type:'string',description:'Optional expected active game ID. If another client creates a new active game, returns 409 ACTIVE_GAME_CHANGED.'},slot:{type:'integer',minimum:0,maximum:2},row:{type:'integer',minimum:0,maximum:7},col:{type:'integer',minimum:0,maximum:7}}}}}},responses:{200:result,...errors}}},
    '/api/games/{id}':{get:{summary:'Read current board, offered blocks, score and legal moves',parameters:[id],responses:{200:result,...errors}}},
    '/api/games/{id}/place':{post:command('Place a block from the selected tray slot',{slot:{type:'integer',minimum:0,maximum:2},row:{type:'integer',minimum:0,maximum:7},col:{type:'integer',minimum:0,maximum:7}},['slot','row','col'])},
    '/api/games/{id}/undo':{post:command('Undo the last move, with up to 20 moves retained',{})},
    '/api/games/{id}/reset':{post:command('Reset the board under the same game ID',{seed})},
    '/api/shapes':{get:{summary:'Read all 51 ordinary block shapes',responses:{200:{description:'Shape catalogue'}}}},
  },
  components:{schemas:{...rlSchemas,State:state,Snapshot:{type:'object',required:['id','version','state','gameOver','canUndo','legalMoves'],properties:{
    id:{type:'string'},version,state:{$ref:'#/components/schemas/State'},gameOver:{type:'boolean'},canUndo:{type:'boolean'},
    legalMoves:{type:'array',items:{type:'object',properties:{slot:{type:'integer'},id:{type:'integer'},positions:{type:'array',items:{type:'object',properties:{row:{type:'integer'},col:{type:'integer'}}}}}}},
    lastMove:{type:['object','null'],properties:{slot:{type:'integer'},row:{type:'integer'},col:{type:'integer'},points:{type:'integer'},clearedRows:{type:'array',items:{type:'integer'}},clearedCols:{type:'array',items:{type:'integer'}},refilled:{type:'boolean'},clearScreen:{type:'boolean'},clearScreenBonus:{type:'integer'},scoreBreakdown:{type:'object',required:['placement','elimination','allClear'],properties:{placement:{type:'integer'},elimination:{type:'integer'},allClear:{type:'integer'}}}}},updatedAt:{type:'string',format:'date-time'},
  }},Error:{type:'object',required:['error'],description:'409 and 422 may also include the latest snapshot at the top level.',properties:{error:{type:'object',required:['code','message'],properties:{code:{type:'string'},message:{type:'string'}}}}}}},
};
