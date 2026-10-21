import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphCatalogue, ratingFactors } from '../service/graph-catalogue.mjs';
import { createSqliteGraphCatalogue } from '../service/graph-catalogue-sqlite.mjs';
function encodePolyline(points) {
  let previous=[0,0],encoded='';
  for(const p of points) {
    const next=[Math.round(p.latitude*1e6),Math.round(p.longitude*1e6)];
    for(let i=0;i<2;i++) {
      let value=next[i]-previous[i];value=value<0?~(value<<1):value<<1;
      while(value>=32){encoded+=String.fromCharCode((32|(value&31))+63);value>>>=5;}
      encoded+=String.fromCharCode(value+63);
    }
    previous=next;
  }
  return encoded;
}

const version='a'.repeat(64);
const line=[[-.1278,51.5074],[-.1178,51.5074]];
const points=coordinates=>coordinates.map(([longitude,latitude])=>({longitude,latitude}));
const shape=encodePolyline(points(line));
const section={id:'rated-road',rating:4,quality:4,recommendationCount:2,lengthKm:.6922,
  physicalIds:['7:physical'],shape,bbox:[-.1278,51.5074,-.1178,51.5074]};
const lookup=async ids=>({graphVersion:version,edges:ids.map(edgeId=>({edgeId,physicalId:'physical',flipped:false,coordinates:line}))});

function fixture(t,sections=[section],edges=[['7:physical',shape,['123']]]) {
  const dir=mkdtempSync(join(tmpdir(),'bendbound-sqlite-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'ratings.sqlite'),db=new DatabaseSync(file);
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE sections(id TEXT UNIQUE,value TEXT); CREATE VIRTUAL TABLE bounds USING rtree(id,minx,maxx,miny,maxy); CREATE TABLE native_edges(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE membership(physical TEXT,section INTEGER); CREATE INDEX membership_physical ON membership(physical);');
  const summary={schemaVersion:3,graphVersion:version,sections:sections.length,recommendedSections:sections.filter(s=>s.recommendationCount>0).length,nativeEdges:edges.length,sourceSections:sections.length,unmappedSections:0};
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('summary',JSON.stringify(summary));
  for(const edge of edges)db.prepare('INSERT INTO native_edges VALUES(?,?)').run(edge[0],JSON.stringify(edge));
  for(const s of sections) {
    const row=db.prepare('INSERT INTO sections VALUES(?,?)').run(s.id,JSON.stringify(s)).lastInsertRowid;
    const [west,south,east,north]=s.bbox;
    db.prepare('INSERT INTO bounds VALUES(?,?,?,?,?)').run(row,west,east,south,north);
    for(const id of s.physicalIds)db.prepare('INSERT INTO membership VALUES(?,?)').run(id,row);
  }
  db.close();
  const catalogue=createSqliteGraphCatalogue(file,createGraphCatalogue,lookup);
  t.after(()=>catalogue.close());
  return catalogue;
}

test('SQLite ratings retain native cost factors, exact cone filtering and verified route membership',async t=>{
  const c=fixture(t),args={center:points(line)[0],radiusKm:5,limit:1};
  const roads=await c.nearby(args);
  assert.equal(roads.length,1);
  assert.deepEqual(roads[0].geometry.coordinates,line);
  assert.equal(ratingFactors(roads)[0].id,'123');
  const excluded=await c.nearby({...args,areaPolygon:points([[-.13,51.50],[-.12,51.50],[-.12,51.52],[-.13,51.52],[-.13,51.50]])});
  assert.equal(excluded.length,0);
  const payload={nativePath:[{shape,edges:[{id:'123',way_id:'7',source_along_edge:0,target_along_edge:1,begin_shape_index:0,end_shape_index:1}]}]};
  await assert.rejects(c.matchRoute(null,null,payload),e=>e.code==='ROAD_IDENTITY');
  assert.equal((await c.nativeUsage(payload,points(line))).valid,true);
  const matched=await c.matchRoute(null,null,payload);
  assert.equal(matched[0].id,section.id);
  assert.equal(matched[0].fullSection,true);
});

test('national database safely handles areas and verified paths without rated roads',async t=>{
  const c=fixture(t,[],[]);
  assert.deepEqual(await c.nearby({center:points(line)[0],radiusKm:5}),[]);
  const payload={nativePath:[{shape,edges:[{id:'123',way_id:'7',source_along_edge:0,target_along_edge:1,begin_shape_index:0,end_shape_index:1}]}]};
  assert.equal((await c.nativeUsage(payload,points(line))).identityVerification,'valhalla-native-edges');
  assert.deepEqual(await c.matchRoute(null,null,payload),[]);
  assert.equal(c.data.sections.length,0);
});

test('SQLite bounding-box candidates still receive exact radius filtering before limit',async t=>{
  const far=[[-.1148,51.5154],[-.1138,51.5154]];
  const distant={...section,id:'outside-circle',rating:5,shape:encodePolyline(points(far)),bbox:[-.1148,51.5154,-.1138,51.5154]};
  const c=fixture(t,[distant,section]);
  const found=await c.nearby({center:points(line)[0],radiusKm:1,limit:1});
  assert.deepEqual(found.map(s=>s.id),[section.id]);
});
