import fs from 'node:fs';
import protobuf from 'protobufjs';
import { engineJSON, RoutingError } from '../../service/engine.mjs';

// Generated from the MIT-licensed Valhalla 3.9.0 Api descriptors. Keep this
// schema and the pinned routing image in step; IDs are decoded as strings.
export const apiType=protobuf.Root.fromJSON(JSON.parse(fs.readFileSync(new URL('./valhalla-schema.json',import.meta.url)))).lookupType('valhalla.Api');
const location=p=>({ll:{lat:p.lat,lng:p.lon},type:{break:0,through:1,via:2,break_through:3}[p.type??'break'],
  ...Object.fromEntries(['search_cutoff','heading','heading_tolerance','radius','minimum_reachability','node_snap_tolerance'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]))});
export function encodeRouteRequest(request) {
  if(request.costing!=='motorcycle')throw new RoutingError('INVALID_REQUEST','Native routes require motorcycle costing.',400);
  const options={format:3,action:1,units:0,language:request.directions_options?.language??'en-GB',shape_format:0,
    costing_type:8,costings:{8:{type:8,options:{...request.costing_options?.motorcycle,cost_factor_edges:request.graph_cost_factors??[]}}},
    locations:request.locations.map(location),exclude_locations:(request.exclude_locations??[]).map(location),
    pbf_field_selector:{trip:true,directions:true,options:false},
    cost_factor_lines:(request.linear_cost_factors??[]).map(f=>({shape:f.geometry.coordinates.map(([lon,lat])=>location({lat,lon})),cost_factor:f.properties.factor,ignore_access_restrictions:false}))};
  const message=apiType.fromObject({options});
  const error=apiType.verify(message);if(error)throw new RoutingError('INVALID_REQUEST',error,400);
  return apiType.encode(message).finish();
}
const names=values=>(values??[]).map(v=>v.value);
function summary(s) {const b=s.bbox;return {length:s.length,time:s.time,has_time_restrictions:s.has_time_restrictions,has_toll:s.has_toll,has_ferry:s.has_ferry,has_highway:s.has_highway,
  ...(b?{min_lat:b.min_ll.lat,min_lon:b.min_ll.lng,max_lat:b.max_ll.lat,max_lon:b.max_ll.lng}:{})};}
export function decodeRouteResponse(bytes) {
  const api=apiType.toObject(apiType.decode(bytes),{longs:String,defaults:true});
  if(api.info?.errors?.length)throw new RoutingError('ENGINE_ROUTE',api.info.errors.map(e=>e.description).join('; '),422);
  const directed=api.directions?.routes?.[0]?.legs,path=api.trip?.routes?.[0]?.legs;
  if(!directed?.length || path?.length!==directed.length)throw new RoutingError('ENGINE_RESPONSE','Native routing path or directions are missing.',502);
  const legs=directed.map((l,i)=>{
    if(l.shape!==path[i].shape)throw new RoutingError('ROAD_IDENTITY','Directions differ from the native routing path.',502);
    return {shape:l.shape,summary:summary(l.summary),maneuvers:l.maneuver.map(m=>({
      ...m,type:m.type,instruction:m.text_instruction,street_names:names(m.street_name),begin_street_names:names(m.begin_street_name),
      travel_mode:'drive',travel_type:'motorcycle',begin_cardinal_direction:['north','northeast','east','southeast','south','southwest','west','northwest'][m.begin_cardinal_direction],
    }))};
  });
  const total=legs.reduce((s,l)=>({length:s.length+l.summary.length,time:s.time+l.summary.time}),{length:0,time:0});
  return {trip:{status:0,status_message:'Found route between points',units:'kilometers',language:'en-GB',summary:total,legs},
    nativeCostFactors:api.options?.costings?.['8']?.options?.cost_factor_edges??[],
    nativePath:path.map(l=>({shape:l.shape,edges:l.node.filter(n=>n.edge).map(({edge:e})=>({id:e.id,way_id:e.way_id,begin_shape_index:e.begin_shape_index,end_shape_index:e.end_shape_index,source_along_edge:e.source_along_edge,target_along_edge:e.target_along_edge,name:e.name.map(n=>({value:n.value})),length_km:e.length_km}))}))};
}
export async function nativeRoute(base,request,signal) {
  let response;
  try {response=await fetch(`${base.replace(/\/$/,'')}/route`,{method:'POST',headers:{'Content-Type':'application/x-protobuf'},body:encodeRouteRequest(request),
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}
  catch(e){if(e instanceof RoutingError)throw e;throw new RoutingError('ENGINE_UNAVAILABLE',`Routing engine unavailable: ${e.name}`,503);}
  if(!response.ok){
    const bytes=new Uint8Array(await response.arrayBuffer());let message;
    try{const error=apiType.toObject(apiType.decode(bytes),{longs:String});message=error.info?.errors?.map(e=>`${e.code}: ${e.description}`).join('; ');}catch{}
    if(!message)try{const error=JSON.parse(Buffer.from(bytes).toString());message=error.error??error.message;}catch{}
    throw new RoutingError('ENGINE_ROUTE',message||`Engine HTTP ${response.status}`,422);
  }
  try{return decodeRouteResponse(new Uint8Array(await response.arrayBuffer()));}catch(e){if(e instanceof RoutingError)throw e;throw new RoutingError('ENGINE_RESPONSE','Invalid native routing response.',502);}
}
export const graphEngine=(base,path,body,signal)=>path==='route'?nativeRoute(base,body,signal):engineJSON(base,path,body,signal);
