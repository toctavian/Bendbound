import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchRecording } from '../service/matching.mjs';
import { inputSummary } from '../service/logging.mjs';
const points=[{latitude:51.5,longitude:-0.12,timestamp:1000,accuracy:10},{latitude:51.5002,longitude:-0.12,timestamp:2000,accuracy:10}];
function encode(ps){let lat=0,lon=0,out='';const w=d=>{let n=d<0?~(d<<1):d<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63);};for(const p of ps){const a=Math.round(p.latitude*1e6),b=Math.round(p.longitude*1e6);w(a-lat);w(b-lon);lat=a;lon=b;}return out;}
const response=()=>({shape:encode(points),matched_points:points.map(p=>({lat:p.latitude,lon:p.longitude,type:'matched'}))});
test('recording matching requests motorcycle roads and returns verified geometry',async()=>{
 const result=await matchRecording({points},async(path,data)=>{assert.equal(path,'trace_attributes');assert.equal(data.costing,'motorcycle');assert.equal(data.shape_match,'map_snap');assert.equal(data.trace_options.search_radius,50);return response();});
 assert.deepEqual(result.geometry,points.map(({latitude,longitude})=>({latitude,longitude})));
 assert.deepEqual(inputSummary('/match',{points},true),{locationCount:2});
});
test('uncertain, far-away and disconnected map matches cannot replace a recorded track',async()=>{
 for(const change of [p=>{p.matched_points.pop();},p=>{p.matched_points[0].type='unmatched';},p=>{p.matched_points[0].lon=-0.13;},p=>{p.matched_points[0].begin_route_discontinuity=true;},p=>{p.shape=encode([points[0],{latitude:51.52,longitude:-0.12},points[1]]);}]){
  const p=response();change(p);await assert.rejects(matchRecording({points},async()=>p),e=>e.code==='NO_MATCH');
 }
});
test('input bounds, pauses and GPS outages reject before engine work',async()=>{
 for(const input of [{points:[]},{points:Array(129).fill(points[0])},{points:[points[0],{...points[1],timestamp:40000}]},{points:[points[0],{...points[1],timestamp:500}]},{points:[points[0],{...points[1],accuracy:100}]},{points:[points[0],{...points[1],latitude:55}]}])
 await assert.rejects(matchRecording(input,async()=>{assert.fail('Must not reach engine');}),e=>e.code==='INVALID_REQUEST');
});
