import { decodePolyline, distanceBetween } from '../../service/geometry.mjs';

const point=p=>p && Number.isFinite(p.latitude) && Math.abs(p.latitude)<=90 && Number.isFinite(p.longitude) && Math.abs(p.longitude)<=180;
const id=value=>typeof value==='number' && !Number.isSafeInteger(value)?undefined:/^\d{1,24}$/.test(String(value))?String(value):undefined;
const names=value=>Array.isArray(value)?value.filter(n=>typeof n==='string').slice(0,4).map(n=>n.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,160)):[];
const code=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)?value:'UNKNOWN';
function bearing(a,b) {
  return (Math.atan2((b.longitude-a.longitude)*Math.cos(a.latitude*Math.PI/180),b.latitude-a.latitude)*180/Math.PI+360)%360;
}
function prefix(points) {
  const result=[points[0]];let km=0;
  for(const p of points.slice(1)) {
    const last=result.at(-1),segment=distanceBetween(last,p);
    if(segment<0.000001)continue;
    if(km+segment>0.15) {
      const fraction=(0.15-km)/segment;
      result.push({latitude:last.latitude+(p.latitude-last.latitude)*fraction,longitude:last.longitude+(p.longitude-last.longitude)*fraction});break;
    }
    result.push(p);km+=segment;
  }
  return result;
}

// This observer does not change route requests or planner acceptance. Native
// paths supply departure identity directly; legacy edge-walk lookups run only
// after failure, under a separate two-second limit.
export function createStartRoadCapture({center,base,signal,engine,onUpdate=()=>{}}) {
  const roads=[],unroutedAttempts=[];let attempts=0,omittedStarts=0,firstRequest;
  const snapshot=()=>({status:roads.length?'routed_starts':attempts?'no_routed_start':'not_attempted',attempts,
    roads:roads.map(({shape,key,...road})=>road),unroutedAttempts:unroutedAttempts.slice(0,64),omittedStarts});
  async function route(request,abort) {
    const attempt=++attempts;
    firstRequest??=request;
    let payload;
    try{payload=await engine(base,'route',request,abort);}catch(error){
      unroutedAttempts.push({attempt,code:code(error.code)});onUpdate(snapshot());throw error;
    }
    try {
      const leg=payload.trip?.legs?.[0],native=payload.nativePath?.[0]?.edges?.[0];
      const points=decodePolyline(leg?.shape||'').filter(point);
      const shape=prefix(points);
      if(shape.length>=2 && point(center)) {
        const requestedStart={latitude:request.locations?.[0]?.lat,longitude:request.locations?.[0]?.lon};
        const key=JSON.stringify(shape);
        const existing=roads.find(r=>r.key===key);
        if(existing)existing.attempts.push(attempt);
        else if(roads.length<8)roads.push({key,shape,attempts:[attempt],snappedStart:shape[0],
          requestedStart:point(requestedStart)?requestedStart:undefined,
          snapDistanceMetres:Math.round(distanceBetween(center,shape[0])*1000*100)/100,
          departureBearing:Math.round(bearing(shape[0],shape[1])*100)/100,
          names:names(native?(native.name??[]).map(n=>n.value):leg.maneuvers?.[0]?.street_names),
          nameSource:native?'native_path':'route_maneuver',identityStatus:native?'native_path':'not_resolved',
          ...(native?{osmWayId:id(native.way_id),engineEdgeId:id(native.id)}:{})});
        else omittedStarts++;
      }
    }catch{/* Diagnostics must never change routing success or failure. */}
    onUpdate(snapshot());return payload;
  }
  async function resolve() {
    if(!attempts || signal?.aborted)return snapshot();
    const deadline=AbortSignal.timeout(2000);
    const abort=signal?AbortSignal.any([signal,deadline]):deadline;
    if(roads.length) {
      await Promise.all(roads.map(async road=>{
        if(road.identityStatus==='native_path')return;
        try {
          const attributes=await engine(base,'trace_attributes',{
            shape:road.shape.map(p=>({lat:p.latitude,lon:p.longitude})),shape_match:'edge_walk',costing:'motorcycle',
            costing_options:firstRequest.costing_options,
            filters:{action:'include',attributes:['edge.way_id','edge.id','edge.names','edge.begin_heading','edge.road_class','edge.use']},
          },abort);
          const edge=attributes.edges?.[0];
          if(!edge || !id(edge.way_id))throw Object.assign(Error(),{code:'NO_START_EDGE'});
          road.osmWayId=id(edge.way_id);road.engineEdgeId=id(edge.id);
          road.names=names(edge.names);road.nameSource='edge_walk';road.identityStatus='edge_walk';
          road.roadClass=code(edge.road_class);road.use=code(edge.use);
        }catch(error){road.identityStatus='unavailable';road.identityCode=code(error.code);}
      }));
    } else {
      // If no path was produced, nearby correlated edges are candidates only.
      // Never label the nearest candidate as the actual selected start road.
      try {
        const result=await engine(base,'locate',{locations:[firstRequest.locations[0]],costing:firstRequest.costing,
          costing_options:firstRequest.costing_options,verbose:true},abort);
        const candidates=(result[0]?.edges||[]).slice(0,8).map(e=>({names:names(e.edge_info?.names),nameSource:'locate',
          osmWayId:id(e.edge_info?.way_id??e.way_id),engineEdgeId:id(e.edge_id?.value),
          snappedStart:{latitude:e.correlated_lat,longitude:e.correlated_lon},identityStatus:'candidate_only'}));
        const resultSnapshot={...snapshot(),candidates};onUpdate(resultSnapshot);return resultSnapshot;
      }catch(error){const resultSnapshot={...snapshot(),lookupCode:code(error.code)};onUpdate(resultSnapshot);return resultSnapshot;}
    }
    const result=snapshot();onUpdate(result);return result;
  }
  return {route,resolve};
}

export function startRoadSummary(value) {
  if(!value || typeof value!=='object')return undefined;
  const out={status:code(value.status),attempts:Number.isFinite(value.attempts)?value.attempts:0,
    omittedStarts:Number.isFinite(value.omittedStarts)?value.omittedStarts:0};
  const summarise=road=>({names:names(road.names),osmWayId:id(road.osmWayId),engineEdgeId:id(road.engineEdgeId),
    osmWayUrl:id(road.osmWayId)?`https://www.openstreetmap.org/way/${id(road.osmWayId)}`:undefined,
    snappedStart:point(road.snappedStart)?{latitude:road.snappedStart.latitude,longitude:road.snappedStart.longitude}:undefined,
    requestedStart:point(road.requestedStart)?{latitude:road.requestedStart.latitude,longitude:road.requestedStart.longitude}:undefined,
    snapDistanceMetres:Number.isFinite(road.snapDistanceMetres)?road.snapDistanceMetres:undefined,
    departureBearing:Number.isFinite(road.departureBearing)?road.departureBearing:undefined,
    attempts:Array.isArray(road.attempts)?road.attempts.filter(Number.isInteger).slice(0,64):undefined,
    identityStatus:code(road.identityStatus),nameSource:code(road.nameSource),identityCode:road.identityCode?code(road.identityCode):undefined,
    roadClass:road.roadClass?code(road.roadClass):undefined,use:road.use?code(road.use):undefined});
  out.roads=Array.isArray(value.roads)?value.roads.slice(0,8).map(summarise):[];
  if(Array.isArray(value.candidates))out.candidates=value.candidates.slice(0,8).map(summarise);
  if(value.lookupCode)out.lookupCode=code(value.lookupCode);
  out.unroutedAttempts=Array.isArray(value.unroutedAttempts)?value.unroutedAttempts.slice(0,64).map(a=>({attempt:a.attempt,code:code(a.code)})):[];
  return out;
}
