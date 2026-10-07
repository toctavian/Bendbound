import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assess, valhallaRequest, RoutingError } from '../service/engine.mjs';
import { planRoundTrip, removeExcursions, validateInput } from '../service/planner.mjs';

const point = (x, y) => ({ latitude: y / 111195, longitude: x / 111195 });
const loop = [[0,0],[1000,0],[1000,1000],[0,1000],[0,0]].map(([x,y]) => point(x,y));
const input = { center: loop[0], targetKm: 20, direction: 90, profile: 'winding', avoidMotorways: true };
function encode(points) {
  let lat=0,lon=0,out='';
  const write = delta => { let n = delta < 0 ? ~(delta << 1) : delta << 1; while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63); };
  for(const p of points){ const a=Math.round(p.latitude*1e6),b=Math.round(p.longitude*1e6);write(a-lat);write(b-lon);lat=a;lon=b; }
  return out;
}
const payload = (points, km) => ({ trip: { status: 0, summary: { length: km, time: 1200 }, legs: [{ shape: encode(points) }] } });

test('same validator enforces strict distance, closure, start proximity and no repeats', () => {
  assert.equal(assess(loop,20,20,loop[0]).valid,true);
  assert.equal(assess(loop,30,20,loop[0]).valid,false);
  assert.equal(assess(loop,29.999,20,loop[0]).valid,true);
  assert.equal(assess([...loop,...loop.slice(1)],20,20,loop[0]).valid,false);
  assert.equal(assess(loop.slice(0,-1),20,20,loop[0]).valid,false);
  assert.equal(assess(loop,20,20,point(500,500)).valid,false);
});
test('spurs are removed without deleting the final closure; a short access road is allowed', () => {
  const spur = [...loop.slice(0,2),point(1100,0),loop[1],...loop.slice(2)];
  assert.deepEqual(removeExcursions(spur),loop);
  const stem = [point(-100,0),...loop,point(-100,0)];
  assert.equal(assess(stem,20,20,stem[0]).valid,true);
});
test('Valhalla enables hard motorway exclusion and no trail preference', () => {
  const request = valhallaRequest(loop,{avoidMotorways:true});
  assert.equal(request.costing_options.motorcycle.exclude_highways,true);
  assert.equal(request.costing_options.motorcycle.use_trails,0);
  assert.equal(request.locations[0].search_cutoff,200);
});
test('planner repairs a spur by rerouting retained points before accepting', async () => {
  const spur=[...loop.slice(0,2),point(1100,0),loop[1],...loop.slice(2)];
  const calls=[];
  const result=await planRoundTrip(input,{route:async request=>{calls.push(request);return payload(calls.length===1?spur:loop,20);}});
  assert.equal(result.planner.valid,true);
  assert.equal(calls.length,2);
  assert.notDeepEqual(calls[0].locations,calls[1].locations);
});
test('exhaustion reports diagnostics without returning a rejected candidate',async()=>{
  await assert.rejects(planRoundTrip(input,{maxAttempts:2,route:async()=>payload(loop,35)}),error=>error.code==='NO_MATCH'&&error.diagnostics.attempts.length===2);
});
test('engine outage aborts retries and is distinguishable from no match',async()=>{
  let calls=0;
  await assert.rejects(planRoundTrip(input,{route:async()=>{calls++;throw new RoutingError('ENGINE_UNAVAILABLE','Offline',503);}}),error=>error.code==='ENGINE_UNAVAILABLE'&&error.status===503);
  assert.equal(calls,1);
});
test('invalid coordinates, distance, profile and options are rejected before routing',()=>{
  for(const change of [{center:{latitude:NaN,longitude:0}},{targetKm:0},{targetKm:501},{profile:'bad'},{avoidMotorways:'true'}]){
    assert.throws(()=>validateInput({...input,...change}),error=>error.code==='INVALID_REQUEST');
  }
});

test('repair retains access and full loop before requesting fresh navigation', async () => {
  const start = point(-100,0);
  const valid = [start,...loop,start];
  const spur = [start,...loop.slice(0,2),point(1100,0),loop[1],...loop.slice(2),start];
  const calls=[];
  const result=await planRoundTrip({...input,center:start},{route:async request=>{
    calls.push(request);return payload(calls.length===1?spur:valid,20);
  }});
  assert.equal(calls.length,2);
  const locations=calls[1].locations;
  assert.ok(locations.some(p=>p.lat>0.008)); // Main loop survives the repair.
  assert.equal(locations[0].lon,locations.at(-1).lon);
  assert.ok(result.planner.sharedAccessKm>0.099);
  assert.equal(result.planner.remainingRepeatedRatio,0);
});
