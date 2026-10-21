import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frequencyRating,roadRating,inArea,london,candidateScore,betterCandidate } from '../service/policy.mjs';
import { planRoundTrip as actualPlan,sectionAnchors } from '../service/planner.mjs';

const planRoundTrip=(input,options)=>actualPlan(input,{catalogueRoadUse:async()=>({valid:true,repeatedKm:0,repeatedRatio:0,maxTraversals:1}),...options});
const point=(x,y)=>({latitude:london.latitude+y/111195,longitude:london.longitude+x/(111195*Math.cos(london.latitude*Math.PI/180))});
const loop=[[0,0],[3000,0],[3000,3000],[0,3000],[0,0]].map(([x,y])=>point(x,y));
function encode(points){let lat=0,lon=0,out='';const w=d=>{let n=d<0?~(d<<1):d<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63);};for(const p of points){const a=Math.round(p.latitude*1e6),b=Math.round(p.longitude*1e6);w(a-lat);w(b-lon);lat=a;lon=b;}return out;}
const payload=(km=20)=>({trip:{status:0,summary:{length:km,time:1200},legs:[{shape:encode(loop),maneuvers:[{begin_shape_index:0,end_shape_index:4}]}]}});
const input={center:london,targetKm:20,direction:90,profile:'winding',avoidMotorways:true};
const road={id:'a',name:'Test road',rating:4,quality:4,winding:4,twisty:3,recommendationCount:2,lengthKm:1,geometry:{type:'LineString',coordinates:[[loop[1].longitude,loop[1].latitude],[loop[2].longitude,loop[2].latitude]]}};
test('guide frequency rewards corroboration without inventing rider votes',()=>{
  assert.equal(frequencyRating(0),null);
  assert.ok(frequencyRating(3)>frequencyRating(1));
  assert.ok(frequencyRating(100)<5);
  assert.equal(roadRating(3,0),3);
  assert.throws(()=>frequencyRating(-1));
});
test('100 km pilot bounds exclude starts outside the service region',async()=>{
  assert.equal(inArea(london),true);assert.equal(inArea({latitude:52.7,longitude:-0.1278}),false);
  assert.equal(inArea({...london,longitude:london.longitude+360}),false);
  await assert.rejects(planRoundTrip({...input,center:{latitude:52.7,longitude:0}},{catalogueNearby:async()=>{throw Error('Should not query');}}),e=>e.code==='OUTSIDE_AREA');
});
test('anchors span the full stored section, including reversed traversal',()=>{
  assert.deepEqual(sectionAnchors(road)[0],loop[1]);assert.deepEqual(sectionAnchors(road).at(-1),loop[2]);
  assert.deepEqual(sectionAnchors(road,true)[0],loop[2]);
});
test('road scoring uses traversed kilometres and distance error',()=>{
  assert.ok(candidateScore({distanceErrorKm:0},[{rating:4,traversedKm:5}],20)>candidateScore({distanceErrorKm:0},[{rating:4,traversedKm:1}],20));
  assert.ok(candidateScore({distanceErrorKm:0},[],20)>candidateScore({distanceErrorKm:9},[],20));
});
test('a valid loop survives a missed suggested section without claiming full traversal',async()=>{
  let matches=0;
  const result=await planRoundTrip(input,{catalogueNearby:async()=>[road],route:async()=>payload(),
    trace:async()=>({shape:encode(loop),edges:[{way_id:123,begin_shape_index:0,end_shape_index:4}]}),catalogueMatch:async(_p,ways)=>{assert.deepEqual(ways,['123']);matches++;return [{...road,traversedKm:0.9,coverage:0.9,fullSection:false}];},
    fallback:async()=>{throw Error('A valid loop must not depend on another search');}});
  assert.ok(matches>=1);
  assert.equal(result.planner.valid,true);
  assert.equal(result.planner.selectedRoadSectionId,null);
  assert.equal(result.planner.implementation,'road-catalogue-v1');
});
test('catalogue scores cannot bypass strict distance acceptance',async()=>{
  await assert.rejects(planRoundTrip(input,{catalogueNearby:async()=>[road],route:async()=>payload(30),
    trace:async()=>{throw Error('Invalid routes must not be traced');},catalogueMatch:async()=>[],fallback:async()=>({...payload(30),planner:{attempts:1}})}),e=>e.code==='NO_MATCH');
});
test('short routes are rejected before geometry assessment or tracing',async()=>{
  await assert.rejects(planRoundTrip(input,{catalogueNearby:async()=>[road],
    route:async()=>({trip:{summary:{length:10},legs:[{shape:'deliberately invalid'}]}}),
    trace:async()=>{throw Error('Too-short routes must not be traced');},
    fallback:async()=>({...payload(10),planner:{attempts:1}})}),error=>{
      assert.equal(error.code,'NO_MATCH');
      assert.ok(error.diagnostics.attempts.some(a=>a.reason==='POLICY' && a.distanceKm===10));
      assert.equal(error.diagnostics.attempts.some(a=>a.code==='ENGINE_RESPONSE'),false);
      return true;
    });
});
test('an overlong route with a spur can be legally repaired into a valid loop',async()=>{
  const spur=[...loop.slice(0,2),point(4000,0),loop[1],...loop.slice(2)];
  let calls=0;
  const result=await planRoundTrip(input,{catalogueNearby:async()=>[road],route:async()=>{
    if(++calls===1)return {trip:{...payload(35).trip,legs:[{shape:encode(spur)}]}};
    return payload();
  },trace:async()=>({shape:encode(loop),edges:[{way_id:123,begin_shape_index:0,end_shape_index:4}]}),catalogueMatch:async()=>[{...road,traversedKm:1,coverage:1,fullSection:true}],
    fallback:async()=>{throw Error('The repaired loop must survive');}});
  assert.equal(calls,2);
  assert.equal(result.planner.valid,true);
  assert.equal(result.planner.selectedRoadSectionId,road.id);
});
test('a verified full-section candidate wins against a worse-distance ordinary loop',async()=>{
  let requests=0;
  const result=await planRoundTrip(input,{catalogueNearby:async()=>[road],route:async()=>payload(),
    trace:async()=>({shape:encode(loop),edges:[{way_id:123,begin_shape_index:0,end_shape_index:4}]}),catalogueMatch:async()=>[{...road,traversedKm:1,coverage:1,fullSection:true}],
    fallback:async()=>{requests++;return {...payload(28),planner:{attempts:1}};}});
  assert.equal(result.planner.selectedRoadSectionId,road.id);
  assert.equal(result.planner.distanceKm,20);
  assert.equal(result.planner.attempts,1);
  assert.equal(requests,0);
});
test('an engine failure during later exploration cannot discard a verified loop',async()=>{
  let calls=0;
  const result=await planRoundTrip(input,{catalogueNearby:async()=>[road],route:async()=>{
    if(++calls===1)return payload();
    throw Object.assign(Error('Engine busy'),{status:503,code:'ENGINE_UNAVAILABLE'});
  },trace:async()=>({shape:encode(loop),edges:[{way_id:123,begin_shape_index:0,end_shape_index:4}]}),catalogueMatch:async()=>[],
    fallback:async()=>{throw Error('Should retain the verified loop');}});
  assert.equal(result.planner.valid,true);
  assert.equal(result.planner.selectedRoadSectionId,null);
});
test('no catalogue matches still permits a valid ordinary-road loop',async()=>{
  const result=await planRoundTrip(input,{catalogueNearby:async()=>[],catalogueMatch:async()=>[],trace:async()=>({shape:encode(loop),edges:[{way_id:123,begin_shape_index:0,end_shape_index:4}]}),fallback:async()=>({...payload(),planner:{attempts:1}})});
  assert.equal(result.planner.valid,true);assert.equal(result.planner.evaluatedKm,0);
});
test('engine errors remain visible when road identity cannot be verified',async()=>{
  await assert.rejects(planRoundTrip(input,{catalogueNearby:async()=>[],trace:async()=>({edges:[]}),fallback:async()=>({...payload(),planner:{attempts:1}})}),e=>e.code==='NO_MATCH');
});
test('strict-safe loops survive omitted trace access geometry without invented physical coverage',async()=>{
  const result=await planRoundTrip(input,{catalogueNearby:async()=>[road],route:async()=>payload(),
    trace:async()=>({edges:[{way_id:123}]}),catalogueMatch:async()=>[]});
  assert.equal(result.planner.valid,true);
  assert.equal(result.planner.identityVerification,'strict-geometry-subset');
  assert.equal(result.planner.verifiedRatio,undefined);
  assert.equal(result.planner.maxTraversals,1);
});
test('strict geometry cannot override an identified third traversal',async()=>{
  await assert.rejects(planRoundTrip(input,{catalogueNearby:async()=>[road],route:async()=>payload(),
    trace:async()=>({shape:encode(loop),edges:[{way_id:123,begin_shape_index:0,end_shape_index:4}]}),
    catalogueRoadUse:async()=>({valid:false,maxTraversals:3,repeatedRatio:0.01,repeatedKm:0.2}),
    fallback:async()=>({...payload(),planner:{attempts:1}})}),e=>e.code==='NO_MATCH');
});
test('an already-valid loop is legally repaired when it contains an internal out-and-back',async()=>{
 const spur=[loop[0],loop[1],point(3500,0),loop[1],...loop.slice(2)];let repairs=0;
 const raw={trip:{status:0,summary:{length:21,time:1200},legs:[{shape:encode(spur),maneuvers:[{begin_shape_index:0,end_shape_index:6}]}]},planner:{attempts:1}};
 const result=await planRoundTrip(input,{
  catalogueNearby:async()=>[],fallback:async()=>raw,
  route:async request=>{repairs++;assert.ok(request.locations.slice(1,-1).every(p=>p.search_cutoff===30));return payload(20);},
  trace:async request=>({shape:request.encoded_polyline,edges:[{way_id:123,begin_shape_index:0,end_shape_index:request.encoded_polyline===encode(spur)?6:4}]}),
  catalogueRoadUse:async(_parts,km)=>({valid:true,repeatedKm:km>12.4?0.5:0,repeatedRatio:km>12.4?0.04:0,maxTraversals:km>12.4?2:1}),
  catalogueMatch:async()=>[],
 });
 assert.equal(repairs,1);assert.equal(result.planner.distanceKm,20);assert.equal(result.planner.repeatedRatio,0);assert.equal(result.planner.internalExcursionKm,0);assert.equal(result.planner.excursionsRemovedKm,1);
});
test('internal spur penalty favours a clean loop over a slightly better road rating',()=>{
 assert.ok(candidateScore({distanceErrorKm:0,repeatedRatio:0,internalExcursionKm:0},[{rating:3,traversedKm:4}],40)
  >candidateScore({distanceErrorKm:0,repeatedRatio:0.05,internalExcursionKm:4},[{rating:5,traversedKm:5}],40));
});

test('an acceptable clean loop wins over a higher-scoring loop with internal reuse',()=>{
 const clean={metrics:{valid:true,internalRepeatedRatio:0,internalExcursionKm:0},score:1};
 const dirty={metrics:{valid:true,internalRepeatedRatio:0.05,internalExcursionKm:0},score:100};
 assert.equal(betterCandidate(clean,dirty),true);assert.equal(betterCandidate(dirty,clean),false);
});
