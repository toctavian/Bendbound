import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStartRoadCapture, startRoadSummary } from '../service/start-road.mjs';
const center={latitude:51.487429,longitude:-0.020573};
const request={locations:[{lat:center.latitude,lon:center.longitude,search_cutoff:200}],costing:'motorcycle',costing_options:{motorcycle:{exclude_highways:true}}};
function encode(points){let lat=0,lon=0,out='';const w=d=>{let n=d<0?~(d<<1):d<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63);};for(const p of points){const a=Math.round(p.latitude*1e6),b=Math.round(p.longitude*1e6);w(a-lat);w(b-lon);lat=a;lon=b;}return out;}
const snapped={latitude:51.4874,longitude:-0.0205};
const payload={trip:{status:0,legs:[{shape:encode([snapped,{...snapped,latitude:51.488},{...snapped,latitude:51.4894}]),maneuvers:[{street_names:['Maneuver name']}]}]}};
test('failure road identity comes from the routed start, with bounded lookup and no route-request changes',async()=>{
  const calls=[];
  const capture=createStartRoadCapture({center,base:'engine',engine:async(base,path,body,signal)=>{
    calls.push({path,body,signal});
    if(path==='route'){assert.equal(body,request);return payload;}
    assert.equal(path,'trace_attributes');assert.equal(body.shape_match,'edge_walk');
    assert.deepEqual(body.shape[0],{lat:snapped.latitude,lon:snapped.longitude});
    assert.ok(body.shape.at(-1).lat<51.4894);
    assert.deepEqual(body.costing_options,request.costing_options);
    return {edges:[{way_id:12345,id:98765,names:['Actual start road'],road_class:'residential',use:'road'}]};
  }});
  assert.equal(await capture.route(request),payload);await capture.route(request);
  assert.equal(calls.length,2); // No additional engine calls on successful routes.
  const summary=startRoadSummary(await capture.resolve());
  assert.equal(calls.length,3); // Duplicate departures share one identity lookup.
  const road=summary.roads[0];assert.equal(road.osmWayId,'12345');assert.equal(road.engineEdgeId,'98765');
  assert.deepEqual(road.names,['Actual start road']);assert.deepEqual(road.snappedStart,snapped);
  assert.ok(road.snapDistanceMetres>0);assert.deepEqual(road.attempts,[1,2]);
  assert.equal(road.identityStatus,'edge_walk');assert.equal(road.nameSource,'edge_walk');
  assert.equal(JSON.stringify(summary).includes('shape'),false);
});
test('opposite departures remain distinguishable even with the same start coordinate',async()=>{
  let routes=0;
  const capture=createStartRoadCapture({center,engine:async(_base,path)=>path==='route'?{
    trip:{legs:[{shape:encode([snapped,{...snapped,latitude:snapped.latitude+(++routes===1?0.001:-0.001)}])}]}
  }:{edges:[{way_id:1,id:2,names:[]}]}});
  await capture.route(request);await capture.route(request);
  const summary=await capture.resolve();assert.equal(summary.roads.length,2);
  assert.notEqual(summary.roads[0].departureBearing,summary.roads[1].departureBearing);
});
test('identity lookup failure preserves the routing failure and reports uncertainty',async()=>{
  const capture=createStartRoadCapture({center,engine:async(_base,path)=>{
    if(path==='route')return payload;throw Object.assign(Error('sensitive-canary'),{code:'ENGINE_UNAVAILABLE'});
  }});
  await capture.route(request);const summary=startRoadSummary(await capture.resolve());
  assert.equal(summary.roads[0].identityStatus,'unavailable');assert.equal(summary.roads[0].osmWayId,undefined);
  assert.equal(summary.roads[0].nameSource,'route_maneuver');
  assert.equal(JSON.stringify(summary).includes('sensitive-canary'),false);
});
test('when no path exists, correlated roads are candidates rather than asserted starts',async()=>{
  const capture=createStartRoadCapture({center,engine:async(_base,path)=>{
    if(path==='route')throw Object.assign(Error('No path'),{code:'ENGINE_ROUTE'});
    return [{edges:[{edge_info:{way_id:9,names:['Candidate road']},edge_id:{value:10},correlated_lat:snapped.latitude,correlated_lon:snapped.longitude}]}];
  }});
  await assert.rejects(capture.route(request));const summary=startRoadSummary(await capture.resolve());
  assert.equal(summary.status,'no_routed_start');assert.equal(summary.roads.length,0);
  assert.equal(summary.candidates[0].identityStatus,'candidate_only');assert.equal(summary.candidates[0].osmWayId,'9');
  assert.deepEqual(summary.unroutedAttempts,[{attempt:1,code:'ENGINE_ROUTE'}]);
});
test('validation failures and disconnected clients trigger no additional engine lookup',async()=>{
  const controller=new AbortController();let calls=0;
  const capture=createStartRoadCapture({center,signal:controller.signal,engine:async()=>{calls++;return payload;}});
  assert.equal((await capture.resolve()).status,'not_attempted');assert.equal(calls,0);
  await capture.route(request);controller.abort();await capture.resolve();assert.equal(calls,1);
});

test('native routing edges identify the actual departure without a trace lookup',async()=>{
  const center={latitude:51.5,longitude:-.1};let lookups=0;
  const capture=createStartRoadCapture({center,base:'http://engine',engine:async(_base,path)=>{
    if(path!=='route'){lookups++;throw Error('Native departure should not be rematched');}
    return {trip:{legs:[{shape:encode([{latitude:51.5,longitude:-.1},{latitude:51.5001,longitude:-.1}]),maneuvers:[]}]},nativePath:[{edges:[{id:'123',way_id:'456',name:[{value:'Native Road'}]}]}]};
  }});
  await capture.route({locations:[{lat:51.5,lon:-.1}],costing_options:{}});
  const result=await capture.resolve();assert.equal(lookups,0);assert.equal(result.roads[0].identityStatus,'native_path');assert.equal(result.roads[0].osmWayId,'456');assert.deepEqual(result.roads[0].names,['Native Road']);
});
