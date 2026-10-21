const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const ts = require('typescript');
function load(file, globals={}) {
  const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={};new Function('require','exports',...Object.keys(globals),compiled)(require,exports,...Object.values(globals));return exports;
}
const pois=load('src/utils/pois.ts');
test('biker venues require a reviewed name and matching location, excluding generic pubs and namesakes',()=>{
  const element={id:1,type:'node',lat:51.5406,lon:-0.2786,tags:{name:'Ace Cafe',amenity:'cafe'}};
  assert.equal(pois.poiFromElement(element,'meet').category,'meet');
  assert.equal(pois.poiFromElement({...element,tags:{name:'The Red Lion'}},'meet'),undefined);
  assert.equal(pois.poiFromElement({...element,lat:55},'meet'),undefined);
});
test('forest stops use an inside public road vertex and exclude parks, private roads and tracks',()=>{
  const forest={id:1,type:'way',tags:{name:'Forest',natural:'wood'},geometry:[{lat:0,lon:0},{lat:0,lon:1},{lat:1,lon:1},{lat:1,lon:0},{lat:0,lon:0}]};
  const road={id:2,type:'way',tags:{highway:'secondary',name:'Forest Drive'},geometry:[{lat:0.5,lon:0.5}]};
  assert.equal(pois.forestRoadPois([forest,road])[0].latitude,0.5);
  for (const tags of [{highway:'track'},{highway:'secondary',access:'private'},{highway:'secondary',motorcycle:'no'},{highway:'secondary',surface:'gravel'}]) {
    assert.deepEqual(pois.forestRoadPois([forest,{...road,tags}]),[]);
  }
  assert.deepEqual(pois.forestRoadPois([{...forest,tags:{name:'Park',leisure:'nature_reserve'}},road]),[]);
  assert.deepEqual(pois.forestRoadPois([forest,{...road,geometry:[{lat:2,lon:2}]}]),[]);
});
test('highlight metadata links to the actual photo and description',()=>{
  const point=pois.poiFromElement({id:1,type:'node',lat:51,lon:0,tags:{name:'Castle',wikipedia:'en:Castle',wikimedia_commons:'File:Castle.jpg'}},'sight');
  assert.match(point.imageUrl,/Special:FilePath\/Castle.jpg/);
  assert.equal(point.moreUrl,'https://en.wikipedia.org/wiki/Castle');
});
test('fuel display validates match, freshness, units and prices, and handles unconfigured service',async()=>{
  const point={latitude:51,longitude:0,name:'Station'};
  const signal=new AbortController().signal;
  const data={...point,checkedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),currency:'GBP',unit:'pence/litre',prices:[{fuel:'E10',amount:139.9,updatedAt:new Date().toISOString()}]};
  const service=(body)=>load('src/utils/poiDetails.ts',{process:{env:{EXPO_PUBLIC_FUEL_PRICES_URL:'https://example.com/fuel'}},fetch:async()=>({ok:true,json:async()=>body})});
  assert.match(await service(data).fuelPriceDescription(point,signal),/E10: 139.9p\/l/);
  for(const changes of [{latitude:51.5},{checkedAt:'2020-01-01'},{currency:'EUR'},{unit:'litres'},{prices:[{fuel:'E10',amount:-1}]}]){
    assert.equal(await service({...data,...changes}).fuelPriceDescription(point,signal),'Live prices unavailable');
  }
  const disabled=load('src/utils/poiDetails.ts',{process:{env:{}}});
  assert.equal(await disabled.fuelPriceDescription(point,signal),'Live prices unavailable');
});


test('fuel snapshots distinguish upstream checks from unchanged price timestamps and preserve exact data',async()=>{
  const point={latitude:51,longitude:0,name:'Station'};
  const checkedAt=new Date().toISOString();
  const updatedAt='2020-01-01T10:00:00+00:00';
  const data={...point,checkedAt,updatedAt,currency:'GBP',unit:'pence/litre',source:'Fuel Finder',prices:[
    {fuel:'E10',amount:'139.95',updatedAt}, {fuel:'B7',amount:'145.900',updatedAt},
  ]};
  const service=(body)=>load('src/utils/poiDetails.ts',{process:{env:{EXPO_PUBLIC_FUEL_PRICES_URL:'https://example.com/fuel'}},fetch:async()=>({ok:true,json:async()=>body})});
  const signal=new AbortController().signal;
  const snapshot=await service(data).fuelPriceSnapshot(point,signal);
  assert.match(snapshot.description,/139.95p\/l/);assert.match(snapshot.description,/145.900p\/l/);
  assert.ok(snapshot.description.includes(updatedAt));assert.ok(snapshot.description.includes(checkedAt));
  assert.equal(snapshot.expiresAt,Date.parse(checkedAt)+300000);
  for(const changes of [{checkedAt:undefined},{checkedAt:new Date(Date.now()-300001).toISOString()},
    {checkedAt:new Date(Date.now()+120000).toISOString()}, {updatedAt:'invalid'},
    {prices:[data.prices[0],{fuel:'B7',amount:-1,updatedAt}]}, {prices:[{fuel:'E10',amount:139.95}]}]){
    assert.equal(await service({...data,...changes}).fuelPriceSnapshot(point,signal),null);
  }
});

test('app uses authenticated server POIs and retains stable Fuel Finder station identity',async()=>{
  const calls=[];
  const service=load('src/utils/pois.ts',{process:{env:{EXPO_PUBLIC_POI_URL:'https://api.example.com/pois',EXPO_PUBLIC_ROUTING_TOKEN:'public-pilot-token'}},fetch:async(url,options)=>{
    calls.push({url,options});return{ok:true,json:async()=>({points:[{id:'fuel-finder-one',fuelStationId:'one',category:'fuel',name:'Station',latitude:51,longitude:0,detail:'Fuel'}]})};
  }});
  const signal=new AbortController().signal;
  const points=await service.fetchNearbyPois('fuel',{latitude:51,longitude:0},15000,signal);
  assert.equal(points[0].fuelStationId,'one');assert.match(calls[0].url,/category=fuel/);
  assert.equal(calls[0].options.signal,signal);assert.equal(calls[0].options.headers.Authorization,'Bearer public-pilot-token');
});

test('fuel prices send stable station IDs and show all grades, including unavailable prices',async()=>{
  let url;
  const now=new Date().toISOString();
  const payload={stationId:'exact-id',checkedAt:now,updatedAt:'2026-10-01T10:00:00',updatedAtBasis:'latest-price-update',latitude:51,longitude:0,currency:'GBP',unit:'pence/litre',prices:[
    {fuel:'E10',amount:'0139.9500',updatedAt:'2026-10-01T10:00:00',effectiveAt:'2026-10-01T09:55:00Z'},
    {fuel:'E5',amount:null,updatedAt:null},
  ]};
  const service=load('src/utils/poiDetails.ts',{process:{env:{EXPO_PUBLIC_FUEL_PRICES_URL:'https://api.example.com/fuel-prices',EXPO_PUBLIC_ROUTING_TOKEN:'public-token'}},fetch:async(u,options)=>{
    url=u;assert.equal(options.headers.Authorization,'Bearer public-token');return{ok:true,json:async()=>payload};
  }});
  const snapshot=await service.fuelPriceSnapshot({latitude:51,longitude:0,name:'Station',fuelStationId:'exact-id'},new AbortController().signal);
  assert.match(url,/stationId=exact-id/);assert.match(snapshot.description,/E5: Price unavailable/);
  assert.match(snapshot.description,/0139.9500p\/l/);assert.match(snapshot.description,/Latest price update 2026-10-01T10:00:00/);
  assert.match(snapshot.description,/Effective 2026-10-01T09:55:00Z/);
});
