import { decodePolyline, roadCells, sharedRoadInterval } from '../../service/geometry.mjs';
import { RoutingError } from '../../service/engine.mjs';

export function tracedSegments(attributes) {
  const points=decodePolyline(attributes.shape||'');
  if(points.length<2 || !attributes.edges?.length)throw new RoutingError('ENGINE_RESPONSE','Road traversal identity is unavailable.',502);
  const segments=[];
  for(const edge of attributes.edges) {
    if(!/^\d+$/.test(String(edge.way_id)) || !Number.isInteger(edge.begin_shape_index) || !Number.isInteger(edge.end_shape_index)
      || edge.begin_shape_index<0 || edge.end_shape_index>=points.length || edge.end_shape_index<=edge.begin_shape_index)
      throw new RoutingError('ENGINE_RESPONSE','Road traversal identity is incomplete.',502);
    for(let i=edge.begin_shape_index;i<edge.end_shape_index;i++)segments.push({wayId:String(edge.way_id),
      a:[points[i].longitude,points[i].latitude],b:[points[i+1].longitude,points[i+1].latitude]});
  }
  return segments;
}

export function physicalSegments(attributes,original) {
  const traced=tracedSegments(attributes),origin=original[0],scale=Math.cos(origin.latitude*Math.PI/180);
  const xy=p=>[(p[0]-origin.longitude)*111195*scale,(p[1]-origin.latitude)*111195];
  const cells=new Map();
  for(const s of traced) {
    s.start=xy(s.a);s.end=xy(s.b);
    const steps=Math.max(1,Math.ceil(Math.hypot(s.end[0]-s.start[0],s.end[1]-s.start[1])/20));
    for(let i=0;i<=steps;i++) {
      const key=`${Math.floor((s.start[0]+(s.end[0]-s.start[0])*i/steps)/20)},${Math.floor((s.start[1]+(s.end[1]-s.start[1])*i/steps)/20)}`;
      if(!cells.has(key))cells.set(key,new Set());cells.get(key).add(s);
    }
  }
  const segments=[];
  for(let i=1;i<original.length;i++) {
    const a=[original[i-1].longitude,original[i-1].latitude],b=[original[i].longitude,original[i].latitude];
    const u=xy(a),v=xy(b),mid=[(u[0]+v[0])/2,(u[1]+v[1])/2];
    if(Math.hypot(u[0]-v[0],u[1]-v[1])<0.01)continue;
    const ways=new Set();
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++) {
      for(const s of cells.get(`${Math.floor(mid[0]/20)+dx},${Math.floor(mid[1]/20)+dy}`)||[]) {
        const x=s.end[0]-s.start[0],y=s.end[1]-s.start[1],length=x*x+y*y;
        const t=length?Math.max(0,Math.min(1,((mid[0]-s.start[0])*x+(mid[1]-s.start[1])*y)/length)):0;
        if(Math.hypot(mid[0]-s.start[0]-t*x,mid[1]-s.start[1]-t*y)<=1)ways.add(s.wayId);
      }
    }
    if(!ways.size)throw new RoutingError('ROAD_IDENTITY','The matched roads do not follow the routed geometry.',502);
    for(const wayId of ways)segments.push({wayId,a,b});
  }
  return segments;
}

export function measureIdentifiedGeometry(parts,totalKm) {
  const origin=parts[0]?.a,scale=origin?Math.cos(origin[1]*Math.PI/180):1,cells=new Map();
  let repeatedKm=0,maxTraversals=0;
  const point=p=>({x:(p[0]-origin[0])*111195*scale,y:(p[1]-origin[1])*111195});
  for(const part of parts) {
    const start=point(part.a),end=point(part.b),length=Math.hypot(end.x-start.x,end.y-start.y);
    if(length<=0.01)continue;
    const current={start,end,length},occupied=roadCells(current),candidates=new Set();
    for(const [x,y] of occupied)for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)
      for(const previous of cells.get(`${part.wayId}:${x+dx},${y+dy}`)||[])candidates.add(previous);
    const events=[[0,0],[length,0]];
    for(const previous of candidates){const interval=sharedRoadInterval(current,previous);if(interval)events.push([interval[0],1],[interval[1],-1]);}
    events.sort((a,b)=>a[0]-b[0]);let count=0,last=0;
    for(let i=0;i<events.length;) {
      const at=events[i][0],span=at-last;
      if(span>0.01){if(count)repeatedKm+=span/1000;maxTraversals=Math.max(maxTraversals,count+1);}
      while(i<events.length && events[i][0]===at)count+=events[i++][1];last=at;
    }
    for(const [x,y] of occupied){const key=`${part.wayId}:${x},${y}`;if(!cells.has(key))cells.set(key,new Set());cells.get(key).add(current);}
  }
  return {repeatedKm,repeatedRatio:repeatedKm/totalKm,maxTraversals};
}

// Sweep intervals on undirected physical segments, imported or native. Disjoint pieces of a
// long named road remain distinct, and opposite directions share one identity.
export function measureRoadUse(rows,totalKm) {
  const edges=new Map();let verifiedKm=0;
  for(const row of rows) {
    const from=Number(row.from_fraction),to=Number(row.to_fraction),length=Number(row.length_m);
    if(!Number.isFinite(from)||!Number.isFinite(to)||!Number.isFinite(length)||length<=0||from<0||to>1||to<=from)
      throw new RoutingError('ROAD_IDENTITY','Invalid physical road interval.',502);
    const key=String(row.edge_id);let edge=edges.get(key);
    if(!edge){edge={length,events:[]};edges.set(key,edge);}
    if(Math.abs(edge.length-length)>0.01)throw new RoutingError('ROAD_IDENTITY','Inconsistent physical road identity.',502);
    edge.events.push([from,1],[to,-1]);verifiedKm+=(to-from)*length/1000;
  }
  let repeatedKm=0,uniqueKm=0,maxTraversals=0;
  for(const {length,events} of edges.values()) {
    events.sort((a,b)=>a[0]-b[0]);let count=0,last=0;
    for(let i=0;i<events.length;) {
      const at=events[i][0],km=(at-last)*length/1000;
      if(km>0.00001) { // Ignore only sub-centimetre floating-point boundaries.
        if(count>0)uniqueKm+=km;
        repeatedKm+=Math.max(0,count-1)*km;maxTraversals=Math.max(maxTraversals,count);
      }
      while(i<events.length && events[i][0]===at)count+=events[i++][1];last=at;
    }
  }
  const repeatedRatio=repeatedKm/totalKm;
  return {valid:rows.length>0 && verifiedKm>=totalKm*0.98 && verifiedKm<=totalKm*1.02
    && maxTraversals<=2 && repeatedRatio<=0.1+1e-9,
    repeatedKm,repeatedRatio,maxTraversals,uniqueKm,verifiedKm,verifiedRatio:verifiedKm/totalKm,
    roadUsePolicy:'physical-segments-twice-10-percent'};
}
