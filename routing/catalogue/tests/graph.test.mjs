import test from 'node:test';
import assert from 'node:assert/strict';
import { apiType, encodeRouteRequest, decodeRouteResponse } from '../service/graph-engine.mjs';
import { createGraphCatalogue, ratingFactors } from '../service/graph-catalogue.mjs';
import { valhallaRequest } from '../../service/engine.mjs';
import { planRoundTrip } from '../service/planner.mjs';
const version='a'.repeat(64);
function encode(points){let a=0,b=0,out='';for(const [lon,lat] of points){const x=Math.round(lat*1e6),y=Math.round(lon*1e6);for(let v of [x-a,y-b]){v=v<0?~(v<<1):v<<1;while(v>=32){out+=String.fromCharCode((32|(v&31))+63);v>>>=5;}out+=String.fromCharCode(v+63);}a=x;b=y;}return out;}
const line=[[-.1278,51.5074],[-.1178,51.5074]],shape=encode(line);
const section={id:'section-test',rating:4,quality:4,winding:3,twisty:3,recommendationCount:2,lengthKm:0.6922,physicalIds:['7:physical'],edgeIds:['123','124'],geometry:{type:'LineString',coordinates:line}};
const dataset={schemaVersion:1,graphVersion:version,sections:[section],unmappedSections:[],sourceSections:1};
const edge=(id,from=0,to=1)=>({id,way_id:'7',source_along_edge:from,target_along_edge:to,begin_shape_index:0,end_shape_index:1});
const lookups=ids=>({graphVersion:version,edges:ids.map(id=>({edgeId:id,physicalId:'physical',flipped:id==='124',coordinates:id==='124'?[...line].reverse():line}))});
const points=coords=>coords.map(([longitude,latitude])=>({longitude,latitude}));

test('native requests carry exact graph IDs, bounded ratings, partial ranges and access exclusions',()=>{
 const request=valhallaRequest(points(line));request.graph_cost_factors=ratingFactors([section]);
 const api=apiType.toObject(apiType.decode(encodeRouteRequest(request)),{longs:String});
 assert.equal(api.options.format,3);assert.equal(api.options.shape_format,0);
 assert.deepEqual(api.options.pbf_field_selector,{options:false,trip:true,directions:true});
 const opts=api.options.costings['8'].options;
 assert.equal(opts.exclude_highways,true);assert.equal(opts.exclude_ferries,true);
 assert.equal(opts.cost_factor_edges[0].id,'123');assert.equal(opts.cost_factor_edges[0].ignore_access_restrictions,false);
 assert.ok(opts.cost_factor_edges[0].factor>=.75 && opts.cost_factor_edges[0].factor<1);
});
test('one native response supplies consistent directions and path without losing repeated edges or 64-bit IDs',()=>{
 const huge='18446744073709551000';
 const bytes=apiType.encode(apiType.fromObject({trip:{routes:[{legs:[{shape,node:[{edge:{id:huge,way_id:'7'}},{edge:{id:huge,way_id:'7'}}]}]}]},directions:{routes:[{legs:[{shape,summary:{length:1,time:60},maneuver:[{type:1,text_instruction:'Start',begin_shape_index:0,end_shape_index:1}]}]}]}})).finish();
 const r=decodeRouteResponse(bytes);assert.equal(r.nativePath[0].edges.length,2);assert.equal(r.nativePath[0].edges[0].id,huge);assert.equal(r.trip.legs[0].maneuvers[0].instruction,'Start');
 assert.equal(r.trip.summary.time,60);
});
test('inconsistent directions and native path fail closed',()=>{
 const bytes=apiType.encode(apiType.fromObject({trip:{routes:[{legs:[{shape:'different'}]}]},directions:{routes:[{legs:[{shape}]}]}})).finish();
 assert.throws(()=>decodeRouteResponse(bytes),e=>e.code==='ROAD_IDENTITY');
});
test('native geometry has full coverage without consulting PostGIS or map matching',async()=>{
 const c=createGraphCatalogue(dataset,{lookup:async ids=>lookups(ids)}),p={nativePath:[{shape,edges:[edge('123')]}]};
 const r=await c.nativeUsage(p,points(line));assert.equal(r.valid,true);assert.ok(Math.abs(r.verifiedRatio-1)<1e-6);assert.equal(r.identityVerification,'valhalla-native-edges');
 const roads=await c.matchRoute(null,null,p);assert.ok(roads[0].fullSection);
});
test('opposite directions share physical identity and the third pass is rejected',async()=>{
 const c=createGraphCatalogue(dataset,{lookup:async ids=>lookups(ids)});
 const p={nativePath:[{shape,edges:[edge('123')]},{shape:encode([...line].reverse()),edges:[edge('124')]},{shape,edges:[edge('123')]}]};
 const r=await c.nativeUsage(p,points([...line,line[0],line[1]]));assert.equal(r.maxTraversals,3);assert.equal(r.valid,false);assert.ok(r.repeatedRatio>.6);
});
test('disjoint fractions of a long road do not count as repeat use',async()=>{
 const c=createGraphCatalogue(dataset,{lookup:async ids=>lookups(ids)});
 const first=[line[0],[-.1258,51.5074]],last=[[-.1198,51.5074],line[1]];
 const p={nativePath:[{shape:encode(first),edges:[edge('123',0,.2)]},{shape:encode(last),edges:[edge('123',.8,1)]}]};
 const r=await c.nativeUsage(p,points([line[0],[-.1238,51.5074]]));assert.equal(r.maxTraversals,1);assert.equal(r.repeatedKm,0);assert.ok(Math.abs(r.verifiedRatio-1)<1e-6);
});
test('a rating overlay from another tile build cannot verify a route',async()=>{
 const c=createGraphCatalogue(dataset,{lookup:async ids=>({...lookups(ids),graphVersion:'b'.repeat(64)})});
 await assert.rejects(c.nativeUsage({nativePath:[{shape,edges:[edge('123')]}]},points(line)),e=>e.code==='GRAPH_VERSION_MISMATCH');
});
test('full road geometry must fit the cone before a shortlist limit is applied',async()=>{
 const c=createGraphCatalogue(dataset,{lookup:async ids=>lookups(ids)});
 const found=await c.nearby({center:points(line)[0],radiusKm:10,limit:1,areaPolygon:points([[-.13,51.50],[-.12,51.50],[-.12,51.52],[-.13,51.52],[-.13,51.50]])});
 assert.equal(found.length,0);
});
test('main-only orchestration succeeds and explicitly reports no fallback',async()=>{
 const coords=[[-.1278,51.5074],[-.1,51.52],[-.09,51.5],[-.1278,51.5074]],s=encode(coords);
 const payload={trip:{status:0,summary:{length:40,time:2000},legs:[{shape:s}]},nativePath:[{shape:s,edges:[edge('123')]}]};
 const result=await planRoundTrip({center:points(coords)[0],targetKm:40,direction:90,profile:'winding',avoidMotorways:true},{backend:'valhalla',allowFallback:false,
  catalogueNearby:async()=>[section],route:async()=>payload,trace:async()=>{throw Error('Unexpected map matching');},catalogueRoadUse:async()=>{throw Error('Unexpected PostGIS');},
  catalogueNativeUsage:async()=>({valid:true,verifiedRatio:1,repeatedKm:0,repeatedRatio:0,maxTraversals:1,identityVerification:'valhalla-native-edges'}),
  catalogueMatch:async()=>[{...section,fullSection:true,traversedKm:section.lengthKm}],fallback:async()=>{throw Error('Unexpected fallback');}});
 assert.equal(result.planner.routeSource,'main');assert.equal(result.planner.fallbackAttempted,false);assert.ok(result.planner.ratingFactorsApplied>0);assert.equal(result.nativePath,undefined);
});

test('compact graph overlays decode geometry and ratings lazily without losing identity',async()=>{
 const compact={...dataset,schemaVersion:2,nativeEdges:[['7:physical',shape,['123','124']]],sections:[{...section,geometry:undefined,edgeIds:undefined,shape,bbox:[-.1278,51.5074,-.1178,51.5074]}]};
 const c=createGraphCatalogue(compact,{lookup:async ids=>lookups(ids)});
 const roads=await c.nearby({center:points(line)[0],radiusKm:5});assert.equal(roads.length,1);assert.deepEqual(roads[0].geometry.coordinates,line);assert.equal(ratingFactors(roads).length,2);
});
test('fallback-only orchestration is distinguished from a main-planner success',async()=>{
 const coords=[[-.1278,51.5074],[-.1,51.52],[-.09,51.5],[-.1278,51.5074]],s=encode(coords);
 const payload={trip:{status:0,summary:{length:40,time:2000},legs:[{shape:s}]},nativePath:[{shape:s,edges:[edge('123')]}]};
 const result=await planRoundTrip({center:points(coords)[0],targetKm:40,direction:90,profile:'winding',avoidMotorways:true},{backend:'valhalla',
  catalogueNearby:async()=>[],route:async()=>payload,catalogueNativeUsage:async()=>({valid:true,verifiedRatio:1,repeatedKm:0,repeatedRatio:0,maxTraversals:1}),catalogueMatch:async()=>[]});
 assert.equal(result.planner.routeSource,'fallback');assert.equal(result.planner.fallbackAttempted,true);
});

test('native shortcut fractions receive the same bounded rating as their source road',()=>{
 const factors=ratingFactors([{...section,shortcutRanges:[['999',.2,.6]]}]);
 const shortcut=factors.find(f=>f.id==='999');assert.equal(shortcut.start,.2);assert.equal(shortcut.end,.6);assert.equal(shortcut.factor,factors[0].factor);assert.equal(shortcut.ignore_access_restrictions,false);
});

test('cache eviction cannot discard an edge still needed by an in-flight route',async()=>{
 const c=createGraphCatalogue(dataset,{lookup:async ids=>lookups(ids),maxEdgeCache:1});
 await c.nativeUsage({nativePath:[{shape,edges:[edge('123')]}]},points(line));
 const p={nativePath:[{shape,edges:[edge('123')]},{shape,edges:[edge('125')]}]};
 const usage=await c.nativeUsage(p,points([...line,line[0]]));assert.equal(usage.maxTraversals,2);
});

test('overlapping source ratings become disjoint ranges and never compound discounts',()=>{
 const first={...section,edgeIds:[],shortcutRanges:[['999',.2,.6]]};
 const second={...first,rating:5,shortcutRanges:[['999',.4,.8]]};
 const factors=ratingFactors([first,second]);assert.equal(factors.length,2);
 assert.deepEqual(factors.map(f=>[f.start,f.end,f.factor]),[[.2,.4,.84],[.4,.8,.8]]);
 assert.ok(factors.every(f=>f.factor>=.75 && !f.ignore_access_restrictions));
});
