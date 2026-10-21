import { removeInternalExcursions } from './excursions.mjs';
import { validateInput } from './input.mjs';
import { conePolygon, insideCone, coneBufferKm } from '../../service/cone.mjs';
import { removeExcursions, routeAnchors } from '../../service/planner.mjs';
import { planRoundTrip as ordinaryPlan } from './ordinary-planner.mjs';
import { assess, engineJSON, geometry, RoutingError, valhallaRequest } from '../../service/engine.mjs';
import { pointAtBearing, distanceBetween, splitSharedAccess, routeDistance } from '../../service/geometry.mjs';
import { nearby, matchRoute, roadUse, graphMode } from './catalogue.mjs';
import { nativeUsage, ratingFactors } from './graph-catalogue.mjs';
import { graphEngine } from './graph-engine.mjs';
import { physicalSegments, measureIdentifiedGeometry } from './road-use.mjs';
import { inArea, coverageLabel, serviceArea, candidateScore, betterCandidate } from './policy.mjs';

function bearing(a,b) {
  return (Math.atan2((b.longitude-a.longitude)*Math.cos(a.latitude*Math.PI/180),b.latitude-a.latitude)*180/Math.PI+360)%360;
}
export function sectionAnchors(section, reverse = false) {
  const line = reverse ? [...section.geometry.coordinates].reverse() : section.geometry.coordinates;
  // Preserve the full line in PostGIS, select distributed through-points only
  // for the engine request, and verify actual traversal afterwards.
  return [...new Set(Array.from({length:7},(_,i)=>Math.round((line.length-1)*i/6)))].map(i=>({longitude:line[i][0],latitude:line[i][1]}));
}
export function candidatePoints(input, section, variant = 0, scale = input.targetKm/4.8) {
  let anchors=sectionAnchors(section,Boolean(variant%2));
  const middle=anchors[Math.floor(anchors.length/2)];
  const direction=input.radiusKm ? input.direction : bearing(input.center,middle);
  if(input.radiusKm) scale=Math.min(scale,input.radiusKm/1.6);
  const width=Math.min(input.coneAngleDegrees ? input.coneAngleDegrees/2 : 90,input.profile==='fast'?40:input.profile==='twisty'?60:50);
  const left=pointAtBearing(input.center,scale,direction-width);
  const right=pointAtBearing(input.center,scale,direction+width);
  const outer=pointAtBearing(input.center,scale*1.6,direction);
  return variant<2 ? [input.center,...anchors,left,outer,right,input.center]
    : [input.center,left,outer,right,...anchors,input.center];
}
function encode(points) {
  let lat=0,lon=0,out='';
  const write=delta=>{let n=delta<0?~(delta<<1):delta<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63);};
  for(const p of points){const a=Math.round(p.latitude*1e6),b=Math.round(p.longitude*1e6);write(a-lat);write(b-lon);lat=a;lon=b;}
  return out;
}
export async function planRoundTrip(raw, {
  base=process.env.VALHALLA_URL, signal, budgetMs=25000, backend=graphMode()?'valhalla':'postgis', allowFallback=true, catalogueNativeUsage=nativeUsage,
  catalogueNearby=nearby, catalogueMatch=matchRoute, catalogueRoadUse=roadUse,
  route=(request,abort)=>(backend==='valhalla'?graphEngine:engineJSON)(base,'route',request,abort),
  trace=(request,abort)=>engineJSON(base,'trace_attributes',request,abort),
  fallback=ordinaryPlan,
}={}) {
  const input=validateInput(raw);
  const cone=input.radiusKm ? conePolygon(input,true) : null;
  const allowed=p=>inArea(p) && (!cone || insideCone(p,cone));
  if(!inArea(input.center)) throw new RoutingError('OUTSIDE_AREA',`Choose a start within ${coverageLabel}.`,422);
  const started=Date.now(),deadline=AbortSignal.timeout(budgetMs);
  const abort=signal?AbortSignal.any([signal,deadline]):deadline;
  // Reserve most of the request budget for ordinary-loop search when catalogue
  // waypoints are difficult to reach from a dense urban starting road.
  const catalogueBudgetMs=Math.min(7500,budgetMs*0.3);
  let best=null,attempts=0,rejection=null,fallbackAttempted=false;
  const diagnostics=[];
  const roads=await catalogueNearby({center:input.center,radiusKm:input.radiusKm ? input.radiusKm+coneBufferKm(input.radiusKm) : Math.min(65,input.targetKm/2),limit:80,areaPolygon:cone});
  // Geographic proximity is only a shortlist. Engine routing checks access.
  const ranked=roads.filter(s=>s.lengthKm<input.targetKm*0.45 && s.rating>=1.5 && (!cone || s.geometry.coordinates.every(([longitude,latitude])=>allowed({longitude,latitude}))))
    .map(s=>{const anchor=sectionAnchors(s)[0],delta=Math.abs(((bearing(input.center,anchor)-input.direction+540)%360)-180);
      return {s,rank:s.rating+s.recommendationCount*0.4+(input.profile==='twisty'?s.twisty:s.winding)*0.4-delta/90-6*distanceBetween(input.center,anchor)/Math.max(1,input.targetKm)};})
    .sort((a,b)=>b.rank-a.rank);
  const factors=backend==='valhalla'?ratingFactors(ranked.map(r=>r.s),input.profile):[];
  const requestRoute=route;
  route=(request,signal)=>requestRoute(factors.length?{...request,graph_cost_factors:factors}:request,signal);
  // Avoid spending every attempt on adjacent pieces of the same road.
  const selected=[];
  for(const {s} of ranked) if(selected.every(x=>distanceBetween(sectionAnchors(x)[0],sectionAnchors(s)[0])>1)) {
    selected.push(s);if(selected.length===6)break;
  }
  async function evaluate(payload, chosen, repairDepth = 0) {
    const distanceKm=payload.trip?.summary?.length,distanceErrorKm=Math.abs(distanceKm-input.targetKm);
    // Pruning cannot make a short route longer. Overlong routes must still be
    // checked for removable excursions: skipping that repair loses valid loops.
    if(Number.isFinite(distanceKm) && distanceKm>0 && distanceKm<=input.targetKm-10) {
      rejection={reason:'POLICY',valid:false,distanceKm,distanceErrorKm};return null;
    }
    const points=geometry(payload),metrics=assess(points,payload.trip.summary.length,input.targetKm,input.center);
    const strictGeometryValid=metrics.valid;
    // Diagnose interior reuse separately from the short common access road.
    // Finish snaps can differ by a few metres; normalise only this diagnostic,
    // retaining original geometry for physical identity and acceptance checks.
    const normalized=distanceBetween(points[0],points.at(-1))<0.02 ? [...points.slice(0,-1),points[0]] : points;
    metrics.internalRepeatedRatio=assess(normalized,payload.trip.summary.length,input.targetKm,input.center).remainingRepeatedRatio;
    metrics.endpointGapMetres=distanceBetween(points[0],points.at(-1))*1000;
    if(metrics.distanceErrorKm>=10 || !metrics.closed || !metrics.nearStart || !points.every(allowed)) {
      rejection={reason:'POLICY',...metrics,valid:false,insideArea:points.every(inArea),insideCone:!cone || points.every(p=>insideCone(p,cone))};return null;
    }
    let usage,wayIds;
    const totalKm=routeDistance(points);
    if(backend==='valhalla') {
      usage=await catalogueNativeUsage(payload,points,abort);
      wayIds=[...new Set(payload.nativePath.flatMap(l=>l.edges.map(e=>e.way_id)))];
    } else {
    const attributes=await trace({encoded_polyline:encode(points),shape_match:'walk_or_snap',costing:'motorcycle',
      costing_options:valhallaRequest([input.center],{avoidMotorways:input.avoidMotorways}).costing_options,
      filters:{action:'include',attributes:['shape','edge.way_id','edge.begin_shape_index','edge.end_shape_index']}},abort);
    wayIds=[...new Set((attributes.edges||[]).map(e=>String(e.way_id)).filter(x=>/^\d+$/.test(x)))];
    if(!wayIds.length) throw new RoutingError('ENGINE_RESPONSE','Road identity verification failed.',502);
    try{usage=await catalogueRoadUse(physicalSegments(attributes,points),totalKm,points);}
    catch(error){if(!strictGeometryValid || !['ROAD_IDENTITY','ENGINE_RESPONSE'].includes(error.code))throw error;}
    // Previously accepted strict loops already prove no internal reuse and only
    // two short access traversals. Keep that stronger geometric subset when
    // trace matching omits access geometry; do not invent verified road IDs.
    if(strictGeometryValid && (!usage || (!usage.valid && usage.maxTraversals<=2 && usage.repeatedRatio<=0.1))) {
      const geometryUse=measureIdentifiedGeometry(points.slice(1).map((p,i)=>({wayId:'strict-geometry',
        a:[points[i].longitude,points[i].latitude],b:[p.longitude,p.latitude]})),totalKm);
      usage={...geometryUse,valid:geometryUse.maxTraversals<=2 && geometryUse.repeatedRatio<=0.1,
        verifiedKm:usage?.verifiedKm,verifiedRatio:usage?.verifiedRatio,
        identityVerification:'strict-geometry-subset',roadUsePolicy:'physical-segments-twice-10-percent'};
    }
    }
    Object.assign(metrics,{geometrySharedAccessKm:metrics.sharedAccessKm},usage);
    if(!metrics.valid){rejection={reason:'ROAD_USE',...metrics,insideArea:true};return null;}
    const included=await catalogueMatch(points,wayIds,payload);
    // Keep a policy-valid loop even if it misses the suggested section. Only
    // claim a selected section when the actual route traverses its full length.
    const fullSection=chosen && included.some(s=>s.id===chosen.id&&s.fullSection);
    const access=splitSharedAccess(points);
    const pruned=[...access.outbound.slice(0,-1),...removeInternalExcursions(access.loop),...access.returning.slice(1)];
    metrics.internalExcursionKm=Math.max(0,totalKm-routeDistance(pruned));
    const original={payload,metrics,included,chosen:fullSection?chosen.id:null,score:candidateScore(metrics,included,input.targetKm)};
    // An allowed repeated-distance budget is not a reason to keep a removable
    // internal spur. Repair even policy-valid routes, using legal engine routing.
    if(repairDepth<2 && metrics.internalExcursionKm>0.05 && !abort.aborted && budgetMs-(Date.now()-started)>2000) {
      if(pruned.length>3 && pruned.length<points.length) {
        try {
          attempts++;
          const anchors=routeAnchors(pruned),request=valhallaRequest(anchors,{avoidMotorways:input.avoidMotorways});
          // These points are already known to lie on legal routed roads. Avoid
          // snapping them up to 2 km onto another road while repairing a spur.
          for(let i=1;i<request.locations.length-1;i++)request.locations[i].search_cutoff=30;
          const repaired=await route(request,abort);
          const cleaner=await evaluate(repaired,chosen,repairDepth+1);
          if(cleaner && betterCandidate(cleaner,original)) {
            cleaner.metrics.excursionsRemovedKm=Math.max(0,distanceKm-cleaner.metrics.distanceKm);
            return cleaner;
          }
        } catch(error) {diagnostics.push({reason:'REPAIR_UNAVAILABLE',code:error.code||'REPAIR_ERROR'});}
      }
    }
    return original;
  }
  search: for(const road of selected) {
    if(abort.aborted || Date.now()-started>catalogueBudgetMs)break;
    let scale=input.targetKm/4.8;
    for(let variant=0;variant<4;variant++) {
      if(abort.aborted || Date.now()-started>catalogueBudgetMs)break;
      const points=candidatePoints(input,road,variant,scale);
      if(!points.every(allowed))continue;
      attempts++;
      try {
        const request=valhallaRequest(points,{avoidMotorways:input.avoidMotorways});
        const count=sectionAnchors(road).length;
        const first=variant<2?1:4;
        for(let i=first;i<first+count;i++)request.locations[i].search_cutoff=30;
        const payload=await route(request,abort);
        let result=await evaluate(payload,road);
        if(!result && ['POLICY','ROAD_USE'].includes(rejection?.reason) && rejection.repeatedKm>0 && !abort.aborted && Date.now()-started<catalogueBudgetMs) {
          const access=splitSharedAccess(geometry(payload));
          const pruned=[...access.outbound.slice(0,-1),...removeExcursions(access.loop),...access.returning.slice(1)];
          if(pruned.length>3 && pruned.length<geometry(payload).length) {
            attempts++;
            const repaired=await route(valhallaRequest(routeAnchors(pruned),{avoidMotorways:input.avoidMotorways}),abort);
            result=await evaluate(repaired,road);
          }
        }
        if(result)result.routeSource='main';
        diagnostics.push({sectionId:road.id,valid:Boolean(result),...(!result?rejection:{})});
        if(!result && rejection?.reason==='POLICY' && rejection.distanceKm>0)
          scale*=Math.max(0.75,Math.min(1.25,input.targetKm/rejection.distanceKm));
        if(result && betterCandidate(result,best))best=result;
        if(result?.chosen && result.metrics.internalExcursionKm<=0.05 && result.metrics.internalRepeatedRatio<=0.001 && result.metrics.distanceErrorKm<2)break search;
      } catch(error) {
        diagnostics.push({sectionId:road.id,code:error.code||'CATALOGUE_ERROR'});
        if(error.status===503) {if(!best)throw error;break search;}
      }
    }
  }
  // Preserve ordinary-road availability and give it the same measured scoring.
  if(allowFallback && (!best || best.metrics.internalExcursionKm>0.05 || best.metrics.internalRepeatedRatio>0.001 || best.metrics.distanceErrorKm>2) && !abort.aborted && budgetMs-(Date.now()-started)>1500) {
    fallbackAttempted=true;
    try {
      const payload=await fallback(input,{base,signal:abort,budgetMs:Math.max(1,budgetMs-(Date.now()-started)-1500),route,accept:async payload=>{const result=await evaluate(payload);if(!result)payload.evaluationRejection=rejection;return result;}});
      attempts+=payload.planner.attempts;
      const result=payload.evaluated || await evaluate(payload);
      if(result){result.routeSource='fallback';if(betterCandidate(result,best))best=result;}
    } catch(error) {diagnostics.push({fallback:true,code:error.code||'FALLBACK_ERROR',diagnostics:error.diagnostics});if(!best&&error.status===503)throw error;}
  }
  if(!best) throw new RoutingError('NO_MATCH',input.radiusKm ? 'No valid loop within the selected direction and radius met the distance and road-reuse requirements. Widen the cone, adjust the distance or move the start.' : `No valid loop in ${coverageLabel} met the distance and road-reuse requirements.`,422,{attempts:diagnostics,elapsedMs:Date.now()-started});
  const {nativePath,nativeCostFactors,evaluationRejection,...response}=best.payload;
  return {...response,planner:{...best.metrics,engine:'valhalla',implementation:'road-catalogue-v1',catalogueBackend:backend,routeSource:best.routeSource,fallbackAttempted,ratingFactorsApplied:factors.length,
    insideCone:cone ? true : undefined,coneRadiusKm:input.radiusKm,coneAngleDegrees:input.radiusKm ? input.coneAngleDegrees ?? 120 : undefined,coneBufferKm:input.radiusKm ? coneBufferKm(input.radiusKm) : undefined,attempts,elapsedMs:Date.now()-started,score:best.score,selectedRoadSectionId:best.chosen,recommendedKm:best.included.reduce((s,r)=>s+(r.recommendationCount?r.traversedKm:0),0),
    evaluatedKm:best.included.reduce((s,r)=>s+r.traversedKm,0),roads:best.included,
    ratingBasis:'geometry-and-independent-guide-frequency',area:serviceArea}};
}
