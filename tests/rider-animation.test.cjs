const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
function load(file,imports,globals={}){const exports={};new Function('exports','require',...Object.keys(globals),ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports,n=>imports[n],...Object.values(globals));return exports;}
const routes=load('src/utils/routes.ts',{}),motion=load('src/utils/riderMotion.ts',{'@/utils/routes':routes});
const a={latitude:51.5,longitude:-0.12},b={latitude:51.5005,longitude:-0.12};
function harness(){
 let now=100000,cursor=0,effects=[],id=0,result;const slots=[],frames=new Map(),timers=new Map();
 let props={point:a,heading:350,road:[a,b],enabled:true};
 const react={useRef:v=>{const i=cursor++;return slots[i]??={current:v};},useState:v=>{const i=cursor++;slots[i]??={value:v};return[slots[i].value,value=>{slots[i].value=value;}];},useEffect:(fn,deps)=>{const i=cursor++,prev=slots[i];if(prev&&deps.every((d,n)=>Object.is(d,prev.deps[n])))return;effects.push(()=>{prev?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
 const api=load('src/hooks/useRiderMotion.ts',{react,'@/utils/routes':routes,'@/utils/riderMotion':motion},{Date:{now:()=>now},requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:i=>frames.delete(i),setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:i=>timers.delete(i)});
 const h={render(overrides={}){props={...props,...overrides};cursor=0;effects=[];result=api.useRiderMotion(props.point,props.heading,props.road,props.enabled);effects.forEach(f=>f());return result;},advance(ms){now+=ms;const work=[...frames.values()];frames.clear();work.forEach(fn=>fn());return h.render();},flush(){const work=[...timers.values()];timers.clear();work.forEach(fn=>fn());return h.render();},unmount(){slots.forEach(s=>s?.cleanup?.());},frames};return h;
}
test('rider interpolates between GPS fixes and heading wraps smoothly through north',()=>{
 const h=harness();h.render();h.advance(1000);h.render({point:b,heading:10});
 const mid=h.advance(500);assert.ok(mid.point.latitude>a.latitude&&mid.point.latitude<b.latitude);assert.equal(mid.point.longitude,a.longitude);
 assert.ok(mid.heading>350||mid.heading<10);
 const end=h.advance(600);assert.deepEqual(end.point,b);h.unmount();assert.equal(h.frames.size,0);
});
test('pause cancels animation, and stale or large jumps are never extrapolated into a journey',()=>{
 const h=harness();h.render();h.advance(1000);h.render({point:b});h.advance(300);
 assert.deepEqual(h.render({enabled:false}).point,b);assert.equal(h.frames.size,0);h.flush();
 h.render({enabled:true});const far={latitude:51.52,longitude:-0.12};h.render({point:far});assert.deepEqual(h.flush().point,far);
 h.advance(15000);h.render({point:b});assert.deepEqual(h.flush().point,b);h.unmount();
});
