import { randomUUID } from 'node:crypto';
import { startRoadSummary } from './start-road.mjs';

const scalarKeys=['valid','distanceKm','distanceErrorKm','overlapRatio','repeatedKm',
  'sharedAccessKm','remainingRepeatedRatio','closed','nearStart','insideArea',
  'coverage','attempt','attempts','elapsedMs','excludedLocations','fallback',
  'score','evaluatedKm','recommendedKm','repeatedRatio','maxTraversals','uniqueKm','verifiedKm','verifiedRatio','endpointGapMetres','geometrySharedAccessKm','insideCone','coneRadiusKm','coneBufferKm','coneAngleDegrees','excursionsRemovedKm','internalExcursionKm','internalRepeatedRatio','fallbackAttempted','ratingFactorsApplied'];
const identifier=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)?value:undefined;
export function diagnosticSummary(value,depth=0) {
  if(!value || typeof value!=='object' || depth>3)return undefined;
  const out={};
  for(const key of scalarKeys)if(typeof value[key]==='boolean' || (typeof value[key]==='number' && Number.isFinite(value[key])))out[key]=value[key];
  for(const key of ['code','reason','sectionId','selectedRoadSectionId','implementation','roadUsePolicy','identityVerification','routeSource','catalogueBackend']) {
    const id=identifier(value[key]);if(id!==undefined)out[key]=id;
  }
  if(Array.isArray(value.attempts)) {
    out.attempts=value.attempts.slice(0,40).map(row=>diagnosticSummary(row,depth+1));
    if(value.attempts.length>40)out.omittedAttempts=value.attempts.length-40;
  }
  if(value.diagnostics && depth<3)out.diagnostics=diagnosticSummary(value.diagnostics,depth+1);
  return out;
}
export function inputSummary(path,input,failed=false) {
  if(!input || typeof input!=='object')return undefined;
  const out={};
  if(path==='/round-trip') {
    for(const key of ['targetKm','direction','radiusKm','coneAngleDegrees'])if(Number.isFinite(input[key]))out[key]=input[key];
    if(['fast','winding','twisty'].includes(input.profile))out.profile=input.profile;
    if(typeof input.avoidMotorways==='boolean')out.avoidMotorways=input.avoidMotorways;
    // Exact failed starts allow reproduction of access-road problems. Successful
    // start coordinates, headers, peer IPs and entire routes are never stored here.
    if(failed && Number.isFinite(input.center?.latitude) && Math.abs(input.center.latitude)<=90
      && Number.isFinite(input.center?.longitude) && Math.abs(input.center.longitude)<=180)
      out.center={latitude:input.center.latitude,longitude:input.center.longitude};
  } else if(path==='/match' && Array.isArray(input.points))out.locationCount=input.points.length;
  else if(path==='/route' && Array.isArray(input.locations))out.locationCount=input.locations.length;
  return out;
}
export const writeLog=entry=>console.log(JSON.stringify({timestamp:new Date().toISOString(),service:'bendbound-routing',...entry}));

export function requestLog(request,response,{write=writeLog,now=()=>performance.now()}={}) {
  const requestId=randomUUID(),started=now();
  let pathname;
  try{pathname=new URL(request.url,'http://localhost').pathname;}catch{pathname='/unknown';}
  const path=['/round-trip','/route','/health','/roads','/match','/shared-routes','/.well-known/apple-app-site-association'].includes(pathname)?pathname
    : pathname.startsWith('/shared-routes/')?'/shared-routes/:id':pathname.startsWith('/shared/')?'/shared/:id':'/unknown';
  const method=['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].includes(request.method)?request.method:'OTHER';
  let input,planner,error,startRoads,cache,completed=false;
  const common={requestId,method,path};
  response.setHeader('X-Request-Id',requestId);
  write({event:'request.started',level:'info',...common});
  function finish(disconnected=false) {
    if(completed)return;
    completed=true;
    const status=disconnected?499:response.statusCode;
    write({event:'request.completed',level:status>=500?'error':status>=400?'warn':'info',...common,
      status,durationMs:Math.round(now()-started),input:inputSummary(path,input,status>=400),
      planner:diagnosticSummary(planner),code:disconnected?'CLIENT_DISCONNECTED':identifier(error?.code),
      errorType:identifier(error?.name),diagnostics:diagnosticSummary(error?.diagnostics),
      startRoads:status>=400?startRoadSummary(startRoads):undefined,cache});
  }
  response.once('finish',()=>finish());
  response.once('close',()=>finish(!response.writableFinished));
  return {requestId,setInput:value=>{input=value;},setPlanner:value=>{planner=value;},setError:value=>{error=value;},setStartRoads:value=>{startRoads=value;},setCache:value=>{cache=value;}};
}
