const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, imports={}, globals={}) {
  const compiled=ts.transpileModule(readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const api={};new Function('require','exports',...Object.keys(globals),compiled)(name=>imports[name]??require(name),api,...Object.values(globals));return api;
}
const start={latitude:51.5,longitude:-0.1};
const stops=[{id:'cafe',name:'Cafe',address:'High Street',latitude:51.51,longitude:-0.11},{id:'view',name:'Viewpoint',latitude:51.52,longitude:-0.12},{id:'hotel',name:'Hotel',latitude:51.53,longitude:-0.13}];
const api=load('src/utils/routes.ts');
const nodes=(node,type)=>!node?[]:Array.isArray(node)?node.flatMap(n=>nodes(n,type)):[...(node.type===type?[node]:[]),...nodes(node.props?.children,type)];

test('standard trips preserve the exact chosen stop order and save the editable itinerary',()=>{
  const draft=api.buildStandardTrip(start,stops,'winding');
  assert.deepEqual(draft.route,[start,...stops.map(({latitude,longitude})=>({latitude,longitude}))]);
  assert.deepEqual(draft.stops,stops);
  assert.equal(draft.title,'Hotel via 2 stops');
  const saved=api.tourFromDraft(draft);
  assert.deepEqual(saved.stops,stops);
  assert.notEqual(saved.stops,draft.stops);
  assert.equal(api.buildPointToPoint(start,stops[2],'fast','Hotel').stops[0].name,'Hotel');
  assert.equal(api.buildStandardTrip(start,[stops[0],{...start,id:'return',name:'Home'}],'fast').stops.length,2);
});

test('empty and invalid itineraries fail, while large itineraries retain every stop',()=>{
  assert.throws(()=>api.buildStandardTrip(start,[],'fast'),/destination/);
  assert.throws(()=>api.buildStandardTrip(start,[{...stops[0],latitude:NaN}],'fast'),/invalid location/);
  const many=Array.from({length:1000},(_,i)=>({...stops[0],id:`stop-${i}`}));
  assert.equal(api.buildStandardTrip(start,many,'fast').stops.length,1000);
});

function encode(points){
 let lat=0,lon=0,out='';
 const val=d=>{let n=d<0?~(d<<1):d<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63);};
 for(const p of points){const a=Math.round(p.latitude*1e6),b=Math.round(p.longitude*1e6);val(a-lat);val(b-lon);lat=a;lon=b;}return out;
}
test('one Valhalla request visits every stop as a break, preserving leg geometry and instruction indices',async()=>{
 let request,calls=0;
 const routed=load('src/utils/routes.ts',{}, {fetch:async url=>{
  calls++;request=JSON.parse(new URL(url).searchParams.get('json'));
  const points=[start,...stops];
  return {ok:true,json:async()=>({trip:{status:0,summary:{length:18,time:1500},legs:points.slice(1).map((end,i)=>({shape:encode([points[i],end]),maneuvers:[{type:4,instruction:'Arrive',begin_shape_index:1,end_shape_index:1}]}))}})};
 }});
 const result=await routed.snapDraftToRoads(routed.buildStandardTrip(start,stops,'winding'),{avoidMotorways:true});
 assert.equal(calls,1);
 assert.deepEqual(request.locations.map(p=>[p.lat,p.lon,p.type]),[start,...stops].map(p=>[p.latitude,p.longitude,'break']));
 assert.deepEqual(result.route,[start,...stops.map(({latitude,longitude})=>({latitude,longitude}))]);
 assert.deepEqual(result.maneuvers.map(m=>m.beginShapeIndex),[1,2,3]);
 assert.deepEqual(result.stops,stops);
 assert.equal(request.costing_options.motorcycle.use_highways,0.05);
});

test('OSRM fallback retains all stops and permits turns back at actual stops',async()=>{
 let url;
 const routing=load('src/utils/routes.ts',{}, {fetch:async u=>{
  if(u.includes('valhalla'))return {ok:false};url=u;
  return {ok:true,json:async()=>({code:'Ok',routes:[{distance:18000,duration:1500,geometry:{coordinates:[start,...stops].map(p=>[p.longitude,p.latitude])}}]})};
 }});
 await routing.snapDraftToRoads(routing.buildStandardTrip(start,stops,'fast'),{avoidMotorways:false});
 assert.match(url,/continue_straight=false/);
 assert.equal(new URL(url).pathname.split('/').at(-1).split(';').length,4);
});

function plannerHarness(initial=stops){
 const slots=[];let cursor=0,element;const actions=[];
 let props={stops:initial,center:start,busy:false,avoidMotorways:true,onChange:next=>{props.stops=next;},onPlan:()=>actions.push('plan'),onCancel:()=>actions.push('cancel'),onAvoidMotorwaysChange:()=>actions.push('motorways')};
 const jsx=(type,props)=>({type,props:type==='FlatList'?{...props,children:props.data.map((item,index)=>props.renderItem({item,index}))}:props});
 const {StandardTripPlanner}=load('src/components/StandardTripPlanner.tsx',{
  react:{useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],next=>{slots[i]=next;}];}},
  'react/jsx-runtime':{jsx,jsxs:jsx},
  'react-native':{Pressable:'Pressable',FlatList:'FlatList',Text:'Text',View:'View',StyleSheet:{create:s=>s}},
  'react-native-safe-area-context':{useSafeAreaInsets:()=>({bottom:34})},
  '@expo/vector-icons/Ionicons':{default:'Icon'},
  '@/components/DestinationSearch':{DestinationSearch:'DestinationSearch'},
  '@/components/ui':{ActionButton:'ActionButton',Sheet:'Sheet',ToggleRow:'ToggleRow'},
  '@/theme':{colors:{}},'@/utils/routes':api,
 });
 return{actions,get stops(){return props.stops;},get tree(){return element;},render(extra={}){props={...props,...extra};cursor=0;element=StandardTripPlanner(props);return element;},press(label){const n=[...nodes(element,'Pressable'),...nodes(element,'ActionButton')].find(n=>(n.props.label??n.props.accessibilityLabel)===label);assert.ok(n,label);assert.ok(!n.props.disabled,label);n.props.onPress();},searchSelect(place){const search=nodes(element,'DestinationSearch')[0];assert.ok(search);search.props.onSelect(place);}};
}
test('adding a stop inserts before the destination, and places can be replaced, reordered and removed',()=>{
 const h=plannerHarness();h.render();h.press('Add stop');h.render();h.searchSelect({...stops[0],id:'fuel',name:'Fuel'});h.render();
 assert.deepEqual(h.stops.map(p=>p.id),['cafe','view','fuel','hotel']);
 h.press('Move stop C up');h.render();assert.deepEqual(h.stops.map(p=>p.id),['cafe','fuel','view','hotel']);
 h.press('Move stop A down');h.render();assert.deepEqual(h.stops.map(p=>p.id),['fuel','cafe','view','hotel']);
 h.press('Remove stop B: Cafe');h.render();assert.deepEqual(h.stops.map(p=>p.id),['fuel','view','hotel']);
 h.press('Change destination: Hotel');h.render();h.searchSelect({...stops[2],id:'new',name:'New Hotel'});h.render();assert.equal(h.stops.at(-1).name,'New Hotel');
 h.press('Create route');assert.deepEqual(h.actions,['plan']);
});
test('cancelled search keeps stops, empty trips cannot be planned, and adding stops stays available beyond Z',()=>{
 const h=plannerHarness([]);h.render();
 assert.equal(nodes(h.tree,'ActionButton').find(n=>n.props.label==='Create route').props.disabled,true);
 h.press('Add destination');h.render();h.searchSelect(stops[2]);h.render();assert.equal(h.stops[0].id,'hotel');
 h.press('Add stop');h.render();nodes(h.tree,'DestinationSearch')[0].props.onExpandedChange(false);h.render();assert.equal(h.stops.length,1);
 h.render({stops:Array.from({length:30},(_,i)=>({...stops[0],id:`${i}`}))});
 assert.equal(nodes(h.tree,'ActionButton').find(n=>n.props.label==='Add stop').props.disabled,false);
 h.press('Add stop');h.render();h.searchSelect({...stops[0],id:'extra'});h.render();assert.equal(h.stops.length,31);
 assert.ok(nodes(h.tree,'Text').some(n=>n.props.children==='AE'));
 h.render({busy:true});assert.ok(nodes(h.tree,'Pressable').every(n=>n.props.disabled));
});

test('stop letters continue beyond Z and ZZ without collisions',()=>{
 assert.deepEqual([0,1,25,26,27,51,52,701,702].map(api.tripStopLabel),['A','B','Z','AA','AB','AZ','BA','ZZ','AAA']);
});
const longStops=Array.from({length:28},(_,i)=>({id:`s${i}`,name:`Place ${i}`,latitude:Number((51.5+(i+1)/1000).toFixed(6)),longitude:-0.1}));
function sectionResponse(points){
 return {ok:true,json:async()=>({trip:{status:0,summary:{length:1.4,time:20},legs:points.slice(1).map((p,i)=>({shape:encode([points[i],p]),maneuvers:[{type:4,instruction:'Arrive',begin_shape_index:1,end_shape_index:1}]}))}})};
}
test('long trips route every stop, join sections and offset instructions, rounding totals only once',async()=>{
 const requests=[];
 const routing=load('src/utils/routes.ts',{}, {fetch:async url=>{
  const request=JSON.parse(new URL(url).searchParams.get('json'));requests.push(request);
  return sectionResponse(request.locations.map(p=>({latitude:p.lat,longitude:p.lon})));
 }});
 const result=await routing.snapDraftToRoads(routing.buildStandardTrip(start,longStops,'winding'),{avoidMotorways:true,heading:90});
 assert.equal(requests.length,4);
 assert.ok(requests.every(r=>r.locations.length<=10 && r.locations.every(p=>p.type==='break')));
 assert.equal(requests[0].locations[0].heading,90);
 assert.equal(requests[1].locations[0].heading,undefined);
 assert.deepEqual(result.route,[start,...longStops.map(({latitude,longitude})=>({latitude,longitude}))]);
 assert.deepEqual(result.maneuvers.map(m=>m.beginShapeIndex),Array.from({length:28},(_,i)=>i+1));
 assert.equal(result.distanceKm,6);assert.equal(result.durationMin,1);
 assert.equal(result.stops.length,28);assert.equal(result.stops.at(-1).id,'s27');
});
test('a failed later section rejects the entire itinerary instead of returning a partial route',async()=>{
 let calls=0;
 const routing=load('src/utils/routes.ts',{}, {fetch:async url=>{
  calls++;if(calls===2)return {ok:false};
  const request=JSON.parse(new URL(url).searchParams.get('json'));
  return sectionResponse(request.locations.map(p=>({latitude:p.lat,longitude:p.lon})));
 }});
 await assert.rejects(routing.snapDraftToRoads(routing.buildStandardTrip(start,longStops,'fast'),{avoidMotorways:true}),/could not be calculated/);
 assert.equal(calls,2);
});
test('incompatible snapping at a shared stop fails instead of drawing a false connector',async()=>{
 let calls=0;
 const routing=load('src/utils/routes.ts',{}, {fetch:async url=>{
  const request=JSON.parse(new URL(url).searchParams.get('json'));
  const points=request.locations.map(p=>({latitude:p.lat,longitude:p.lon}));
  if(++calls===2)points[0].latitude+=0.01;
  return sectionResponse(points);
 }});
 await assert.rejects(routing.snapDraftToRoads(routing.buildStandardTrip(start,longStops,'fast'),{avoidMotorways:true}),/joined at stop I/);
});
test('long OSRM fallback trips keep the full itinerary and do not invent turn guidance',async()=>{
 let osrmCalls=0;
 const routing=load('src/utils/routes.ts',{}, {fetch:async url=>{
  if(url.includes('valhalla'))return {ok:false};osrmCalls++;
  const points=new URL(url).pathname.split('/').at(-1).split(';').map(p=>p.split(',').map(Number));
  return {ok:true,json:async()=>({code:'Ok',routes:[{distance:1400,duration:20,geometry:{coordinates:points}}]})};
 }});
 const result=await routing.snapDraftToRoads(routing.buildStandardTrip(start,longStops,'fast'),{avoidMotorways:false});
 assert.equal(osrmCalls,4);assert.equal(result.route.length,29);assert.equal(result.stops.length,28);
 assert.equal(result.maneuvers,undefined);assert.equal(result.distanceKm,6);
});
