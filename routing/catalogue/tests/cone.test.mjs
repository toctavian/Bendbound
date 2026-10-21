import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conePolygon, insideCone, coneBufferKm } from '../../service/cone.mjs';
import { pointAtBearing } from '../../service/geometry.mjs';
import { validateInput } from '../service/input.mjs';
import { inputSummary } from '../service/logging.mjs';
import { candidatePoints, planRoundTrip } from '../service/planner.mjs';
import { planRoundTrip as ordinary } from '../service/ordinary-planner.mjs';
const center={latitude:51.5074,longitude:-0.1278};
const input={center,direction:0,radiusKm:10,targetKm:40,profile:'winding',avoidMotorways:true};
test('cone bounds follow cardinal directions and include a bounded access buffer',()=>{
  for(const direction of [0,90,180,270]){
    const area={...input,direction},ring=conePolygon(area,true);
    assert.ok(insideCone(center,ring));
    assert.ok(insideCone(pointAtBearing(center,9,direction+45),ring));
    assert.ok(insideCone(pointAtBearing(center,10.8,direction),ring));
    assert.ok(insideCone(pointAtBearing(center,0.8,direction+180),ring));
    assert.equal(insideCone(pointAtBearing(center,3,direction+180),ring),false);
    assert.equal(insideCone(pointAtBearing(center,13,direction),ring),false);
    assert.equal(insideCone(pointAtBearing(center,9,direction+100),ring),false);
  }
  assert.equal(coneBufferKm(5),1);assert.equal(coneBufferKm(100),5);
});
test('cone radius validates, normalises and forms part of the canonical request',()=>{
  assert.equal(validateInput({...input,direction:360}).direction,0);
  assert.equal(validateInput(input).radiusKm,10);
  const {radiusKm,...legacy}=input;
  assert.equal(validateInput(legacy).radiusKm,undefined);
  for(const radiusKm of [null,'10',4,101,NaN,Infinity]) assert.throws(()=>validateInput({...input,radiusKm}),e=>e.code==='INVALID_REQUEST');
  assert.notEqual(JSON.stringify(validateInput(input)),JSON.stringify(validateInput({...input,radiusKm:15})));
  assert.equal(inputSummary('/round-trip',input,true).radiusKm,10);
});
test('candidate waypoints remain within the selected cone even for a road near its edge',()=>{
 const points=[pointAtBearing(center,4,50),pointAtBearing(center,5,50)];
 const road={geometry:{coordinates:points.map(p=>[p.longitude,p.latitude])}};
 for(let variant=0;variant<4;variant++) assert.ok(candidatePoints(input,road,variant,100).every(p=>insideCone(p,conePolygon(input,true))));
});
test('ordinary search sends only waypoints inside the buffered cone',async()=>{
 let attempts=0;
 await assert.rejects(ordinary(input,{maxAttempts:24,route:async request=>{
   attempts++;
   assert.ok(request.locations.every(p=>insideCone({latitude:p.lat,longitude:p.lon},conePolygon(input,true))));
   throw Object.assign(new Error('No route'),{code:'NO_MATCH'});
 }}));
 assert.ok(attempts>0 && attempts<=24);
});
function encode(points){let lat=0,lon=0,out='';const w=d=>{let n=d<0?~(d<<1):d<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63);};for(const p of points){const a=Math.round(p.latitude*1e6),b=Math.round(p.longitude*1e6);w(a-lat);w(b-lon);lat=a;lon=b;}return out;}
test('a distance-valid loop outside the cone is rejected before road tracing',async()=>{
 const path=[center,pointAtBearing(center,6,150),pointAtBearing(center,6,210),center];
 let shortlist;
 await assert.rejects(planRoundTrip(input,{
  catalogueNearby:async query=>{shortlist=query;return [];},
  fallback:async()=>({trip:{status:0,summary:{length:40},legs:[{shape:encode(path)}]},planner:{attempts:1}}),
  trace:async()=>{throw Error('Must reject before tracing');},
 }),e=>e.code==='NO_MATCH' && e.message.includes('selected direction'));
 assert.ok(shortlist.areaPolygon.length>3);assert.equal(shortlist.radiusKm,11.5);
});
test('an accepted complete loop confirms its exact cone radius and buffer',async()=>{
 const path=[center,pointAtBearing(center,4,330),pointAtBearing(center,6,0),pointAtBearing(center,4,30),center];
 const payload={trip:{status:0,summary:{length:40},legs:[{shape:encode(path)}]},planner:{attempts:1}};
 const result=await planRoundTrip(input,{
  catalogueNearby:async()=>[],fallback:async()=>payload,
  trace:async()=>({shape:encode(path),edges:[{way_id:123,begin_shape_index:0,end_shape_index:4}]}),
  catalogueRoadUse:async()=>({valid:true,repeatedKm:0,repeatedRatio:0,maxTraversals:1,verifiedRatio:1}),
  catalogueMatch:async()=>[],
 });
 assert.equal(result.planner.valid,true);assert.equal(result.planner.insideCone,true);
 assert.equal(result.planner.coneRadiusKm,10);assert.equal(result.planner.coneBufferKm,1.5);
});
test('selected angle changes width and derives reach from half the ride distance',()=>{
 const narrow={...input,coneAngleDegrees:60},wide={...input,coneAngleDegrees:150};
 assert.equal(validateInput({...input,coneAngleDegrees:60,targetKm:60}).radiusKm,30);
 assert.ok(!insideCone(pointAtBearing(center,8,50),conePolygon(narrow)));
 assert.ok(insideCone(pointAtBearing(center,8,50),conePolygon(wide)));
 for(const angle of [null,'90',0,181,Infinity])assert.throws(()=>validateInput({...input,coneAngleDegrees:angle}),e=>e.code==='INVALID_REQUEST');
 assert.notEqual(JSON.stringify(validateInput(narrow)),JSON.stringify(validateInput(wide)));
});
