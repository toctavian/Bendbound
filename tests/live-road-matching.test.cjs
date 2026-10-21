const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');

function harness() {
  const slots=[], jobs=[], requests=[];let cursor=0;
  const react={
    useRef(initial){const i=cursor++;return slots[i]??=( {current:initial});},
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>slots[i]=v];},
    useMemo(fn){cursor++;return fn();},
    useEffect(fn,deps){const i=cursor++, old=slots[i];if(!old||deps.some((d,j)=>d!==old.deps[j]))jobs.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
  };
  const exports={};
  const source=readFileSync(require('node:path').join(__dirname,'../src/hooks/useRoadMatchedTrack.ts'),'utf8');
  new Function('exports','require','setInterval','clearInterval',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports,name=>name==='react'?react:{
    matchRoadChunk:points=>new Promise((resolve,reject)=>requests.push({points,resolve,reject})),
    recordingChunks:segments=>segments,
  },()=>1,()=>{});
  return {requests,render(segments,live=true){cursor=0;const output=exports.useRoadMatchedTrack(segments,live);while(jobs.length)jobs.shift()();return output;},cleanup(){for(const slot of slots)slot?.cleanup?.();}};
}
const point=i=>({latitude:51+i/10000,longitude:-0.1,timestamp:i*1000});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('new live fixes are buffered until matched, coalesced while busy, and never drawn as raw tails',async()=>{
 const h=harness(), first=[[point(1),point(2)]], road=[{latitude:51,longitude:0},{latitude:51.001,longitude:0}];
 assert.deepEqual(h.render(first).lines,[]);
 const next=[[...first[0],point(3)]];assert.deepEqual(h.render(next).lines,[]);
 assert.equal(h.requests.length,1);
 h.requests[0].resolve(road);await settle();assert.equal(h.requests.length,2);
 assert.deepEqual(h.render(next).lines,[road]);
 const extended=[...road,{latitude:51.002,longitude:0}];h.requests[1].resolve(extended);await settle();
 assert.deepEqual(h.render(next).lines,[extended]);
 const newest=[[...next[0],point(4)]];h.render(newest);h.requests[2].resolve(h.requests[2].points);await settle();
 assert.deepEqual(h.render(newest).lines,[extended], 'failed matching retains only confirmed geometry');
 h.cleanup();
});
test('advancing matching windows and pause gaps preserve confirmed roads as separate lines',async()=>{
 const h=harness(), first=[Array.from({length:64},(_,i)=>point(i+1))];
 h.render(first);const road=[point(100),point(101)];h.requests[0].resolve(road);await settle();
 const advanced=[Array.from({length:100},(_,i)=>point(i+1))];h.render(advanced);
 const road2=[point(102),point(103)];h.requests[1].resolve(road2);await settle();
 assert.deepEqual(h.render(advanced).lines,[road,road2]);
 const resumed=[advanced[0],[point(200),point(201)]];h.render(resumed);
 const road3=[point(202),point(203)];h.requests[2].resolve(road3);await settle();
 assert.deepEqual(h.render(resumed).lines,[road,road2,road3]);
 h.cleanup();
});
test('saved playback can fall back to durable GPS without changing the original recording',async()=>{
 const h=harness(), source=[[point(1),point(2)]];
 assert.deepEqual(h.render(source,false).lines,source);
 h.requests[0].resolve(h.requests[0].points);await settle();
 assert.deepEqual(h.render(source,false).lines,source);
 assert.deepEqual(source,[[point(1),point(2)]]);
 h.cleanup();
});
