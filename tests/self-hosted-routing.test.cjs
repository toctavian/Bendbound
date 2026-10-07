const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/utils/routes.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
function load(fetch,env={}){const api={};new Function('exports','fetch','process',source)(api,fetch,{env:{EXPO_PUBLIC_ROUTING_URL:'https://routing.example.test/',...env}});return api;}
const center={latitude:0,longitude:0};
const shape='??o}@??o}@n}@??n}@'; // 0,0 -> .001,0 -> .001,.001 -> 0,.001 -> 0,0 (polyline6)
const payload=km=>({planner:{valid:true},trip:{status:0,summary:{length:km,time:1200},legs:[{shape,maneuvers:[]}]}});
test('self-hosted round trip is a single POST with requirements and no public fallback',async()=>{
 const calls=[];const api=load(async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>payload(40)};});
 const route=await api.calculateRoundTrip(center,40,90,'twisty',[],{avoidMotorways:true});
 assert.equal(route.roundTrip,true);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://routing.example.test/round-trip');
 assert.equal(calls[0].options.method,'POST');assert.deepEqual(JSON.parse(calls[0].options.body),{center,targetKm:40,direction:90,profile:'twisty',avoidMotorways:true});
});
test('service errors remain visible, with no OSRM fallback even when motorways allowed',async()=>{
 let calls=0;const api=load(async()=>{calls++;return{ok:false,json:async()=>({message:'Map region not ready'})};});
 await assert.rejects(api.snapDraftToRoads(api.buildPointToPoint(center,{latitude:0.01,longitude:0.01},'fast','End'),{avoidMotorways:false}),/Map region not ready/);
 assert.equal(calls,1);
});
test('server owns distance tolerance, closure and start-snapping policy',async()=>{
 const api=load(async()=>({ok:true,json:async()=>payload(50)}));
 const route=await api.calculateRoundTrip({latitude:1,longitude:1},40,90,'winding');
 assert.equal(route.roadDistanceKm,50);
 const open=payload(40);open.trip.legs[0].shape='??o}@??o}@';
 const client=load(async()=>({ok:true,json:async()=>open}));
 assert.equal((await client.calculateRoundTrip(center,40,90,'winding')).roundTrip,true);
});
test('pilot token is sent as a bearer header and never added to the URL',async()=>{
 const calls=[];const api=load(async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>payload(40)};},{EXPO_PUBLIC_ROUTING_TOKEN:' pilot-test-token '});
 await api.calculateRoundTrip(center,40,90,'twisty',[],{avoidMotorways:true});
 assert.equal(calls[0].options.headers.Authorization,'Bearer pilot-test-token');
 assert.equal(calls[0].url,'https://routing.example.test/round-trip');
});
test('invalid pilot credentials surface the API error without public-provider fallback',async()=>{
 let calls=0;const api=load(async()=>{calls++;return{ok:false,json:async()=>({code:'UNAUTHORIZED',message:'This test build does not have valid routing access.'})};});
 await assert.rejects(api.calculateRoundTrip(center,40,90,'winding'),/valid routing access/);
 assert.equal(calls,1);
});
test('round trips require explicit server acceptance, with no client search or fallback',async()=>{
 for(const planner of [undefined,null,{}, {valid:false}, {valid:'true'}, {valid:1}]){
  let calls=0;const data={...payload(40),planner};
  const api=load(async()=>{calls++;return{ok:true,json:async()=>data};});
  await assert.rejects(api.calculateRoundTrip(center,40,90,'winding'),/invalid round-trip response/);
  assert.equal(calls,1);
 }
});
test('server policy rejection stays visible even when its geometry could pass local rules',async()=>{
 let calls=0;
 const api=load(async()=>{calls++;return{ok:false,json:async()=>({...payload(40),message:'No route meets the current routing policy.'})};});
 await assert.rejects(api.calculateRoundTrip(center,40,90,'winding'),/current routing policy/);
 assert.equal(calls,1);
});
test('server approval cannot bypass basic response and navigation integrity checks',async()=>{
 const badCases=[
  null, {}, {...payload(40),trip:null},
  ...[0,-1,NaN,Infinity].map(length=>({...payload(40),trip:{...payload(40).trip,summary:{length,time:1200}}})),
  ...[-1,NaN,Infinity].map(time=>({...payload(40),trip:{...payload(40).trip,summary:{length:40,time}}})),
  ...[[],{},[null],[{shape:123}],[{shape:''}],[{shape:'??'}],
   [{shape:shape+'?'}],[{shape:shape+'!'}],[{shape:shape+'~~~~~~~?'}],
   [{shape,maneuvers:{}}],
   [{shape,maneuvers:[null]}],
   [{shape,maneuvers:[{type:1,instruction:'Turn',begin_shape_index:0,end_shape_index:99}]}],
   [{shape,maneuvers:[{type:1,instruction:'Turn',begin_shape_index:-1,end_shape_index:0}]}],
   [{shape,maneuvers:[{type:1,instruction:'Turn',begin_shape_index:2,end_shape_index:1}]}],
   [{shape,maneuvers:[{type:1,instruction:'Turn',begin_shape_index:0.5,end_shape_index:1}]}],
   [{shape,maneuvers:[{type:1,begin_shape_index:0,end_shape_index:1}]}],
   [{shape:'??o}@??o}@'},{shape}], // Disconnected legs.
  ].map(legs=>({...payload(40),trip:{...payload(40).trip,legs}})),
 ];
 for(const data of badCases){
  const api=load(async()=>({ok:true,json:async()=>data}));
  await assert.rejects(api.calculateRoundTrip(center,40,90,'winding'),/invalid round-trip response/);
 }
});
