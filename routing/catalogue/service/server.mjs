import { matchRecording } from './matching.mjs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { engineJSON, RoutingError, geometry } from '../../service/engine.mjs';
import { createRateLimiter } from '../../service/rate-limit.mjs';
import { planRoundTrip } from './planner.mjs';
import { status as catalogueStatus, nearby, graphMode } from './catalogue.mjs';
import { graphEngine } from './graph-engine.mjs';
import { inArea, serviceArea, coverageLabel } from './policy.mjs';
import { requestLog, writeLog } from './logging.mjs';
import { createStartRoadCapture } from './start-road.mjs';
import { createCache } from './cache.mjs';
import { validateInput } from './input.mjs';
import { createShareStore, association, shareLanding } from './route-shares.mjs';

const base=process.env.VALHALLA_URL || 'http://127.0.0.1:8002';
async function body(request, maxBytes=65536) {
  const chunks=[];let bytes=0;
  for await(const chunk of request){bytes+=chunk.length;if(bytes>maxBytes)throw new RoutingError('INVALID_REQUEST','Request too large.',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new RoutingError('INVALID_REQUEST','Expected JSON.',400);}
}
export function createServer({plan=planRoundTrip,engine=graphMode()?graphEngine:engineJSON,catalogue=catalogueStatus,roads=nearby,
  allow=createRateLimiter(),log=writeLog,routeCache=createCache(),shares=createShareStore()}={}) {
let active=0;
const server=http.createServer(async(request,response)=>{
  let startRoads;
  const context=requestLog(request,response,{write:log});
  const abort=new AbortController();response.on('close',()=>{if(!response.writableEnded)abort.abort();});
  const send=(code,payload)=>{if(!response.destroyed){
    if(code>=400) {
      context.setError({code:payload.code,diagnostics:payload.diagnostics});
      payload={...payload,requestId:context.requestId,...(payload.message?{message:`${payload.message} Reference: ${context.requestId}.`}:{})};
    }
    response.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(payload));
  }};
  const client=request.headers['x-routing-client-ip']||request.socket.remoteAddress;
  const limit=allow(client);
  if(!limit.allowed){response.setHeader('Retry-After',String(limit.retryAfter));return send(429,{code:'RATE_LIMITED',message:'Too many routing requests. Please try again in a minute.'});}
  if(active>=2)return send(429,{code:'BUSY',message:'Routing is busy. Try again shortly.'});
  active++;
  try{
    const url=new URL(request.url,'http://localhost');
    if(request.method==='GET' && url.pathname==='/.well-known/apple-app-site-association')return send(200,association);
    if(request.method==='POST' && url.pathname==='/shared-routes')return send(201,await shares.create(await body(request,2097152)));
    if(request.method==='GET' && url.pathname.startsWith('/shared-routes/'))return send(200,await shares.get(url.pathname.slice('/shared-routes/'.length)));
    if(request.method==='GET' && url.pathname.startsWith('/shared/')){
      const id=url.pathname.slice('/shared/'.length);await shares.get(id);
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});
      return response.end(shareLanding(id));
    }
    if(request.method==='GET'&&url.pathname==='/health'){
      const [engineStatus,catalogueState]=await Promise.all([engine(base,'status',undefined,abort.signal),catalogue()]);
      return send(200,{status:'ready',engine:'valhalla',version:engineStatus.version,implementation:'road-catalogue-v1',area:serviceArea,catalogue:catalogueState});
    }
    if(request.method==='GET'&&url.pathname==='/roads'){
      const center={latitude:Number(url.searchParams.get('lat')),longitude:Number(url.searchParams.get('lon'))};
      const radius=Number(url.searchParams.get('radiusKm')||20);
      if(!url.searchParams.has('lat')||!url.searchParams.has('lon')||!Number.isFinite(center.latitude)||!Number.isFinite(center.longitude)||!inArea(center)||!Number.isFinite(radius)||radius<=0||radius>100)throw new RoutingError('INVALID_REQUEST',`Supply a start in ${coverageLabel} and a radius from 0 to 100 km.`,400);
      return send(200,{area:serviceArea,roads:await roads({center,radiusKm:radius,limit:100})});
    }
    if(request.method!=='POST'||!['/route','/round-trip','/match'].includes(url.pathname))return send(404,{code:'NOT_FOUND'});
    const input=await body(request);
    context.setInput(input);
    if(url.pathname==='/match')return send(200,await matchRecording(input,(path,data,signal)=>engine(base,path,data,signal),abort.signal));
    if(url.pathname==='/round-trip') {
      const validated=validateInput(input),key=JSON.stringify(validated);
      const cached=routeCache.get(key);
      if(cached){context.setCache({status:'hit',ageMs:cached.ageMs});context.setPlanner(cached.value.planner);return send(200,cached.value);}
      context.setCache({status:'miss'});
      startRoads=createStartRoadCapture({center:input?.center,base,signal:abort.signal,engine,onUpdate:context.setStartRoads});
      const result=await plan(validated,{base,signal:abort.signal,route:startRoads.route});
      if(result.planner?.valid===true && !abort.signal.aborted)routeCache.set(key,result);
      context.setPlanner(result.planner);return send(200,result);
    }
    if(input.costing!=='motorcycle'||!Array.isArray(input.locations)||input.locations.length<2||input.locations.length>10||input.locations.some(p=>!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||!inArea({latitude:p.lat,longitude:p.lon})))throw new RoutingError('INVALID_REQUEST',`Expected 2–10 motorcycle locations within ${coverageLabel}.`,400);
    const payload=await engine(base,'route',input,abort.signal);
    if(!geometry(payload).every(inArea))throw new RoutingError('OUTSIDE_AREA',`The route leaves ${coverageLabel}.`,422);
    const {nativePath,nativeCostFactors,...publicPayload}=payload;
    return send(200,publicPayload);
  }catch(error){
    if(startRoads)await startRoads.resolve();
    const sharing=request.url?.startsWith('/shared');
    send(error.status||503,{code:error.code||(sharing?'SHARING_UNAVAILABLE':'CATALOGUE_UNAVAILABLE'),message:error.status?error.message:sharing?'Route sharing is temporarily unavailable.':'The road catalogue is temporarily unavailable.',diagnostics:error.diagnostics});
    context.setError(error.status?error:{code:error.code||'CATALOGUE_UNAVAILABLE',name:error.name});
  }finally{active--;}
});
server.requestTimeout=35000;server.headersTimeout=10000;
return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const server=createServer();
  server.listen(Number(process.env.PORT||8088),'0.0.0.0',()=>writeLog({event:'server.started',level:'info',port:server.address().port,implementation:'road-catalogue-v1'}));
}
