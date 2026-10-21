const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const ts = require('typescript');
const flush = () => new Promise(resolve => setImmediate(resolve));
function nodes(node, predicate) {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(child => nodes(child,predicate));
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children,predicate)];
}
function harness() {
  const state=[], timers=new Map(), intervals=new Map(), requests=[], urls=[];
  let cursor=0, effect, cleanup, listener, timerId=0, removed=false;
  const jsx=(type,props)=>({type,props});
  const imports={
    react:{useState:initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],value=>{state[i]=value;}];},useEffect:fn=>{effect??=fn;}},
    'react/jsx-runtime':{jsx,jsxs:jsx},
    'react-native':{Modal:'Modal',View:'View',Text:'Text',Image:'Image',Pressable:'Pressable',ScrollView:'ScrollView',StyleSheet:{create:s=>s},Alert:{alert:()=>{}},AppState:{addEventListener:(_,fn)=>{listener=fn;return{remove:()=>{removed=true;}};}}},
    'expo-linking':{openURL:async url=>urls.push(url)},
    '@/theme':{colors:{}},'@/components/ui':{ActionButton:'ActionButton'},
    '@/utils/poiDetails':{fuelRefreshMs:240000,fuelDiscrepancyUrl:'https://www.fuel-finder.service.gov.uk/motorist/price-report',fuelLicenceUrl:'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
      fuelPriceSnapshot:(point,signal)=>new Promise((resolve,reject)=>requests.push({point,signal,resolve,reject}))},
  };
  const compiled=ts.transpileModule(readFileSync('src/components/PoiDetails.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const api={};new Function('require','exports','setTimeout','clearTimeout','setInterval','clearInterval',compiled)(name=>imports[name],api,
    (fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},id=>timers.delete(id),
    (fn,ms)=>{const id=++timerId;intervals.set(id,{fn,ms});return id;},id=>intervals.delete(id));
  const props={point:{id:'fuel',category:'fuel',name:'Station'},busy:false,onClose(){},onRide(){},onAdd(){}};
  return {timers,intervals,requests,urls,
    render(){cursor=0;const tree=api.PoiDetails(props);if(!cleanup)cleanup=effect();return tree;},
    resume(){listener('active');},unmount(){cleanup();},get removed(){return removed;}};
}
test('fuel panel provides reporting and OGL links and refreshes, expires and cleans up displayed prices',async()=>{
  const h=harness();let tree=h.render();assert.equal(h.requests.length,1);
  const report=nodes(tree,node=>node.props?.label==='Report a price discrepancy')[0];assert.ok(report);
  await report.props.onPress();await flush();assert.equal(h.urls[0],'https://www.fuel-finder.service.gov.uk/motorist/price-report');
  nodes(tree,node=>node.props?.accessibilityLabel==='Open Government Licence v3.0')[0].props.onPress();await flush();
  assert.match(h.urls[1],/open-government-licence\/version\/3/);
  h.requests[0].resolve({description:'E10: 139.95p/l',expiresAt:Date.now()+1000});await flush();tree=h.render();
  assert.ok(nodes(tree,node=>node.type==='Text').some(node=>node.props.children==='E10: 139.95p/l'));
  assert.equal(h.timers.size,1,'the request timeout clears after success');
  [...h.timers.values()][0].fn();tree=h.render();
  assert.ok(nodes(tree,node=>node.type==='Text').some(node=>node.props.children==='Live prices unavailable'));
  const interval=[...h.intervals.values()][0];assert.equal(interval.ms,240000);interval.fn();assert.equal(h.requests.length,2);
  h.resume();assert.equal(h.requests.length,3);assert.equal(h.requests[1].signal.aborted,true);
  h.requests[1].resolve({description:'stale response',expiresAt:Date.now()+1000});await flush();
  assert.ok(!nodes(h.render(),node=>node.type==='Text').some(node=>node.props.children==='stale response'));
  h.requests[2].reject(new Error('outage'));await flush();tree=h.render();
  assert.ok(nodes(tree,node=>node.type==='Text').some(node=>node.props.children==='Live prices unavailable'));
  h.unmount();assert.equal(h.intervals.size,0);assert.equal(h.timers.size,0);assert.equal(h.removed,true);assert.equal(h.requests[2].signal.aborted,true);
});
