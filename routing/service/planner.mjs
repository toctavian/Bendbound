import { pointAtBearing, distanceBetween, routeDistance, splitSharedAccess } from './geometry.mjs';
import { engineJSON, valhallaRequest, geometry, assess, RoutingError } from './engine.mjs';

export function validateInput(input) {
  const { center, targetKm, direction, profile, avoidMotorways } = input || {};
  if (!center || !Number.isFinite(center.latitude) || Math.abs(center.latitude) > 85 || !Number.isFinite(center.longitude) || Math.abs(center.longitude) > 180
    || !Number.isFinite(targetKm) || targetKm < 5 || targetKm > 500 || !Number.isFinite(direction)
    || !['fast', 'winding', 'twisty'].includes(profile) || typeof avoidMotorways !== 'boolean') {
    throw new RoutingError('INVALID_REQUEST', 'Choose a valid start, riding style and distance between 5 and 500 km.', 400);
  }
  return { center, targetKm, direction: (direction % 360 + 360) % 360, profile, avoidMotorways };
}

// Midpoints on a repeated segment guide a new request away from that road.
// These are coordinate exclusions, not a guarantee of graph-edge disjointness.
// The shared geometry validator always checks the complete resulting route.
export function repeatedLocations(points, start) {
  const seen = new Map();
  const repeats = [];
  const key = p => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (distanceBetween(a, b) < 0.003) continue;
    const segment = [key(a), key(b)].sort().join('/');
    const midpoint = { latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2 };
    if (seen.has(segment) && distanceBetween(midpoint, start) > 0.2
      && repeats.every(p => distanceBetween(p, midpoint) > 0.1)) repeats.push(midpoint);
    seen.set(segment, true);
  }
  return repeats.slice(0, 30);
}

// A snapped waypoint can create a spur: junction -> dead end -> same junction.
// Remove such excursions, then ask the engine to route the retained points again
// so navigation instructions and turn restrictions are recalculated legally.
export function removeExcursions(points) {
  const stack = [], indices = new Map();
  const key = p => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
  for (let i = 0; i < points.length; i++) {
    const point = points[i], id = key(point);
    const earlier = indices.get(id);
    if (earlier !== undefined && !(earlier === 0 && i === points.length - 1)) {
      while (stack.length > earlier + 1) indices.delete(key(stack.pop()));
    } else { indices.set(id, stack.length); stack.push(point); }
  }
  return stack;
}

export function routeAnchors(points, limit = 45) {
  const step = routeDistance(points) / (limit - 1);
  const result = [points[0]]; let since = 0;
  for (let i = 1; i < points.length - 1; i++) {
    since += distanceBetween(points[i - 1], points[i]);
    if (since >= step && result.length < limit - 1) { result.push(points[i]); since = 0; }
  }
  result.push(points.at(-1));
  return result;
}

export async function planRoundTrip(raw, { base = process.env.VALHALLA_URL || 'http://127.0.0.1:8002', signal,
  budgetMs = 25000, maxAttempts = 24, route = (request, abort) => engineJSON(base, 'route', request, abort) } = {}) {
  const input = validateInput(raw);
  const { center, targetKm, direction, avoidMotorways } = input;
  const started = Date.now();
  const deadline = AbortSignal.timeout(budgetMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const diagnostics = [];
  let best = null, last = null, scale = targetKm / 4.8;
  const rotations = [0, -30, 30, -60, 60, -90, 90, 180];
  for (let attempt = 0; attempt < maxAttempts && !abort.aborted; attempt++) {
    const rotation = rotations[Math.floor(attempt / 3) % rotations.length];
    const width = (input.profile === 'fast' ? 40 : input.profile === 'winding' ? 50 : 60) + (Math.floor(attempt / rotations.length) % 3) * 10;
    const points = [center, pointAtBearing(center, scale, direction + rotation - width),
      pointAtBearing(center, scale * 1.6, direction + rotation), pointAtBearing(center, scale, direction + rotation + width), center];
    let exclude = [];
    // Reuse a near-distance candidate's anchors while excluding its overlaps.
    let repair = false;
    if (attempt % 3 === 1 && last?.length) {
      const access = splitSharedAccess(last);
      const pruned = [...access.outbound.slice(0, -1), ...removeExcursions(access.loop), ...access.returning.slice(1)];
      if (pruned.length > 3 && pruned.length < last.length) {
        points.splice(0, points.length, ...routeAnchors(pruned)); repair = true;
      }
    }
    if (attempt % 3 === 2 && best?.repair?.length) {
      points.splice(0, points.length, ...best.points); exclude = best.repair;
      repair = true;
    }
    try {
      const payload = await route(valhallaRequest(points, { avoidMotorways, exclude }), abort);
      const path = geometry(payload);
      last = path;
      const metrics = assess(path, payload.trip.summary.length, targetKm, center);
      diagnostics.push({ attempt: attempt + 1, ...metrics, excludedLocations: exclude.length });
      if (metrics.valid) return { ...payload, planner: { engine: 'valhalla', ...metrics, attempts: attempt + 1, elapsedMs: Date.now() - started } };
      if (!best || metrics.distanceErrorKm + metrics.repeatedKm * 3 < best.score) {
        best = { points, repair: repeatedLocations(splitSharedAccess(path).withoutReturn, center), score: metrics.distanceErrorKm + metrics.repeatedKm * 3 };
      }
      if (!repair && metrics.distanceKm > 0) scale *= Math.max(0.65, Math.min(1.35, targetKm / metrics.distanceKm));
    } catch (error) {
      diagnostics.push({ attempt: attempt + 1, code: error.code || 'ENGINE_ERROR', message: error.message });
      if (error.code === 'ENGINE_UNAVAILABLE' || error.code === 'ENGINE_RESPONSE') break;
    }
  }
  const routed = diagnostics.filter(row => row.distanceKm !== undefined);
  const code = !routed.length ? (diagnostics.at(-1)?.code || 'SEARCH_TIMEOUT') : abort.aborted ? 'SEARCH_TIMEOUT' : 'NO_MATCH';
  throw new RoutingError(code, !routed.length ? 'The routing engine could not calculate a route in this map region.'
    : 'No loop meeting the distance and shared-access limits was found within the search budget. Try a nearby starting road.',
  !routed.length ? 503 : 422, { elapsedMs: Date.now() - started, attempts: diagnostics });
}
