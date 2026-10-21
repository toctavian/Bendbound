const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function harness() {
  const activated=[],released=[],pending=[];let focusEffect,appListener,removed=0;
  const imports={react:{useEffect:fn=>{focusEffect=fn;}},'react-native':{AppState:{addEventListener:(_event,fn)=>{appListener=fn;return {remove:()=>removed++};}}},'expo-keep-awake':{
    activateKeepAwakeAsync:tag=>{activated.push(tag);return new Promise(resolve=>pending.push(resolve));},
    deactivateKeepAwake:async tag=>{released.push(tag);},
  }};
  const exports={};new Function('exports','require',ts.transpileModule(readFileSync(path.join(__dirname,'../src/hooks/useNavigationKeepAwake.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports,name=>imports[name]);
  return {activated,released,pending,render:active=>exports.useNavigationKeepAwake(active),focus:()=>focusEffect(),appState:state=>appListener?.(state),removed:()=>removed};
}
test('an active ride owns a wake lock until paused, stopped or unmounted',async()=>{
 const h=harness();h.render(false);assert.equal(h.focus(),undefined);assert.equal(h.activated.length,0);
 h.render(true);const blur=h.focus();assert.equal(h.activated.length,1);h.pending[0]();await Promise.resolve();
 blur();assert.deepEqual(h.released,[h.activated[0]]);
 h.render(false);assert.equal(h.focus(),undefined);assert.equal(h.activated.length,1);
});
test('late native activation after blur cannot keep the screen awake or release a new session',async()=>{
 const h=harness();h.render(true);const first=h.focus();first();const second=h.focus();
 assert.notEqual(h.activated[0],h.activated[1]);h.pending[0]();await Promise.resolve();
 assert.deepEqual(h.released,[h.activated[0],h.activated[0]]);assert.ok(!h.released.includes(h.activated[1]));
 h.pending[1]();await Promise.resolve();second();assert.equal(h.released.at(-1),h.activated[1]);
});
test('returning from feedback reactivates the ride tag and cleanup removes the listener',async()=>{
 const h=harness();h.render(true);const cleanup=h.focus();
 h.appState('background');assert.equal(h.activated.length,1);
 h.appState('active');assert.deepEqual(h.activated,[h.activated[0],h.activated[0]]);
 cleanup();assert.equal(h.removed(),1);
 h.appState('active');assert.equal(h.activated.length,2);
 for(const resolve of h.pending) resolve();await Promise.resolve();
 assert.ok(h.released.every(tag=>tag===h.activated[0]));
});
test('app-wide ownership follows both ride modes, pause and finish independently of screen focus',()=>{
 for(const mode of ['recording','navigation']) {
  let ride={mode,session:{activeSince:123}}, value, effect, listener, appListener;
  const locks=[], diagnostics=[];
  const imports={react:{useState:initial=>{if(value===undefined)value=initial();return [value,v=>value=v];},useEffect:fn=>effect=fn},
   './useNavigationKeepAwake':{useNavigationKeepAwake:active=>locks.push(active)},
   'react-native':{AppState:{addEventListener:(_event,fn)=>{appListener=fn;return {remove(){}};}}},
   '@/services/rideStore':{readRideState:()=>({active:ride}),recordTrackingDiagnostic:(...args)=>diagnostics.push(args)},
   '@/services/rideTracking':{subscribeToRide:fn=>{listener=fn;return ()=>{listener=null};}},
  };
  const exports={};new Function('exports','require',ts.transpileModule(readFileSync(path.join(__dirname,'../src/hooks/useActiveRideKeepAwake.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports,name=>imports[name]);
  exports.useActiveRideKeepAwake();const cleanup=effect();assert.equal(locks.at(-1),true);
  appListener('background');appListener('active');assert.equal(diagnostics.length,2);
  ride={...ride,session:{activeSince:null}};listener(ride);exports.useActiveRideKeepAwake();assert.equal(locks.at(-1),false);
  ride={...ride,session:{activeSince:456}};listener(ride);exports.useActiveRideKeepAwake();assert.equal(locks.at(-1),true);
  ride=null;listener(null);exports.useActiveRideKeepAwake();assert.equal(locks.at(-1),false);
  cleanup();assert.equal(listener,null);
 }
});
