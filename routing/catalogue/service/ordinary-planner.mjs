import { removeInternalExcursions } from './excursions.mjs';
import { conePolygon, insideCone } from '../../service/cone.mjs';
import { validateInput } from './input.mjs';
import { pointAtBearing, routeDistance, splitSharedAccess } from '../../service/geometry.mjs';
import { engineJSON, valhallaRequest, geometry, assess, RoutingError } from '../../service/engine.mjs';
import { removeExcursions, routeAnchors, repeatedLocations } from '../../service/planner.mjs';

export async function planRoundTrip(raw, { base = process.env.VALHALLA_URL || 'http://127.0.0.1:8002', signal,
  budgetMs = 25000, maxAttempts = 24, accept, route = (request, abort) => engineJSON(base, 'route', request, abort) } = {}) {
  const input = validateInput(raw);
  const cone = input.radiusKm ? conePolygon(input, true) : null;
  const { center, targetKm, direction, avoidMotorways } = input;
  const started = Date.now();
  const deadline = AbortSignal.timeout(budgetMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const diagnostics = [], triedRequests=new Set();
  let approvedBest = null, lastWasApproved = false;
  let best = null, last = null, scale = targetKm / 4.8;
  const rotations = [0, -30, 30, -60, 60, -90, 90, 180];
  for (let attempt = 0; attempt < maxAttempts && !abort.aborted; attempt++) {
    let rotation = rotations[Math.floor(attempt / 3) % rotations.length];
    if (input.radiusKm) scale = Math.min(scale, input.radiusKm / 1.6);
    let width = (input.profile === 'fast' ? 40 : input.profile === 'winding' ? 50 : 60) + (Math.floor(attempt / rotations.length) % 3) * 10;
    // Older radius clients also need sector-shaped alternatives. Keep their
    // established variants between these attempts for backwards availability.
    if(input.coneAngleDegrees || (input.radiusKm && attempt%3===0)) {
      const half=(input.coneAngleDegrees??120)/2;
      rotation=Math.max(-half/2,Math.min(half/2,rotation));
      width=Math.min(width,half-Math.abs(rotation));
    }
    const points = [center, pointAtBearing(center, scale, direction + rotation - width),
      pointAtBearing(center, scale * 1.6, direction + rotation), pointAtBearing(center, scale, direction + rotation + width), center];
    let exclude = [];
    // Reuse a near-distance candidate's anchors while excluding its overlaps.
    let repair = false;
    if (attempt % 3 === 1 && last?.length) {
      const access = splitSharedAccess(last);
      const pruned = [...access.outbound.slice(0, -1), ...(lastWasApproved ? removeInternalExcursions(access.loop) : removeExcursions(access.loop)), ...access.returning.slice(1)];
      if (pruned.length > 3 && pruned.length < last.length) {
        points.splice(0, points.length, ...routeAnchors(pruned)); repair = true;
      }
    }
    if (attempt % 3 === 2 && best?.repair?.length) {
      points.splice(0, points.length, ...best.points); exclude = best.repair;
      repair = true;
    }
    // Keep the proven profile/repair search, but send only anchors inside the
    // buffered cone. Final acceptance still checks the whole road geometry.
    if (cone && !points.every(point => insideCone(point, cone))) {
      diagnostics.push({ attempt: attempt + 1, reason: 'CONE_WAYPOINTS', insideCone: false });
      continue;
    }
    try {
      const request=valhallaRequest(points,{avoidMotorways,exclude}),key=JSON.stringify(request);
      if(triedRequests.has(key)){diagnostics.push({attempt:attempt+1,reason:'DUPLICATE_REQUEST'});continue;}
      triedRequests.add(key);
      const payload = await route(request, abort);
      const path = geometry(payload);
      last = path;
      const metrics = assess(path, payload.trip.summary.length, targetKm, center);
      diagnostics.push({ attempt: attempt + 1, ...metrics, excludedLocations: exclude.length });
      const evaluated = accept ? await accept(payload) : null;
      if(payload.evaluationRejection)Object.assign(diagnostics.at(-1),payload.evaluationRejection);
      if(evaluated)Object.assign(diagnostics.at(-1),evaluated.metrics,{valid:true});
      lastWasApproved=accept ? Boolean(evaluated) : metrics.valid;
      if (accept ? Boolean(evaluated) : metrics.valid) {
        const approved={ ...payload, evaluated, planner: { engine: 'valhalla', ...metrics, attempts: attempt + 1, elapsedMs: Date.now() - started } };
        if(!approvedBest || (evaluated?.score ?? -metrics.distanceErrorKm) > (approvedBest.evaluated?.score ?? -approvedBest.planner.distanceErrorKm))approvedBest=approved;
        if(!accept || (evaluated.metrics.internalRepeatedRatio??0)<=0.001)return approved;
      }
      if (!best || metrics.distanceErrorKm + metrics.repeatedKm * 3 < best.score) {
        best = { points, repair: repeatedLocations(splitSharedAccess(path).withoutReturn, center), score: metrics.distanceErrorKm + metrics.repeatedKm * 3 };
      }
      if (!repair && metrics.distanceKm > 0) scale *= Math.max(0.65, Math.min(1.35, targetKm / metrics.distanceKm));
    } catch (error) {
      diagnostics.push({ attempt: attempt + 1, code: error.code || 'ENGINE_ERROR', message: error.message });
      if (error.code === 'ENGINE_UNAVAILABLE' || error.code === 'ENGINE_RESPONSE') break;
    }
  }
  if(approvedBest)return {...approvedBest,planner:{...approvedBest.planner,attempts:diagnostics.length,elapsedMs:Date.now()-started}};
  const routed = diagnostics.filter(row => row.distanceKm !== undefined);
  const code = !routed.length ? (diagnostics.at(-1)?.code || 'SEARCH_TIMEOUT') : abort.aborted ? 'SEARCH_TIMEOUT' : 'NO_MATCH';
  throw new RoutingError(code, !routed.length ? 'The routing engine could not calculate a route in this map region.'
    : 'No loop meeting the distance and shared-access limits was found within the search budget. Try a nearby starting road.',
  !routed.length ? 503 : 422, { elapsedMs: Date.now() - started, attempts: diagnostics });
}
