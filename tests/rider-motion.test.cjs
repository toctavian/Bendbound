const assert=require('node:assert/strict');const {test}=require('node:test');const fs=require('node:fs'),ts=require('typescript'),path=require('node:path');
function load(file,imports={},globals={}){const api={};new Function('exports','require',...Object.keys(globals),ts.transpileModule(fs.readFileSync(path.join(__dirname,'../',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(api,n=>imports[n],...Object.values(globals));return api;}
const routes=load('src/utils/routes.ts');const m=load('src/utils/riderMotion.ts',{'@/utils/routes':routes});
const a={latitude:51.5,longitude:-0.12},b={latitude:51.501,longitude:-0.12},c={latitude:51.501,longitude:-0.118};
test('road projection is continuous between vertices and declines opposite carriageways',()=>{
 const fix={latitude:51.5005,longitude:-0.1199};
 const p=m.projectToRoad([a,b],fix,-1,0);
 assert.ok(Math.abs(p.point.latitude-fix.latitude)<1e-8);assert.equal(p.point.longitude,a.longitude);
 assert.ok(p.distanceKm<0.01);assert.equal(m.projectToRoad([a,b],fix,-1,180),undefined);
});
test('animated movement follows a corner instead of cutting through it',()=>{
 const from={latitude:51.5009,longitude:-0.12},to={latitude:51.501,longitude:-0.1198};
 const path=m.movementPath(from,to,[a,b,c]);assert.deepEqual(path,[from,b,to]);
 const p=m.positionAlong(path,0.3);assert.equal(p.longitude,a.longitude);assert.ok(p.latitude>from.latitude);
 assert.deepEqual(m.positionAlong(path,1),to);
 assert.equal(m.interpolateHeading(350,10,0.5),0);
});
test('unrelated branches and distant GPS fixes do not invent a road journey',()=>{
 const from={latitude:51.49,longitude:-0.12};assert.deepEqual(m.movementPath(from,c,[a,b,c]),[from,c]);
 const road=[a,b,c,a];const point={latitude:51.5001,longitude:-0.12};
 assert.ok(m.movementPath(point,a,road).length<=3);
});
test('animated recording trail ends exactly under the bike along a corner',()=>{
 const lines=[[a,b,c]], frame={latitude:51.501,longitude:-0.119};
 const display=m.trailToRider(lines,frame);
 assert.deepEqual(display.lines,[[a,b,frame]]);
 assert.deepEqual(display.lines.at(-1).at(-1),display.point);
 assert.deepEqual(lines,[[a,b,c]],'display animation must not modify saved geometry');
 const offset=m.trailToRider(lines,{latitude:51.50102,longitude:-0.119});
 assert.deepEqual(offset.lines.at(-1).at(-1),offset.point);
 assert.equal(offset.point.latitude,b.latitude);
 const pending=m.trailToRider(lines,{latitude:51.51,longitude:-0.1});
 assert.deepEqual(pending.point,c);assert.deepEqual(pending.lines,lines);
});
const db=new Map();const storage={getItemSync:k=>db.get(k)??null,setItemSync:(k,v)=>db.set(k,v),removeItemSync:k=>db.delete(k)};
const matching=load('src/utils/roadMatching.ts',{'expo-sqlite/kv-store':{__esModule:true,default:storage}});
test('matching batches retain overlap and never connect a pause or GPS outage',()=>{
 const points=Array.from({length:200},(_,i)=>({...a,timestamp:i*1000}));
 const chunks=matching.recordingChunks([points]);assert.equal(chunks.length,3);assert.equal(chunks[0].at(-1),chunks[1][0]);
 assert.deepEqual(matching.recordingChunks([[{...a,timestamp:0},{...b,timestamp:40000}],[c]]).map(c=>c.length),[1,1,1]);
});

test('matching uses private POST, reuses persisted road geometry and preserves raw fixes on failure',async()=>{
 const storageData=new Map(),store={getItemSync:k=>storageData.get(k)??null,setItemSync:(k,v)=>storageData.set(k,v),removeItemSync:k=>storageData.delete(k)};
 let calls=0,clock=100000;const geometry=[a,b,c];
 const globals={process:{env:{EXPO_PUBLIC_ROUTING_URL:'https://routing.test',EXPO_PUBLIC_ROUTING_TOKEN:'test-only-token'}},Date:{now:()=>clock+=3000},fetch:async(url,opts)=>{
  calls++;assert.equal(url,'https://routing.test/match');assert.equal(opts.headers.Authorization,'Bearer test-only-token');assert.equal(opts.method,'POST');return {ok:true,json:async()=>({geometry})};
 }};
 const make=()=>load('src/utils/roadMatching.ts',{'expo-sqlite/kv-store':{__esModule:true,default:store}},globals);
 const first=make();assert.deepEqual(await first.matchRoadChunk([a,c]),geometry);
 assert.deepEqual(await first.matchRoadChunk([a,c]),geometry);assert.equal(calls,1);
 assert.deepEqual(await make().matchRoadChunk([a,c]),geometry);assert.equal(calls,1,'persisted cache survives module restart');
 const failed=load('src/utils/roadMatching.ts',{'expo-sqlite/kv-store':{__esModule:true,default:store}}, {...globals,fetch:async()=>({ok:false})});
 const raw=[b,c];assert.equal(await failed.matchRoadChunk(raw),raw);
 const controller=new AbortController();controller.abort();assert.equal(await failed.matchRoadChunk(raw,controller.signal),raw);
});
