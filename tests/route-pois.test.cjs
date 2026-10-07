const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, imports = {}, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(path.join(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const api = {};
  new Function('require', 'exports', ...Object.keys(globals), compiled)(name => imports[name] ?? require(name), api, ...Object.values(globals));
  return api;
}
const routes = load('src/utils/routes.ts');
const service = (requestOverpass = async () => ({elements:[]})) => load('src/utils/routePois.ts', { '@/utils/routes': routes, '@/utils/pois': {requestOverpass} });
const point = (x, y) => ({longitude:x/111195,latitude:y/111195});
const loop = [point(0,0),point(5000,0),point(5000,5000),point(0,5000),point(0,0)];
const poi = (id,x,y,name=id) => ({id,name,...point(x,y),category:'sight',detail:'viewpoint'});

test('highlights project onto full route segments, exclude distant places and number in riding order', () => {
  const items = service().pointsAlongRoute(loop,[poi('late',2500,5050),poi('far',2500,1000),poi('first',1000,40),poi('middle',4900,2000)]);
  assert.deepEqual(items.map(p=>[p.id,p.number]),[['first',1],['middle',2],['late',3]]);
  assert.ok(Math.abs(items[0].distanceAlongKm-1)<0.001);
  assert.ok(Math.abs(items[0].distanceFromRouteKm-0.04)<0.001);
  assert.deepEqual(items[0].routePoint,point(1000,0));
  assert.ok(Math.abs(items[1].distanceAlongKm-7)<0.001);
  assert.equal(items[1].routePoint.longitude,loop[1].longitude);
});

test('duplicates, invalid coordinates and closed-loop start duplication are handled', () => {
  const items = service().pointsAlongRoute(loop,[poi('a',0,0,'Start'),poi('a',0,0,'Start'),poi('b',10,0,'Start'),poi('bad',NaN,0)]);
  assert.equal(items.length,1);
  assert.equal(items[0].distanceAlongKm,0);
  assert.deepEqual(service().pointsAlongRoute([],items),[]);
  assert.deepEqual(service().pointsAlongRoute([point(0,0)],items),[]);
});

test('dense highlights are limited and spread along the route, keeping stable numbers', () => {
  const items = service().pointsAlongRoute([point(0,0),point(10000,0)],Array.from({length:100},(_,i)=>poi(`place-${i}`,i*100,10)));
  assert.equal(items.length,24);
  assert.equal(items[0].id,'place-0');
  assert.equal(items.at(-1).id,'place-99');
  assert.deepEqual(items.map(p=>p.number),Array.from({length:24},(_,i)=>i+1));
});

test('place details preserve names, categories and addresses from real OSM metadata', () => {
  const items=service().parseRoutePois([
    {type:'node',id:1,lat:0,lon:0,tags:{name:'Riders Cafe',amenity:'cafe','addr:street':'High Street'}},
    {type:'way',id:2,center:{lat:0,lon:0},tags:{name:'Wood',natural:'wood'}},
    {type:'node',id:3,lat:0,lon:0,tags:{name:'Pass',mountain_pass:'yes'}},
    {type:'node',id:4,lat:200,lon:0,tags:{name:'Bad'}},
    {type:'node',id:5,lat:0,lon:0,tags:{}},
  ]);
  assert.equal(items.length,3);
  assert.equal(items[0].detail,'cafe · High Street');
  assert.deepEqual(items.map(p=>p.category),['meet','forest','pass']);
});

test('corridor query retains a closed loop and returns only places near the final road geometry', async () => {
  let query, signal;
  const controller = new AbortController();
  const api=service(async (q,s)=>{query=q;signal=s;return {elements:[
    {type:'node',id:1,lat:0.0002,lon:0.01,tags:{name:'Roadside',tourism:'viewpoint'}},
    {type:'node',id:2,lat:0.02,lon:0.02,tags:{name:'Far away',tourism:'viewpoint'}},
  ]};});
  const items=await api.fetchRoutePois(loop,controller.signal);
  assert.match(query,/around:350,0.000000,0.000000,0.000000,0.044966/);
  assert.match(query,/out center 1000/);
  assert.equal(signal,controller.signal);
  assert.deepEqual(items.map(p=>p.name),['Roadside']);
});

test('POI lookup posts large queries, retries service errors and honours cancellation', async () => {
  const calls=[];
  const {requestOverpass}=load('src/utils/pois.ts',{}, {fetch:async (url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=> calls.length===1?{remark:'timeout',elements:[]}:{elements:[]}};
  }});
  await requestOverpass('query with & symbols');
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.body,'data=query%20with%20%26%20symbols');
  const controller=new AbortController();controller.abort();
  await assert.rejects(requestOverpass('ignored',controller.signal),/cancelled/);
  assert.equal(calls.length,2);
});

function hookHarness() {
  const slots=[];const requests=[];let cursor=0,effects=[],output;
  const react={
    useState:initial=>{const i=cursor++;slots[i]??={value:initial};return [slots[i].value,next=>{slots[i].value=typeof next==='function'?next(slots[i].value):next;}];},
    useEffect:(effect,deps)=>{const i=cursor++,prev=slots[i];if(prev&&deps.every((d,n)=>Object.is(d,prev.deps[n])))return;effects.push(()=>{prev?.cleanup?.();slots[i]={deps,cleanup:effect()};});},
  };
  const {useRoutePois}=load('src/hooks/useRoutePois.ts',{react,'@/utils/routePois':{fetchRoutePois:(route,signal)=>new Promise((resolve,reject)=>requests.push({route,signal,resolve,reject}))}});
  return {requests,get output(){return output;},render(route){cursor=0;effects=[];output=useRoutePois(route);effects.forEach(f=>f());},unmount(){slots.forEach(s=>s?.cleanup?.());}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('leaving preview or replacing the route cancels lookup and ignores stale results',async()=>{
  const h=hookHarness();h.render(loop);
  assert.equal(h.output.loading,true);
  const changed=loop.slice().reverse();h.render(changed);
  assert.equal(h.requests[0].signal.aborted,true);
  h.requests[0].resolve([poi('old',0,0)]);await flush();h.render(changed);
  assert.deepEqual(h.output.points,[]);
  h.requests[1].resolve([poi('new',0,0)]);await flush();h.render(changed);
  assert.equal(h.output.points[0].id,'new');
  h.render(undefined);
  assert.deepEqual(h.output.points,[]);
  assert.equal(h.output.loading,false);
  assert.equal(h.requests[1].signal.aborted,true);
});

test('lookup failure offers retry without changing the route',async()=>{
  const h=hookHarness();h.render(loop);h.requests[0].reject(new Error('offline'));await flush();h.render(loop);
  assert.equal(h.output.error,true);h.output.retry();h.render(loop);
  assert.equal(h.output.loading,true);assert.equal(h.requests[1].route,loop);
  h.requests[1].resolve([]);await flush();h.render(loop);
  assert.equal(h.output.error,false);assert.equal(h.output.loading,false);h.unmount();
});

test('cards show matching numbers and details, scrolling and taps select the matching point',()=>{
  const items=service().pointsAlongRoute(loop,[poi('first',1000,40),poi('second',4900,2000)]);
  let selected,scrolled;const effects=[];
  const jsx=(type,props)=>({type,props});
  const {RoutePoiCards}=load('src/components/RoutePoiCards.tsx',{
    react:{useRef:()=>({current:{scrollTo:options=>{scrolled=options;}}}),useState:v=>[v,()=>{}],useEffect:fn=>effects.push(fn)},
    'react/jsx-runtime':{jsx,jsxs:jsx},
    'react-native':{ActivityIndicator:'ActivityIndicator',Pressable:'Pressable',ScrollView:'ScrollView',Text:'Text',View:'View',StyleSheet:{create:x=>x}},
    '@/theme':{colors:{}},
  });
  const nodes=(node,type)=>!node?[]:Array.isArray(node)?node.flatMap(n=>nodes(n,type)):[...(node.type===type?[node]:[]),...nodes(node.props?.children,type)];
  const tree=RoutePoiCards({points:items,selectedId:items[1].id,tint:'#ec3347',loading:false,error:false,onSelect:p=>{selected=p;},onRetry:()=>{}});
  effects.forEach(f=>f());assert.equal(scrolled.x,290);
  const cards=nodes(tree,'Pressable');assert.equal(cards.length,2);
  assert.match(cards[0].props.accessibilityLabel,/Point 1, first, 1.0 kilometres/);
  cards[0].props.onPress();assert.equal(selected.id,'first');
  const scroll=nodes(tree,'ScrollView')[0];assert.equal(scroll.props.horizontal,true);
  scroll.props.onMomentumScrollEnd({nativeEvent:{contentOffset:{x:0}}});assert.equal(selected.id,'first');
  assert.equal(cards[1].props.accessibilityState.selected,true);
});
