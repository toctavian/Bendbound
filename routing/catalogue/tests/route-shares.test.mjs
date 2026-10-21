import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createShareStore, validateSharedRoute, shareLanding, association } from '../service/route-shares.mjs';
import { createServer } from '../service/server.mjs';
const a={latitude:51.5,longitude:-0.1},b={latitude:51.51,longitude:-0.11};
const payload={version:1,avoidMotorways:true,route:{title:'A ride',profile:'winding',route:[a,b],distanceKm:2,durationMin:4,curves:1,
  stops:[{...b,id:'first',name:'First'},{...a,id:'second',name:'Return'}],maneuvers:[{type:1,instruction:'Continue',beginShapeIndex:0,endShapeIndex:1}]}};
test('shared snapshots preserve exact geometry and ordered stops, stripping non-planning data',()=>{
 assert.deepEqual(validateSharedRoute({...payload,token:'secret',route:{...payload.route,recording:{active:true}}}),payload);
 for(const bad of [{...payload,version:2},{...payload,route:{...payload.route,route:[a]}},{...payload,route:{...payload.route,stops:[{...b,id:'x',name:''}]}},{...payload,route:{...payload.route,maneuvers:[{...payload.route.maneuvers[0],endShapeIndex:20}]}}])assert.throws(()=>validateSharedRoute(bad));
});
test('links survive store restart, expire explicitly, resist path traversal, and have a storage cap',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'bendbound-shares-'));let now=Date.now();
 try{
  const make=()=>createShareStore({directory,now:()=>now,ttlMs:10000});
  const share=await make().create(payload);assert.match(share.id,/^[a-f0-9]{32}$/);
  assert.deepEqual(await make().get(share.id),payload);
  await assert.rejects(make().get('../credentials'),e=>e.status===404);
  now+=10001;await assert.rejects(make().get(share.id),e=>e.status===410);
  await assert.rejects(createShareStore({directory,maxBytes:1}).create(payload),e=>e.status===503);
  assert.ok(shareLanding(share.id).includes(`bendbound://shared/${share.id}`));
  assert.deepEqual(association.applinks.details[0].paths,['/shared/*']);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('HTTP sharing returns a retrievable snapshot, public landing and iOS association without invoking routing',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'bendbound-share-api-'));
 const server=createServer({shares:createShareStore({directory}),engine:()=>{throw Error('Unexpected routing');},log:()=>{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const response=await fetch(`${base}/shared-routes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.equal(response.status,201);const {id}=await response.json();
  assert.deepEqual(await (await fetch(`${base}/shared-routes/${id}`)).json(),payload);
  const landing=await fetch(`${base}/shared/${id}`);assert.equal(landing.status,200);assert.match(await landing.text(),/Open in Bendbound/);
  assert.deepEqual(await (await fetch(`${base}/.well-known/apple-app-site-association`)).json(),association);
  assert.equal((await fetch(`${base}/shared-routes/${'f'.repeat(32)}`)).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
