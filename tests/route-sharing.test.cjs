const assert=require('node:assert/strict');
const {test}=require('node:test');
const {readFileSync}=require('node:fs');
const path=require('node:path'),ts=require('typescript');
function load(file,imports={},globals={}) {
 const module={exports:{}};new Function('module','exports','require',...Object.keys(globals),ts.transpileModule(readFileSync(path.join(__dirname,'../',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(module,module.exports,name=>imports[name],...Object.values(globals));return module.exports;
}
const a={latitude:51.5,longitude:-0.1},b={latitude:51.51,longitude:-0.11};
const shared={version:1,avoidMotorways:true,route:{title:'A ride',profile:'winding',route:[a,b,a],roundTrip:false,distanceKm:4,durationMin:8,curves:1,stops:[{...b,id:'b',name:'First'},{...a,id:'a',name:'Return'}],maneuvers:[{type:1,instruction:'Continue',beginShapeIndex:0,endShapeIndex:1}]}};
const id='a'.repeat(32);
test('sharing uploads all planning data and returns a short HTTPS link, loading needs no pilot credentials',async()=>{
 const calls=[],globals={process:{env:{EXPO_PUBLIC_ROUTING_URL:'https://routing.test/',EXPO_PUBLIC_ROUTING_TOKEN:'test-only'}},fetch:async(url,options)=>{
  calls.push({url,options});return {ok:true,text:async()=>JSON.stringify(options.method==='POST'?{id}:shared)};
 }};
 const api=load('src/utils/routeSharing.ts',{},globals);
 assert.equal(await api.createRouteShare(shared.route,true),`https://routing.test/shared/${id}`);
 assert.deepEqual(JSON.parse(calls[0].options.body),shared);
 assert.equal(calls[0].options.headers.Authorization,'Bearer test-only');
 assert.deepEqual(await api.loadRouteShare(id),shared);
 assert.equal(calls[1].options.headers,undefined);
 await assert.rejects(api.loadRouteShare('../token'));
 assert.equal(calls.length,2);
 assert.deepEqual(api.parseSharedRoute({...shared,token:'secret',route:{...shared.route,recording:{active:true}}}),shared);
 for(const bad of [{...shared,version:2},{...shared,route:{...shared.route,route:[]}}, {...shared,route:{...shared.route,stops:[{...b,name:'bad'}]}}, {...shared,route:{...shared.route,maneuvers:[{...shared.route.maneuvers[0],endShapeIndex:100}]}}])assert.throws(()=>api.parseSharedRoute(bad));
});
test('expired and unavailable shares surface a clear error',async()=>{
 for(const status of [404,410]) {
  const api=load('src/utils/routeSharing.ts',{}, {process:{env:{EXPO_PUBLIC_ROUTING_URL:'https://routing.test'}},fetch:async()=>({ok:false,status})});
  await assert.rejects(api.loadRouteShare(id),/unavailable or has expired/);
 }
});
test('adding search stops without addresses and arrival maneuvers without optional text remains shareable',async()=>{
 const places=load('src/utils/places.ts');
 const stops=places.parsePlaceSuggestions({features:[{geometry:{type:'Point',coordinates:[b.longitude,b.latitude]},properties:{osm_id:1,name:'First stop'}},{geometry:{type:'Point',coordinates:[a.longitude,a.latitude]},properties:{osm_id:2,name:'Return'}}]});
 assert.ok(stops.every(s=>s.address===''));
 const routes=load('src/utils/routes.ts');
 const draft={...routes.buildStandardTrip(a,stops,'winding'),route:shared.route.route,maneuvers:[{type:4,instruction:'Arrive at stop.',beginShapeIndex:1,endShapeIndex:1,spokenInstruction:'',streetName:'   ',bearingAfter:0},{type:4,instruction:'Arrive at destination.',beginShapeIndex:2,endShapeIndex:2,spokenInstruction:null,streetName:null}]};
 const {validateSharedRoute}=await import('../routing/catalogue/service/route-shares.mjs');
 let uploaded;
 const api=load('src/utils/routeSharing.ts',{}, {process:{env:{EXPO_PUBLIC_ROUTING_URL:'https://routing.test'}},fetch:async(_url,options)=>{
  uploaded=validateSharedRoute(JSON.parse(options.body));return {ok:true,text:async()=>JSON.stringify({id})};
 }});
 assert.equal(await api.createRouteShare(draft,true),`https://routing.test/shared/${id}`);
 assert.deepEqual(uploaded.route.stops.map(s=>[s.id,s.name,s.latitude,s.longitude]),stops.map(s=>[s.id,s.name,s.latitude,s.longitude]));
 assert.deepEqual(uploaded.route.route,draft.route);
 assert.deepEqual(uploaded.route.maneuvers,[{type:4,instruction:'Arrive at stop.',beginShapeIndex:1,endShapeIndex:1,bearingAfter:0},{type:4,instruction:'Arrive at destination.',beginShapeIndex:2,endShapeIndex:2}]);
 assert.ok(uploaded.route.stops.every(s=>!('address' in s)));
 for(const invalid of [42,{},'x'.repeat(2001)]) {
  const malformed={...draft,maneuvers:[{...draft.maneuvers[0],spokenInstruction:invalid}]};
  assert.throws(()=>api.parseSharedRoute({version:1,route:malformed,avoidMotorways:true}));
 }
});
function importHarness({active=null,ready=true,fail=false}={}) {
 const routes=[],settings=[],replaced=[],errors=[];let effect,resolve;
 const jsx=(type,props)=>({type,props});
 const imports={react:{useRef:v=>({current:v}),useState:v=>[v,value=>errors.push(value)],useEffect:fn=>effect=fn},
  'react/jsx-runtime':{jsx,jsxs:jsx},'react-native':{StyleSheet:{create:v=>v},View:'View',Text:'Text'},
  'expo-router':{useLocalSearchParams:()=>({id}),router:{replace:value=>replaced.push(value)}},
  '@/state/AppProvider':{useApp:()=>({ready,setActiveRoute:v=>routes.push(v),updateSettings:v=>settings.push(v)})},
  '@/services/rideStore':{readRideState:()=>({active})},
  '@/utils/routeSharing':{loadRouteShare:()=>new Promise((r,j)=>{resolve=()=>fail?j(Error('Expired')):r(shared)})},
  '@/components/ui':{ActionButton:'ActionButton'},'@/theme':{colors:{}},
 };
 const Screen=load('src/app/shared/[id].tsx',imports).default;Screen();const cleanup=effect();
 return {routes,settings,replaced,errors,cleanup,resolve:()=>resolve?.(),setActive:v=>active=v};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('cold and warm shared links load editable previews without starting a ride',async()=>{
 const h=importHarness();h.resolve();await settle();
 assert.deepEqual(h.routes,[shared.route]);assert.deepEqual(h.settings,[{routingProfile:'winding',avoidMotorways:true}]);
 assert.equal(h.replaced[0].pathname,'/ride');assert.ok(h.replaced[0].params.imported.startsWith(id+'-'));assert.deepEqual(h.errors,[]);
 h.cleanup();
});
test('imports wait for app recovery, protect active rides and ignore cancelled or stale fetches',async()=>{
 const loading=importHarness({ready:false});loading.resolve();await settle();assert.deepEqual(loading.routes,[]);
 const riding=importHarness({active:{session:{activeSince:123}}});await settle();assert.match(riding.errors[0],/current ride/);assert.deepEqual(riding.routes,[]);
 const late=importHarness();late.setActive({session:{activeSince:123}});late.resolve();await settle();assert.deepEqual(late.routes,[]);assert.match(late.errors[0],/current ride/);
 const cancelled=importHarness();cancelled.cleanup();cancelled.resolve();await settle();assert.deepEqual(cancelled.routes,[]);assert.deepEqual(cancelled.replaced,[]);
 const failed=importHarness({fail:true});failed.resolve();await settle();assert.deepEqual(failed.routes,[]);assert.deepEqual(failed.errors,['Expired']);
});
test('preview shares once with all stops, and editing replans from the shared origin',async()=>{
 const state=[],refs=[],shares=[],sheet=[],planned=[],activated=[],savedTours=[];let activeDraft=shared.route;let cursor=0,refCursor=0,resolveShare,gpsCalls=0;
 const jsx=(type,props)=>({type,props});
 const imports={react:{useState:v=>{const i=cursor++;if(!(i in state))state[i]=v;return [state[i],n=>state[i]=typeof n==='function'?n(state[i]):n];},useRef:v=>refs[refCursor++]??={current:v},useEffect(){},useMemo:fn=>fn(),useCallback:fn=>fn},
  'react/jsx-runtime':{jsx,jsxs:jsx},
  'react-native':{useWindowDimensions:()=>({height:844,width:390}),StyleSheet:{create:v=>v},View:'View',Text:'Text',Share:{share:async v=>sheet.push(v)},Alert:{alert:()=>assert.fail('Unexpected alert')}},
  'expo-router':{Tabs:{Screen:'Screen'},useLocalSearchParams:()=>({})},
  'expo-haptics':{NotificationFeedbackType:{},notificationAsync:async()=>{}},'expo-location':{requestForegroundPermissionsAsync:async()=>{gpsCalls++;return {granted:false}}},
  'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0,bottom:0})},
  '@/state/AppProvider':{useApp:()=>({activeRoute:activeDraft,tours:savedTours,saveTour:tour=>savedTours.push(tour),toggleSaved:id=>{const tour=savedTours.find(t=>t.id===id);tour.saved=!tour.saved;},settings:{routingProfile:'winding',avoidMotorways:true},setActiveRoute:r=>{activated.push(r);activeDraft=r;}})},
  '@/components/RoutePreviewSheet':{RoutePreviewSheet:'RoutePreviewSheet'},'@/components/SavedToast':{SavedToast:'SavedToast'},'@/utils/savedRoutes':load('src/utils/savedRoutes.ts'),
  '@/components/ui':{Sheet:'Sheet',ActionButton:'ActionButton',IconButton:'IconButton',Stat:'Stat'},
  '@/components/PoiDetails': { PoiDetails: 'PoiDetails' }, '@/components/RideMap':{RideMap:'RideMap'},'@/components/DriveOverlay':{},'@/components/RoutePoiCards':{},'@/components/DestinationSearch':{},'@/components/StandardTripPlanner':{StandardTripPlanner:'Planner'},
  '@/hooks/useRoutePois':{useRoutePois:()=>({points:[]})},'@/data/routeColors':{},'@/data/seed':{defaultCenter:{latitude:52,longitude:0},nearbyPlaces:[]},'@/theme':{colors:{},spacing:{}},
  '@/utils/roundTripArea':{coneRadiusKm:()=>10},'@/utils/guidance':{upcomingManeuver:()=>null},'@/utils/navigation':{cumulativeRouteDistances:()=>[]},
  '@/utils/recording':{formatRidingTime:()=>''},'@/utils/pois':{},'@/services/rideTracking':{},
  '@/utils/routes':{tourFromDraft:r=>({...r,id:'saved-draft',saved:true,completed:false}),formatDuration:()=>'',buildStandardTrip:(...args)=>{planned.push(args);return {...shared.route,title:'Edited route',stops:args[1]}},snapDraftToRoads:async r=>r},
  '@/utils/routeSharing':{createRouteShare:(...args)=>{shares.push(args);return new Promise(r=>resolveShare=r)}},
 };
 const Screen=load('src/app/ride.tsx',imports).default;
 const render=()=>{cursor=refCursor=0;return Screen();};
 const find=(node,predicate)=>{if(!node||typeof node!=='object')return;if(predicate(node))return node;for(const child of [node.props?.children].flat(Infinity)){const found=find(child,predicate);if(found)return found;}};
 let tree=render();
 const save=find(tree,n=>n.props?.label==='Save tour');assert.equal(save.props.icon,'bookmark-outline');save.props.onPress();
 tree=render();const saved=find(tree,n=>n.props?.label==='Remove from saves');assert.equal(saved.props.icon,'bookmark');assert.equal(saved.props.active,true);
 assert.equal(find(tree,n=>n.type==='SavedToast').props.saved,true);
 saved.props.onPress();tree=render();assert.equal(savedTours.length,1);assert.equal(savedTours[0].saved,false);
 assert.equal(find(tree,n=>n.type==='SavedToast').props.saved,false);
 assert.equal(find(tree,n=>n.props?.label==='Save tour').props.icon,'bookmark-outline');
 find(tree,n=>n.props?.label==='Save tour').props.onPress();tree=render();
 assert.equal(savedTours.length,1);assert.equal(savedTours[0].saved,true);
 assert.equal(find(tree,n=>n.type==='SavedToast').props.saved,true);
 const button=find(tree,n=>n.props?.label==='Share route');assert.ok(button);
 const first=button.props.onPress(),second=button.props.onPress();assert.equal(shares.length,1);assert.deepEqual(shares[0],[shared.route,true]);
 resolveShare(`https://routing.test/shared/${id}`);await Promise.all([first,second]);assert.equal(sheet.length,1);assert.ok(sheet[0].message.includes(id));
 const place={...a,id:'fuel-stop',name:'Fuel stop',category:'fuel',detail:'Fuel station'};
 find(tree,n=>n.type==='RideMap').props.onPoiSelect(place);tree=render();
 const details=find(tree,n=>n.type==='PoiDetails');assert.equal(details.props.point,place);
 assert.equal(typeof details.props.onRide,'function');details.props.onAdd(place);tree=render();
 const poiEditor=find(tree,n=>n.type==='Planner');
 assert.deepEqual(poiEditor.props.stops.map(stop=>stop.id),[shared.route.stops[0].id,place.id,shared.route.stops[1].id]);
 assert.deepEqual(poiEditor.props.start,a);poiEditor.props.onCancel();tree=render();
 find(tree,n=>n.props?.label?.startsWith('Add / edit stops')).props.onPress();tree=render();
 const planner=find(tree,n=>n.type==='Planner');assert.deepEqual(planner.props.stops,shared.route.stops);assert.deepEqual(planner.props.start,a);
 await planner.props.onPlan();assert.deepEqual(planned[0],[a,shared.route.stops,'winding']);assert.equal(gpsCalls,0);assert.equal(activated.length,1);
 tree=render();assert.equal(find(tree,n=>n.props?.label==='Save tour').props.icon,'bookmark-outline');find(tree,n=>n.props?.label?.startsWith('Add / edit stops')).props.onPress();tree=render();
 const editor=find(tree,n=>n.type==='Planner');
 const edited=[shared.route.stops[0],{...a,id:'extra',name:'Added stop'},shared.route.stops[1]];
 editor.props.onChange(edited);tree=render();
 const currentEditor=find(tree,n=>n.type==='Planner');assert.equal(typeof currentEditor.props.onShare,'function');
 const shareEdited=currentEditor.props.onShare(),duplicate=currentEditor.props.onShare();await settle();
 assert.equal(shares.length,2);assert.equal(planned.length,2);
 assert.equal(shares[1][0].title,'Edited route');assert.deepEqual(shares[1][0].stops,edited);
 assert.deepEqual(planned[1],[a,edited,'winding']);assert.equal(gpsCalls,0);
 resolveShare(`https://routing.test/shared/${id}`);await Promise.all([shareEdited,duplicate]);
 assert.equal(sheet.length,2);assert.equal(sheet[1].title,'Edited route');
});
