import { RoutingError } from '../../service/engine.mjs';
import { decodePolyline, distanceBetween, routeDistance } from '../../service/geometry.mjs';
import { inArea, coverageLabel } from './policy.mjs';
export async function matchRecording(raw, engine, signal) {
  const points=raw?.points;
  if(!Array.isArray(points)||points.length<2||points.length>128||points.some(p=>!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude)||!inArea(p)
    || (p.timestamp!==undefined && !Number.isFinite(p.timestamp))
    || (p.accuracy!==undefined && (!Number.isFinite(p.accuracy)||p.accuracy<0||p.accuracy>50))))
    throw new RoutingError('INVALID_REQUEST',`Supply 2–128 recorded points within ${coverageLabel}.`,400);
  for(let i=1;i<points.length;i++) if(Number.isFinite(points[i].timestamp)&&Number.isFinite(points[i-1].timestamp)
    && (points[i].timestamp<=points[i-1].timestamp||points[i].timestamp-points[i-1].timestamp>30000))
    throw new RoutingError('INVALID_REQUEST','Match continuous recording segments separately.',400);
  const payload=await engine('trace_attributes',{shape:points.map(p=>({lat:p.latitude,lon:p.longitude})),
    shape_match:'map_snap',costing:'motorcycle',trace_options:{gps_accuracy:10,search_radius:50},
    filters:{action:'include',attributes:['shape','matched.point','matched.type','matched.begin_route_discontinuity','matched.end_route_discontinuity']}},signal);
  const matched=payload.matched_points;
  if(!Array.isArray(matched)||matched.length!==points.length||matched.some((p,i)=>
    !['matched','interpolated'].includes(p.type)||p.begin_route_discontinuity||p.end_route_discontinuity
    || !Number.isFinite(p.lat)||!Number.isFinite(p.lon)||distanceBetween(points[i],{latitude:p.lat,longitude:p.lon})*1000>Math.min(50,Math.max(20,(points[i].accuracy??20)*1.5))))
    throw new RoutingError('NO_MATCH','The recording could not be matched confidently to connected roads.',422);
  const geometry=typeof payload.shape==='string'?decodePolyline(payload.shape):[];
  if(geometry.length<2||!geometry.every(inArea)||routeDistance(geometry)>routeDistance(points)*2+0.2)
    throw new RoutingError('NO_MATCH','The road match was incomplete or introduced a detour.',422);
  return {geometry};
}
