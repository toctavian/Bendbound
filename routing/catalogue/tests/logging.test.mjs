import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createServer } from '../service/server.mjs';
import { RoutingError } from '../../service/engine.mjs';
import { diagnosticSummary, requestLog } from '../service/logging.mjs';
import { EventEmitter } from 'node:events';
import { decodePolyline } from '../../service/geometry.mjs';

const input={center:{latitude:51.487429,longitude:-0.020573},targetKm:40,direction:180,profile:'winding',avoidMotorways:true};
async function start(t,options) {
  const records=[];
  const server=createServer({...options,log:row=>records.push(row)});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {records,base:`http://127.0.0.1:${server.address().port}`};
}
test('routing failure is reproducible and shares a server-generated reference with the app',async t=>{
  const secret='sensitive-canary';
  const {records,base}=await start(t,{plan:async()=>{throw new RoutingError('NO_MATCH','No loop.',422,{
    elapsedMs:12,attempts:[{reason:'POLICY',sharedAccessKm:0.9,remainingRepeatedRatio:0.02,message:secret,
      diagnostics:{attempts:[{distanceKm:41,code:'NO_MATCH',headers:{Authorization:secret}}]}}],
    encoded_polyline:secret,
  });}});
  const response=await fetch(base+'/round-trip?token='+secret,{method:'POST',headers:{'Content-Type':'application/json',Authorization:secret,'X-Request-Id':secret},body:JSON.stringify({...input,token:secret,route:secret})});
  const body=await response.json();await new Promise(setImmediate);
  assert.equal(response.status,422);
  assert.match(body.requestId,/^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get('x-request-id'),body.requestId);
  assert.ok(body.message.includes(body.requestId));
  const completed=records.find(r=>r.event==='request.completed');
  assert.equal(completed.requestId,body.requestId);
  assert.equal(completed.status,422);assert.equal(completed.code,'NO_MATCH');
  assert.deepEqual(completed.input,input);
  assert.equal(completed.diagnostics.attempts[0].sharedAccessKm,0.9);
  assert.equal(completed.diagnostics.attempts[0].diagnostics.attempts[0].distanceKm,41);
  assert.ok(completed.durationMs>=0);
  assert.equal(JSON.stringify(records).includes(secret),false);
});
test('successful requests log timing and planner metrics without GPS or road geometry',async t=>{
  const {records,base}=await start(t,{plan:async()=>({planner:{valid:true,distanceKm:38.917,attempts:5,remainingRepeatedRatio:0,roads:[{geometry:'sensitive-canary'}]},trip:{status:0}})});
  const response=await fetch(base+'/round-trip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  await response.json();await new Promise(setImmediate);
  const completed=records.find(r=>r.event==='request.completed');
  assert.equal(completed.status,200);assert.equal(completed.planner.distanceKm,38.917);
  assert.equal(completed.input.center,undefined);
  assert.equal(JSON.stringify(records).includes('sensitive-canary'),false);
});
test('successful exact requests are cached, options stay distinct, failures are retried',async t=>{
  let plans=0;
  const {records,base}=await start(t,{plan:async data=>{plans++;if(data.targetKm===50)throw new RoutingError('NO_MATCH','No loop.',422);return {planner:{valid:true,distanceKm:40},trip:{status:0}};}});
  const send=async data=>{const r=await fetch(base+'/round-trip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});await r.json();return r;};
  await send(input);const hit=await send(input);assert.equal(hit.status,200);assert.equal(plans,1);
  for(const change of [{direction:90},{avoidMotorways:false},{profile:'twisty'},{radiusKm:10},{radiusKm:20},{coneAngleDegrees:60},{coneAngleDegrees:120},{center:{...input.center,latitude:input.center.latitude+0.000001}}])await send({...input,...change});
  assert.equal(plans,9);
  await send({...input,targetKm:50});await send({...input,targetKm:50});assert.equal(plans,11);
  assert.equal(records.filter(r=>r.event==='request.completed' && r.cache?.status==='hit').length,1);
});
test('failed round trips log the actual routed start road alongside the request reference',async t=>{
  const shape='??o}@??o}@n}@??n}@';
  const center=decodePolyline(shape)[0];
  const {records,base}=await start(t,{plan:async(_input,{route})=>{
    await route({locations:[{lat:0,lon:0}],costing:'motorcycle'});
    throw new RoutingError('NO_MATCH','No loop.',422);
  },engine:async(_base,path)=>path==='route'?{trip:{legs:[{shape}]}}:
    {edges:[{way_id:12345,id:98765,names:['Start road'],road_class:'residential',use:'road'}]}});
  const response=await fetch(base+'/round-trip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,center})});
  const body=await response.json();await new Promise(setImmediate);
  const completed=records.find(r=>r.event==='request.completed');
  assert.equal(completed.requestId,body.requestId);
  assert.equal(completed.startRoads.roads[0].osmWayId,'12345');
  assert.deepEqual(completed.startRoads.roads[0].names,['Start road']);
  assert.equal(completed.startRoads.roads[0].identityStatus,'edge_walk');
  assert.equal(JSON.stringify(completed.startRoads).includes('shape'),false);
});
test('rate limits and unexpected faults are logged and carry references',async t=>{
  for(const options of [{allow:()=>({allowed:false,retryAfter:60})},{plan:async()=>{throw Error('sensitive-canary');}}]) {
    const {records,base}=await start(t,options);
    const response=await fetch(base+'/round-trip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const body=await response.json();await new Promise(setImmediate);
    const completed=records.find(r=>r.event==='request.completed');
    assert.equal(completed.status,options.allow?429:503);
    assert.equal(completed.requestId,body.requestId);
    assert.equal(completed.code,options.allow?'RATE_LIMITED':'CATALOGUE_UNAVAILABLE');
    assert.equal(JSON.stringify(records).includes('sensitive-canary'),false);
  }
});
test('client disconnection records one completion and cancels the planner',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  let cancelled=false;
  const {records,base}=await start(t,{plan:async(_input,{signal})=>{
    entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(Error('Aborted'));},{once:true}));
  }});
  const request=http.request(base+'/round-trip',{method:'POST',headers:{'Content-Type':'application/json'}});
  request.on('error',()=>{});request.end(JSON.stringify(input));
  await started;request.destroy();
  for(let i=0;i<100 && !cancelled;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(cancelled,true);
  const completed=records.filter(r=>r.event==='request.completed');
  assert.equal(completed.length,1);assert.equal(completed[0].status,499);
  assert.equal(completed[0].code,'CLIENT_DISCONNECTED');assert.deepEqual(completed[0].input.center,input.center);
});
test('unknown URLs and diagnostic arrays cannot expose arbitrary strings or grow without bound',()=>{
  const response=new EventEmitter();response.setHeader=()=>{};
  const records=[];
  requestLog({url:'http://[',method:'sensitive-canary'},response,{write:row=>records.push(row)});
  assert.equal(records[0].path,'/unknown');assert.equal(records[0].method,'OTHER');
  const result=diagnosticSummary({attempts:Array.from({length:100},()=>({distanceKm:40,message:'sensitive-canary'}))});
  assert.equal(result.attempts.length,40);assert.equal(result.omittedAttempts,60);
  assert.equal(JSON.stringify(result).includes('sensitive-canary'),false);
});
test('road matching endpoint logs point count without recorded coordinates or geometry',async t=>{
 const points=[{latitude:51.5,longitude:-0.12,timestamp:1000,accuracy:10},{latitude:51.5002,longitude:-0.12,timestamp:2000,accuracy:10}];
 // Two-point polyline6 for the public synthetic road fixture.
 const encode=ps=>{let lat=0,lon=0,out='';const w=d=>{let n=d<0?~(d<<1):d<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63);};for(const p of ps){const a=Math.round(p.latitude*1e6),b=Math.round(p.longitude*1e6);w(a-lat);w(b-lon);lat=a;lon=b;}return out;};
 const {records,base}=await start(t,{engine:async(_base,path)=>{assert.equal(path,'trace_attributes');return {shape:encode(points),matched_points:points.map(p=>({lat:p.latitude,lon:p.longitude,type:'matched'}))};}});
 const r=await fetch(base+'/match',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({points})});
 assert.equal(r.status,200);assert.equal((await r.json()).geometry.length,2);await new Promise(setImmediate);
 const row=records.find(r=>r.event==='request.completed');assert.equal(row.path,'/match');assert.deepEqual(row.input,{locationCount:2});
 assert.equal(JSON.stringify(records).includes('latitude'),false);assert.equal(JSON.stringify(records).includes('geometry'),false);
});
