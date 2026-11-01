import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiError, createGameService } from '../app/api/_lib/service.js';
import { SHAPES } from '../public/game/shapes.js';
import { createSqliteStore } from './sqlite-store.mjs';
import { openapi } from './openapi.mjs';
import { createRlPool } from './rl/pool.mjs';
import { DEFAULT_WORKER_COUNT, MAX_ENVS } from './rl/protocol.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'local-player';
const MAX_BODY = 8192;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.ico':'image/x-icon' };

function json(response, status, value, headers={}) {
  const data = JSON.stringify(value);
  response.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(data),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});
  response.end(data);
}
function method(request, expected) {
  if (request.method !== expected) {
    const error = new ApiError(405, 'METHOD_NOT_ALLOWED', `${expected} 요청을 사용해주세요.`);
    error.allow = expected;
    throw error;
  }
}
async function body(request, url) {
  const origin = request.headers.origin;
  if (origin && origin !== url.origin) throw new ApiError(403,'INVALID_ORIGIN','같은 사이트에서 요청해주세요.');
  if (!(request.headers['content-type'] || '').toLowerCase().includes('application/json')) throw new ApiError(415,'JSON_REQUIRED','Content-Type: application/json으로 요청해주세요.');
  if (Number(request.headers['content-length'] || 0) > MAX_BODY) {
    request.resume();
    throw new ApiError(413,'BODY_TOO_LARGE','요청 본문이 너무 큽니다.');
  }
  const text = await new Promise((done, reject) => {
    const chunks = []; let bytes=0, failed=false;
    request.on('data', chunk => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY) { failed=true; reject(new ApiError(413,'BODY_TOO_LARGE','요청 본문이 너무 큽니다.')); }
      else chunks.push(chunk);
    });
    request.on('end', () => { if (!failed) done(Buffer.concat(chunks).toString('utf8')); });
    request.on('error', reject);
    request.on('aborted', () => reject(new ApiError(400,'REQUEST_ABORTED','요청이 중단되었습니다.')));
  });
  try { return JSON.parse(text); }
  catch { throw new ApiError(400,'INVALID_JSON','올바른 JSON을 보내주세요.'); }
}
function inside(directory, target) {
  const path = relative(directory, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

export function createApplication({dataDir, store: providedStore, gameDirectory=resolve(root,'public/game'), rlOptions={}}={}) {
  const rl = createRlPool({
    workerCount: Number(process.env.RL_WORKERS ?? DEFAULT_WORKER_COUNT),
    maxEnvs: Number(process.env.RL_MAX_ENVS ?? MAX_ENVS),
    maxPending: Number(process.env.RL_MAX_PENDING ?? 16),
    ...rlOptions,
  });
  const store = providedStore || createSqliteStore(dataDir);
  const games = createGameService(store);
  const server = createServer(async (request,response) => {
    try {
      let url;
      try { url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`); }
      catch { throw new ApiError(400,'INVALID_URL','올바른 URL을 사용해주세요.'); }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) throw new ApiError(400,'INVALID_URL','올바른 URL을 사용해주세요.');
      if (pathname === '/healthz') {
        method(request,'GET');
        let ok = false;
        try { ok = store.health(); } catch { /* Readiness is false while SQLite is unavailable. */ }
        return json(response,ok?200:503,{ok,service:'block-blast',storage:'sqlite'});
      }
      if (pathname === '/api/openapi.json') {
        method(request,'GET'); return json(response,200,openapi);
      }
      if (pathname === '/api/rl/stats') {
        method(request,'GET'); return json(response,200,await rl.stats());
      }
      if (pathname === '/api/rl/sessions') {
        if (request.method === 'GET') return json(response,200,{sessions:(await rl.stats()).sessions});
        method(request,'POST'); return json(response,201,await rl.create(await body(request,url)));
      }
      const rlRoute = /^\/api\/rl\/sessions\/([^/]+)(?:\/(step|reset|envs)(?:\/([^/]+))?)?$/.exec(pathname);
      if (rlRoute) {
        const [,sessionId,action,envId] = rlRoute;
        if (!action) {
          if (request.method === 'DELETE') {
            // Apply the same browser origin check as other mutations.
            const origin=request.headers.origin;
            if (origin && origin !== url.origin) throw new ApiError(403,'INVALID_ORIGIN','같은 사이트에서 요청해주세요.');
            return json(response,200,await rl.delete(sessionId));
          }
          method(request,'GET'); return json(response,200,await rl.get(sessionId));
        }
        if (action === 'envs' && envId !== undefined) {
          method(request,'GET');
          if (!/^(0|[1-9]\d{0,2})$/.test(envId) || Number(envId) >= MAX_ENVS) throw new ApiError(400,'INVALID_ENV_ID',`envId는 0~${MAX_ENVS - 1} 정수여야 합니다.`);
          return json(response,200,await rl.snapshot(sessionId,Number(envId)));
        }
        if ((action === 'step' || action === 'reset') && envId === undefined) {
          method(request,'POST'); return json(response,200,await rl[action](sessionId,await body(request,url)));
        }
        throw new ApiError(404,'ENDPOINT_NOT_FOUND','API를 찾을 수 없습니다.');
      }
      if (pathname === '/api/shapes') {
        method(request,'GET'); return json(response,200,{shapes:SHAPES,coordinates:'matrix[row][col], cells=[{x:col,y:row}], top-left origin',emptyBoardCell:-1,usedSlot:-1});
      }
      if (pathname === '/api/games') {
        method(request,'POST');
        const game = await games.create(OWNER,await body(request,url));
        store.setActiveGameId(game.id);
        return json(response,201,game);
      }
      if (pathname === '/api/state' || pathname === '/api/place') {
        method(request,pathname === '/api/state' ? 'GET' : 'POST');
        const activeId = store.getActiveGameId();
        if (!activeId) throw new ApiError(404,'NO_ACTIVE_GAME','진행 중인 게임이 없습니다. POST /api/games로 게임을 만들어주세요.');
        if (pathname === '/api/state') return json(response,200,await games.get(OWNER,activeId));
        const command = await body(request,url);
        if (command && typeof command === 'object' && command.gameId !== undefined && command.gameId !== activeId) {
          throw new ApiError(409,'ACTIVE_GAME_CHANGED','현재 게임이 변경되었습니다. 최신 상태를 조회해주세요.',await games.get(OWNER,activeId));
        }
        return json(response,200,await games.command(OWNER,activeId,'place',command));
      }
      const route = /^\/api\/games\/([^/]+)(?:\/(place|undo|reset))?$/.exec(pathname);
      if (route) {
        const [,id,action] = route;
        if (!action) { method(request,'GET'); return json(response,200,await games.get(OWNER,id)); }
        method(request,'POST'); return json(response,200,await games.command(OWNER,id,action,await body(request,url)));
      }
      if (pathname.startsWith('/api/')) throw new ApiError(404,'ENDPOINT_NOT_FOUND','API를 찾을 수 없습니다.');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const error = new ApiError(405,'METHOD_NOT_ALLOWED','GET 요청을 사용해주세요.'); error.allow='GET, HEAD'; throw error;
      }
      if (pathname === '/') { response.writeHead(302,{Location:'/game/index.html','Cache-Control':'no-store'}); return response.end(); }
      if (pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
      if (!pathname.startsWith('/game/')) throw new ApiError(404,'NOT_FOUND','페이지를 찾을 수 없습니다.');
      const asset = resolve(gameDirectory,pathname.slice('/game/'.length));
      if (!inside(gameDirectory,asset)) throw new ApiError(404,'NOT_FOUND','파일을 찾을 수 없습니다.');
      let file, info;
      try { file=await realpath(asset); info=await stat(file); }
      catch { throw new ApiError(404,'NOT_FOUND','파일을 찾을 수 없습니다.'); }
      if (!inside(await realpath(gameDirectory),file) || !info.isFile()) throw new ApiError(404,'NOT_FOUND','파일을 찾을 수 없습니다.');
      response.writeHead(200,{'Content-Type':MIME[extname(file)] || 'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      response.end(request.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof ApiError) return json(response,error.status,{...(error.snapshot || {}),error:{code:error.code,message:error.message}},error.allow?{Allow:error.allow}:error.status === 429?{'Retry-After':'1'}:{});
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 && typeof error.code === 'string') {
        return json(response,error.status,{error:{code:error.code,message:error.message}},error.status === 429 ? {'Retry-After':'1'} : {});
      }
      if (error instanceof URIError) return json(response,400,{error:{code:'INVALID_URL',message:'올바른 URL을 사용해주세요.'}});
      console.error('Game API request failed:', error instanceof Error ? error.message : 'Unknown error');
      json(response,500,{error:{code:'SERVER_ERROR',message:'게임을 불러오지 못했습니다. 잠시 뒤 다시 시도해주세요.'}});
    }
  });
  server.requestTimeout=30_000;
  server.headersTimeout=15_000;
  return { server, store, rl, async close() {
    // Terminate workers first so pending training requests fail promptly during shutdown.
    await rl.close();
    try {
      if (server.listening) await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));
    } finally { store.close(); }
  } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const host = process.env.HOST || '0.0.0.0';
  const app = createApplication({dataDir:process.env.DATA_DIR});
  app.server.listen(port,host,()=>console.log(`Block Blast listening on http://${host}:${port}`));
  app.server.on('error',error=>{console.error(error.message);app.store.close();process.exitCode=1;});
  let closing=false;
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
    if (closing) return; closing=true;
    const timer=setTimeout(()=>process.exit(1),10_000);timer.unref();
    app.close().then(()=>{clearTimeout(timer);process.exitCode=0;}).catch(error=>{console.error(error.message);process.exitCode=1;});
  });
}
