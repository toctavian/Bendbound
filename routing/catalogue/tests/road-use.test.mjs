import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureRoadUse, tracedSegments, physicalSegments, measureIdentifiedGeometry } from '../service/road-use.mjs';
import { candidateScore } from '../service/policy.mjs';
const row=(id,length,from=0,to=1)=>({edge_id:id,length_m:length,from_fraction:from,to_fraction:to});
test('two opposite traversals are allowed when additional repeated distance stays at ten percent',()=>{
  const result=measureRoadUse([row('access',100),row('loop',800),row('access',100)],1);
  assert.equal(result.valid,true);assert.equal(result.maxTraversals,2);
  assert.equal(result.repeatedKm,0.1);assert.equal(result.repeatedRatio,0.1);
  assert.equal(result.uniqueKm,0.9);
});
test('triple use is rejected even when total repeated distance is small',()=>{
  const result=measureRoadUse([row('small',10),row('rest',970),row('small',10),row('small',10)],1);
  assert.equal(result.valid,false);assert.equal(result.maxTraversals,3);
});
test('partial and disjoint traversals use interval overlap rather than a named-road count',()=>{
  const disjoint=measureRoadUse([row('same',1000,0,0.5),row('same',1000,0.5,1)],1);
  assert.equal(disjoint.valid,true);assert.equal(disjoint.maxTraversals,1);
  const partial=measureRoadUse([row('same',1000),row('same',1000,0.45,0.5)],1.05);
  assert.equal(partial.valid,true);assert.ok(Math.abs(partial.repeatedKm-0.05)<1e-8);
});
test('too much reuse and incomplete verification fail closed',()=>{
  assert.equal(measureRoadUse([row('one',200),row('other',600),row('one',200)],1).valid,false);
  assert.equal(measureRoadUse([row('one',500)],1).valid,false);
  assert.equal(measureRoadUse([],1).valid,false);
});
test('a terminal snap offset does not exempt or hide physical segment reuse',()=>{
  const result=measureRoadUse([row('driveway',100,0.04,1),row('rest',804),row('driveway',100)],1);
  assert.equal(result.valid,true);assert.equal(result.maxTraversals,2);
  assert.ok(Math.abs(result.repeatedKm-0.096)<1e-8);
});
test('repeat penalty favours less repetition at identical quality and distance',()=>{
  const roads=[{rating:4,traversedKm:5}];
  assert.ok(candidateScore({distanceErrorKm:0,repeatedRatio:0},roads,20)>candidateScore({distanceErrorKm:0,repeatedRatio:0.05},roads,20));
});
test('trace identity cannot be omitted or substituted with named-road metadata',()=>{
  assert.throws(()=>tracedSegments({edges:[{names:['A road'],way_id:1}]}),e=>e.code==='ENGINE_RESPONSE');
});
test('original traversal multiplicity is preserved even if map matching collapses a lap',()=>{
  const points=[{latitude:0,longitude:0},{latitude:0.001,longitude:0},{latitude:0.001,longitude:0.001},{latitude:0,longitude:0.001},{latitude:0,longitude:0}];
  const attributes={shape:'??o}@??o}@n}@??n}@',edges:[{way_id:1,begin_shape_index:0,end_shape_index:4}]};
  const repeated=[...points,...points.slice(1),...points.slice(1)];
  const segments=physicalSegments(attributes,repeated);
  assert.equal(segments.length,12);
  assert.equal(measureRoadUse(segments.map((s,i)=>row(String(i%4),100)),1.2).maxTraversals,3);
  assert.throws(()=>physicalSegments(attributes,points.map(p=>({...p,latitude:p.latitude+0.01}))),e=>e.code==='ROAD_IDENTITY');
});
test('identified geometry catches partial third passes and keeps different OSM ways separate',()=>{
  const forward={wayId:'1',a:[0,0],b:[0.001,0]},reverse={wayId:'1',a:[0.001,0],b:[0,0]};
  assert.equal(measureIdentifiedGeometry([forward,reverse],1).maxTraversals,2);
  assert.equal(measureIdentifiedGeometry([forward,reverse,{wayId:'1',a:[0.0002,0],b:[0.0004,0]}],1).maxTraversals,3);
  assert.equal(measureIdentifiedGeometry([forward,{...reverse,wayId:'2'}],1).maxTraversals,1);
});
