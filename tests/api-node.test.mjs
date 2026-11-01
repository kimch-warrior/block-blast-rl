import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createApplication } from '../server/index.mjs';

const tempRoot=resolve('outputs/node-api-tests');
async function directory(context) {
  await mkdir(tempRoot,{recursive:true});
  const path=await mkdtemp(`${tempRoot}/run-`);
  context.after(async()=>{
    // Recursive cleanup is limited to the exact test-owned directory.
    const absolute=resolve(path);
    assert.equal(dirname(absolute),tempRoot);assert.ok(basename(absolute).startsWith('run-'));
    await rm(absolute,{recursive:true,force:true});
  });
  return path;
}
async function start(dataDir) {
  const app=createApplication({dataDir});
  await new Promise((done,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',done);});
  return {app,origin:`http://127.0.0.1:${app.server.address().port}`};
}
async function request(origin,path,data,options={}) {
  const response=await fetch(new URL(path,origin),{
    method:data===undefined?'GET':'POST',redirect:'manual',
    headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),
    ...options,
  });
  let body=null;
  try {body=await response.json();}catch{}
  return {status:response.status,body,response};
}
const firstMove=game=>{
  const slot=game.legalMoves.find(s=>s.positions.length);
  return {slot:slot.slot,...slot.positions[0]};
};

test('dependency-free local server serves health, assets and API without a sign-in',async context=>{
  const dir=await directory(context),{app,origin}=await start(dir);
  try {
    const health=await request(origin,'/healthz');
    assert.equal(health.status,200);assert.deepEqual(health.body,{ok:true,service:'block-blast',storage:'sqlite'});
    const emptyActive=await request(origin,'/api/state');assert.equal(emptyActive.status,404);assert.equal(emptyActive.body.error.code,'NO_ACTIVE_GAME');
    const root=await request(origin,'/');assert.equal(root.status,302);assert.equal(root.response.headers.get('location'),'/game/index.html');
    const html=await fetch(`${origin}/game/index.html`);assert.equal(html.status,200);assert.match(await html.text(),/id="board"/);
    const script=await fetch(`${origin}/game/app.js`);assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);
    const head=await fetch(`${origin}/game/styles.css`,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    const shapes=await request(origin,'/api/shapes');assert.equal(shapes.status,200);assert.equal(shapes.body.shapes.length,51);
    const docs=await request(origin,'/api/openapi.json');assert.equal(docs.status,200);assert.equal(docs.body.openapi,'3.1.0');
    assert.match(docs.body.info.description,/No sign-in or API key/);assert.ok(docs.body.paths['/healthz']);
    const game=await request(origin,'/api/games',{seed:123});assert.equal(game.status,201);assert.equal(game.body.version,1);
    assert.deepEqual((await request(origin,`/api/games/${game.body.id}`)).body,game.body);
    assert.deepEqual((await request(origin,'/api/state')).body,game.body);
  } finally {await app.close();}
});

test('HTTP placement, idempotency, version conflicts, concurrent writes, undo and reset share SQLite state',async context=>{
  const dir=await directory(context),{app,origin}=await start(dir);
  try {
    const initial=(await request(origin,'/api/games',{seed:123})).body;
    const move={...firstMove(initial),version:1,requestId:'first-move'};
    const placed=await request(origin,`/api/games/${initial.id}/place`,move);
    assert.equal(placed.status,200);assert.equal(placed.body.version,2);assert.equal(placed.body.state.moves,1);
    assert.deepEqual((await request(origin,`/api/games/${initial.id}/place`,move)).body,placed.body);
    const stale=await request(origin,`/api/games/${initial.id}/place`,{...move,requestId:'different'});
    assert.equal(stale.status,409);assert.equal(stale.body.version,2);assert.equal(stale.body.error.code,'VERSION_CONFLICT');
    const consumed=await request(origin,`/api/games/${initial.id}/place`,{slot:move.slot,row:0,col:0,version:2});
    assert.equal(consumed.status,422);assert.equal(consumed.body.error.code,'ILLEGAL_MOVE');
    const nextMove={...firstMove(placed.body),version:2};
    const results=await Promise.all([
      request(origin,`/api/games/${initial.id}/place`,{...nextMove,requestId:'concurrent-a'}),
      request(origin,`/api/games/${initial.id}/place`,{...nextMove,requestId:'concurrent-b'}),
    ]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    assert.equal(results.find(r=>r.status===200).body.state.moves,2);
    const undone=await request(origin,`/api/games/${initial.id}/undo`,{version:3});
    assert.equal(undone.status,200);assert.equal(undone.body.version,4);assert.deepEqual(undone.body.state,placed.body.state);
    const reset=await request(origin,`/api/games/${initial.id}/reset`,{version:4,seed:123});
    assert.equal(reset.status,200);assert.equal(reset.body.version,5);assert.deepEqual(reset.body.state,initial.state);assert.equal(reset.body.canUndo,false);
  } finally {await app.close();}
});

test('game state survives a complete Node server and SQLite connection restart',async context=>{
  const dir=await directory(context);
  let running=await start(dir),saved;
  try {
    const created=(await request(running.origin,'/api/games',{seed:777})).body;
    saved=(await request(running.origin,`/api/games/${created.id}/place`,{...firstMove(created),version:1})).body;
  } finally {await running.app.close();}
  running=await start(dir);
  try {
    const loaded=await request(running.origin,`/api/games/${saved.id}`);
    assert.equal(loaded.status,200);assert.deepEqual(loaded.body,saved);
    assert.deepEqual((await request(running.origin,'/api/state')).body,saved);
    const undone=await request(running.origin,`/api/games/${saved.id}/undo`,{version:saved.version});
    assert.equal(undone.status,200);assert.equal(undone.body.state.moves,0);
  } finally {await running.app.close();}
});

test('active-game aliases follow newly created games and can reject a changed game ID',async context=>{
  const dir=await directory(context),{app,origin}=await start(dir);
  try {
    const first=(await request(origin,'/api/games',{seed:12})).body;
    const moved=await request(origin,'/api/place',{version:first.version,gameId:first.id,...firstMove(first)});
    assert.equal(moved.status,200);assert.equal(moved.body.id,first.id);assert.equal(moved.body.version,2);
    assert.deepEqual((await request(origin,'/api/state')).body,moved.body);
    const second=(await request(origin,'/api/games',{seed:34})).body;
    assert.equal((await request(origin,'/api/state')).body.id,second.id);
    const oldTarget=await request(origin,'/api/place',{version:1,gameId:first.id,...firstMove(second)});
    assert.equal(oldTarget.status,409);assert.equal(oldTarget.body.error.code,'ACTIVE_GAME_CHANGED');assert.equal(oldTarget.body.id,second.id);
    assert.equal((await request(origin,`/api/games/${first.id}`)).body.version,2);
    const current=await request(origin,'/api/place',{version:second.version,...firstMove(second)});
    assert.equal(current.status,200);assert.equal(current.body.id,second.id);
    assert.equal(current.body.state.moves,1);
  } finally {await app.close();}
});

test('Node API validates methods, payloads, origins and static traversal',async context=>{
  const dir=await directory(context),{app,origin}=await start(dir);
  try {
    const wrongMethod=await request(origin,'/api/games');assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.response.headers.get('allow'),'POST');
    const missing=await request(origin,'/api/games/not-found');assert.equal(missing.status,404);
    assert.equal((await request(origin,'/api/games',{seed:0})).status,400);
    assert.equal((await request(origin,'/api/games',undefined,{method:'POST',body:'{}',headers:{'Content-Type':'text/plain'}})).status,415);
    assert.equal((await request(origin,'/api/games',undefined,{method:'POST',body:'{',headers:{'Content-Type':'application/json'}})).status,400);
    assert.equal((await request(origin,'/api/games',{seed:123},{headers:{'Content-Type':'application/json',Origin:'https://other.invalid'}})).status,403);
    assert.equal((await request(origin,'/api/games',undefined,{method:'POST',body:JSON.stringify({padding:'a'.repeat(9000)}),headers:{'Content-Type':'application/json'}})).status,413);
    const traversal=await fetch(`${origin}/game/..%2f..%2fpackage.json`);assert.equal(traversal.status,404);
    const backslash=await fetch(`${origin}/game/%5cpackage.json`);assert.equal(backslash.status,400);
    const malformed=await fetch(`${origin}/game/%ZZ`);assert.equal(malformed.status,400);
    // Validation failures leave the server healthy and reusable.
    assert.equal((await request(origin,'/healthz')).status,200);
  } finally {await app.close();}
});
