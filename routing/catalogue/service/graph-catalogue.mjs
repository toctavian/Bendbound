import { createSqliteGraphCatalogue } from './graph-catalogue-sqlite.mjs';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodePolyline, distanceBetween, routeDistance } from '../../service/geometry.mjs';
import { insideCone } from '../../service/cone.mjs';
import { RoutingError } from '../../service/engine.mjs';
import { measureRoadUse, measureIdentifiedGeometry } from './road-use.mjs';

let loaded;
const CELL=0.05;
const publicSection=s=>Object.fromEntries(['id','sourceSectionId','name','ref','lengthKm','rating','quality','winding','twisty','recommendationCount','frequencyRating','ratingBasis','surfaceConfidence','sources','graphVersion','geometry'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]]));
export function createGraphCatalogue(data,{lookup,maxEdgeCache=8192,allowEmpty=false}={}) {
  if(![1,2].includes(data.schemaVersion) || !/^[a-f0-9]{64}$/.test(data.graphVersion) || !Array.isArray(data.sections) || (!allowEmpty && !data.sections.length))throw new RoutingError('CATALOGUE_UNAVAILABLE','Invalid graph rating overlay.',503);
  const grid=new Map(),byPhysical=new Map(),edgeCache=new Map(),shapes=new Map();
  const nativeEdges=new Map((data.nativeEdges??[]).map(row=>[row[0],row]));
  const decode=shape=>decodePolyline(shape).map(p=>[p.longitude,p.latitude]);
  for(const s of data.sections)if(s.shape) {
    s.graphVersion=data.graphVersion;
    s.physicalIds=s.physicalIds.map(id=>{const edge=nativeEdges.get(id);if(!edge)throw new RoutingError('CATALOGUE_UNAVAILABLE','Rating references a missing native edge.',503);return edge[0];});
    Object.defineProperty(s,'geometry',{enumerable:true,get(){
      if(!shapes.has(s.id)){shapes.set(s.id,{type:'LineString',coordinates:decode(s.shape)});while(shapes.size>128)shapes.delete(shapes.keys().next().value);}
      return shapes.get(s.id);
    }});
    Object.defineProperty(s,'edgeIds',{get:()=>s.physicalIds.flatMap(id=>nativeEdges.get(id)?.[2]??[])});
    Object.defineProperty(s,'toJSON',{value:()=>publicSection(s)});
  }
  for(const s of data.sections) {
    const box=s.bbox??[Math.min(...s.geometry.coordinates.map(p=>p[0])),Math.min(...s.geometry.coordinates.map(p=>p[1])),Math.max(...s.geometry.coordinates.map(p=>p[0])),Math.max(...s.geometry.coordinates.map(p=>p[1]))];
    const minX=Math.floor(box[0]/CELL),maxX=Math.floor(box[2]/CELL),minY=Math.floor(box[1]/CELL),maxY=Math.floor(box[3]/CELL);
    for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++){const k=`${x},${y}`;if(!grid.has(k))grid.set(k,new Set());grid.get(k).add(s);}
    for(const id of s.physicalIds){if(!byPhysical.has(id))byPhysical.set(id,[]);byPhysical.get(id).push(s);}
  }
  async function nearby({center,radiusKm,limit=30,areaPolygon=null}) {
    const dy=radiusKm/111.195,dx=dy/Math.cos(center.latitude*Math.PI/180),found=new Set();
    for(let x=Math.floor((center.longitude-dx)/CELL);x<=Math.floor((center.longitude+dx)/CELL);x++)
      for(let y=Math.floor((center.latitude-dy)/CELL);y<=Math.floor((center.latitude+dy)/CELL);y++)
        for(const s of grid.get(`${x},${y}`)??[])found.add(s);
    const distance=s=>Math.min(...s.geometry.coordinates.map(([longitude,latitude])=>distanceBetween(center,{longitude,latitude})));
    return [...found].map(s=>({s,d:distance(s)})).filter(({s,d})=>d<=radiusKm && (!areaPolygon || s.geometry.coordinates.every(([longitude,latitude])=>insideCone({longitude,latitude},areaPolygon))))
      .sort((a,b)=>b.s.recommendationCount-a.s.recommendationCount || b.s.rating-a.s.rating || a.d-b.d || a.s.id.localeCompare(b.s.id)).slice(0,limit).map(row=>row.s);
  }
  async function nativeUsage(payload,points,signal) {
    if(!payload.nativePath?.length)throw new RoutingError('ROAD_IDENTITY','Native routing edges are missing.',502);
    const ids=[...new Set(payload.nativePath.flatMap(l=>l.edges.map(e=>e.id)))];
    if(ids.some(id=>!/^\d+$/.test(id)||id==='0'))throw new RoutingError('ROAD_IDENTITY','Invalid native graph edge identity.',502);
    // Pin every edge needed by this validation before updating the bounded
    // cross-request cache. New lookups may evict an older but still-needed edge.
    const resolved=new Map(ids.filter(id=>edgeCache.has(id)).map(id=>[id,edgeCache.get(id)]));
    const missing=ids.filter(id=>!resolved.has(id));
    if(missing.length){
      const result=await lookup(missing,signal);
      if(result.graphVersion!==data.graphVersion)throw new RoutingError('GRAPH_VERSION_MISMATCH','Ratings and routing tiles differ.',503);
      for(const e of result.edges) {resolved.set(e.edgeId,e);edgeCache.set(e.edgeId,e);while(edgeCache.size>maxEdgeCache)edgeCache.delete(edgeCache.keys().next().value);}
    }
    const intervals=[],parts=[],ranges=new Map();
    for(const leg of payload.nativePath) {
      const shape=decodePolyline(leg.shape);
      for(const e of leg.edges) {
        const info=resolved.get(e.id),a=e.source_along_edge,b=e.target_along_edge;
        if(!info || !/^\d+$/.test(e.way_id)||e.way_id==='0' || !Number.isFinite(a)||!Number.isFinite(b)||a<0||b>1||b<=a || !Number.isInteger(e.begin_shape_index)||!Number.isInteger(e.end_shape_index)||e.end_shape_index<=e.begin_shape_index||e.end_shape_index>=shape.length)
          throw new RoutingError('ROAD_IDENTITY','Incomplete native edge traversal.',502);
        const coords=info.coordinates,fullKm=routeDistance(coords.map(([longitude,latitude])=>({longitude,latitude})));
        const from=info.flipped?1-b:a,to=info.flipped?1-a:b,id=`${e.way_id}:${info.physicalId}`;
        intervals.push({edge_id:id,length_m:fullKm*1000,from_fraction:from,to_fraction:to});
        if(!ranges.has(id))ranges.set(id,{fullKm,intervals:[]});ranges.get(id).intervals.push([from,to]);
        // The actual ordered path comes from route's protobuf, not trace_attributes.
        // This also catches overlaps between representations at hierarchy levels.
        for(let i=e.begin_shape_index;i<e.end_shape_index;i++)parts.push({wayId:e.way_id,a:[shape[i].longitude,shape[i].latitude],b:[shape[i+1].longitude,shape[i+1].latitude]});
      }
    }
    const totalKm=routeDistance(points),usage=measureRoadUse(intervals,totalKm),guard=measureIdentifiedGeometry(parts,totalKm);
    const repeatedKm=Math.max(usage.repeatedKm,guard.repeatedKm),maxTraversals=Math.max(usage.maxTraversals,guard.maxTraversals);
    const result={...usage,repeatedKm,repeatedRatio:repeatedKm/totalKm,maxTraversals,
      valid:usage.valid&&maxTraversals<=2&&repeatedKm/totalKm<=0.1+1e-9,identityVerification:'valhalla-native-edges'};
    Object.defineProperty(payload,'nativeRanges',{value:ranges,configurable:true});
    return result;
  }
  async function matchRoute(_points,_wayIds,payload) {
    if(!payload?.nativeRanges)throw new RoutingError('ROAD_IDENTITY','Native edge coverage has not been verified.',502);
    const sections=new Map();
    for(const [id,range] of payload.nativeRanges) {
      const ordered=range.intervals.sort((a,b)=>a[0]-b[0]);let end=0,coverage=0;
      for(const [from,to] of ordered){coverage+=Math.max(0,to-Math.max(from,end));end=Math.max(end,to);}
      for(const s of byPhysical.get(id)??[])sections.set(s,(sections.get(s)||0)+range.fullKm*coverage);
    }
    return [...sections].map(([s,km])=>({...publicSection(s),traversedKm:Math.min(s.lengthKm,km),coverage:Math.min(1,km/s.lengthKm),fullSection:km/s.lengthKm>=0.98}))
      .filter(s=>s.coverage>=0.8).sort((a,b)=>b.traversedKm*b.rating-a.traversedKm*a.rating).slice(0,60);
  }
  return {nearby,nativeUsage,matchRoute,data};
}
export function catalogue() {
  if(!loaded) {
    const file=process.env.GRAPH_RATINGS_FILE??'/ratings/ratings.json.gz';
    const lookup=async(edgeIds,signal)=>{
      const r=await fetch(`${process.env.VALHALLA_GRAPH_URL??'http://valhalla-graph:8003'}/edges`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({graphVersion:loaded.data.graphVersion,edgeIds}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
      if(!r.ok)throw new RoutingError(r.status===409?'GRAPH_VERSION_MISMATCH':'ROAD_IDENTITY','Native graph lookup failed.',r.status===409?503:502);
      return r.json();
    };
    loaded=file.endsWith('.sqlite') ? createSqliteGraphCatalogue(file,createGraphCatalogue,lookup)
      : createGraphCatalogue(JSON.parse(gunzipSync(fs.readFileSync(file))),{lookup});
  }
  return loaded;
}
export const nearby=args=>catalogue().nearby(args);
export const matchRoute=(...args)=>catalogue().matchRoute(...args);
export const nativeUsage=(...args)=>catalogue().nativeUsage(...args);
export async function status() {
  const {data}=catalogue();
  const r=await fetch(`${process.env.VALHALLA_GRAPH_URL??'http://valhalla-graph:8003'}/health`,{signal:AbortSignal.timeout(3000)});
  const health=await r.json();
  if(!r.ok || health.graphVersion!==data.graphVersion)throw new RoutingError('GRAPH_VERSION_MISMATCH','Ratings and native graph do not match.',503);
  return {version:data.graphVersion,graph_version:data.graphVersion,sections:data.sections.length,recommended_sections:data.recommendedSections??data.sections.filter(s=>s.recommendationCount>0).length,
    indexed_rated_edges:data.nativeEdges?.length??0,sourceSections:data.sourceSections,unmappedSections:data.unmappedSections.length,backend:'valhalla',postgis:'retired',connectivity:{mode:'valhalla',status:'online'}};
}
export function ratingFactors(sections,profile='winding') {
  const strength=profile==='fast'?0.1:profile==='twisty'?0.25:0.2,edges=new Map();
  for(const s of sections.filter(s=>s.rating>=1.5).slice(0,32)) {
    const factor=Math.max(0.75,1-strength*s.rating/5);
    const ranges=[...(s.edgeIds??[]).map(id=>({id,start:0,end:1})),...(s.shortcutRanges??[]).map(r=>Array.isArray(r)?{id:r[0],start:r[1],end:r[2]}:r)];
    for(const range of ranges){if(!edges.has(range.id))edges.set(range.id,[]);edges.get(range.id).push({...range,factor});}
  }
  // Valhalla sums range coverage when averaging edge cost. Supply disjoint
  // ranges so adjacent catalogue sections cannot compound a discount, which
  // would also invalidate the configured lower bound used by the A* heuristic.
  const result=[];
  for(const [id,ranges] of edges) {
    const bounds=[...new Set(ranges.flatMap(r=>[r.start,r.end]))].sort((a,b)=>a-b),pieces=[];
    for(let i=1;i<bounds.length;i++) {
      const start=bounds[i-1],end=bounds[i],active=ranges.filter(r=>r.start<end && r.end>start);
      if(!active.length || end-start<1e-10)continue;
      const factor=Math.min(...active.map(r=>r.factor)),last=pieces.at(-1);
      if(last && last.end===start && last.factor===factor)last.end=end;
      else pieces.push({id,start,end,factor,ignore_access_restrictions:false});
    }
    result.push(...pieces);
  }
  return result.slice(0,4096);
}
