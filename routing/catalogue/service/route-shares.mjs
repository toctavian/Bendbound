import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RoutingError } from '../../service/engine.mjs';

export const validShareId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const invalid = () => { throw new RoutingError('INVALID_SHARED_ROUTE', 'This route cannot be shared. Check its stops and route geometry.', 400); };
const text = (s, max=500) => typeof s === 'string' && s.trim().length && s.length <= max ? s : invalid();
const number = (n, max=100000) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max ? n : invalid();
const coordinate = p => p && Number.isFinite(p.latitude) && Math.abs(p.latitude)<=85 && Number.isFinite(p.longitude) && Math.abs(p.longitude)<=180
  ? {latitude:p.latitude,longitude:p.longitude} : invalid();
export function validateSharedRoute(payload) {
  const r=payload?.route;
  if(payload?.version!==1 || !r || !['fast','winding','twisty'].includes(r.profile) || typeof payload.avoidMotorways!=='boolean'
    || !Array.isArray(r.route) || r.route.length<2 || r.route.length>30000
    || (r.stops!==undefined && (!Array.isArray(r.stops) || r.stops.length>1000))
    || (r.maneuvers!==undefined && (!Array.isArray(r.maneuvers) || r.maneuvers.length>5000))
    || (r.roundTrip!==undefined && typeof r.roundTrip!=='boolean'))invalid();
  const route={title:text(r.title),profile:r.profile,route:r.route.map(coordinate),distanceKm:number(r.distanceKm),durationMin:number(r.durationMin),curves:number(r.curves)};
  if(r.roundTrip!==undefined)route.roundTrip=r.roundTrip;
  if(r.stops)route.stops=r.stops.map(s=>({...coordinate(s),id:text(s.id),name:text(s.name),...(s.address!==undefined?{address:text(s.address,1000)}:{})}));
  if(r.maneuvers)route.maneuvers=r.maneuvers.map(m=>{
    if(!Number.isInteger(m.type) || m.type<0 || m.type>100 || !Number.isInteger(m.beginShapeIndex) || !Number.isInteger(m.endShapeIndex)
      || m.beginShapeIndex<0 || m.endShapeIndex<m.beginShapeIndex || m.endShapeIndex>=route.route.length)invalid();
    return {type:m.type,instruction:text(m.instruction,2000),beginShapeIndex:m.beginShapeIndex,endShapeIndex:m.endShapeIndex,
      ...(m.spokenInstruction?{spokenInstruction:text(m.spokenInstruction,2000)}:{}),...(m.streetName?{streetName:text(m.streetName)}:{}),
      ...(m.bearingAfter!==undefined?{bearingAfter:number(m.bearingAfter,360)}:{})};
  });
  return {version:1,route,avoidMotorways:payload.avoidMotorways};
}
export function createShareStore({directory=process.env.ROUTE_SHARES_DIR||'/shares',now=Date.now,ttlMs=90*86400000,maxBytes=256*1024*1024}={}) {
  let operations=Promise.resolve();
  return {
    create(payload){
      const value=validateSharedRoute(payload);
      const operation=operations.catch(()=>{}).then(async()=>{
        await mkdir(directory,{recursive:true});let bytes=0;
        for(const name of await readdir(directory)) {
          if(!/^[a-f0-9]{32}\.json$/.test(name))continue;
          const file=path.join(directory,name),info=await stat(file);
          if(now()-info.mtimeMs>ttlMs)await unlink(file);else bytes+=info.size;
        }
        const data=JSON.stringify({...value,expiresAt:now()+ttlMs});
        if(bytes+Buffer.byteLength(data)>maxBytes)throw new RoutingError('SHARING_FULL','Route sharing is temporarily full. Please try again later.',503);
        const id=randomBytes(16).toString('hex');await writeFile(path.join(directory,`${id}.json`),data,{flag:'wx',mode:0o600});
        return {id,expiresAt:now()+ttlMs};
      });operations=operation;return operation;
    },
    async get(id){
      if(!validShareId(id))throw new RoutingError('SHARE_NOT_FOUND','This shared route is unavailable or has expired.',404);
      let value;
      try{value=JSON.parse(await readFile(path.join(directory,`${id}.json`),'utf8'));}
      catch(error){if(error.code!=='ENOENT')throw error;throw new RoutingError('SHARE_NOT_FOUND','This shared route is unavailable or has expired.',404);}
      if(value.expiresAt<=now())throw new RoutingError('SHARE_EXPIRED','This shared route has expired.',410);
      return validateSharedRoute(value);
    },
  };
}
export const association = {applinks:{apps:[],details:[{appID:'U5CJCX8BV2.com.octavian.bendbound',paths:['/shared/*']} ]}};
export function shareLanding(id) {
  if(!validShareId(id))throw new RoutingError('SHARE_NOT_FOUND','This shared route is unavailable.',404);
  // No user-authored text is interpolated into HTML.
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open route in Bendbound</title><style>body{background:#101114;color:#fff;font:18px system-ui;padding:48px 24px;max-width:500px;margin:auto}a{display:inline-block;padding:16px;background:#f43f5e;border-radius:12px;color:white;text-decoration:none}</style><h1>A ride for you</h1><p>Open this route in Bendbound to view it, edit the stops and choose when to start.</p><a href="bendbound://shared/${id}">Open in Bendbound</a><p>You’ll need Bendbound installed. Shared routes are available for 90 days.</p></html>`;
}
