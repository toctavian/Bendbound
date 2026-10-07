import { decodePolyline, distanceBetween, repeatedRoadRatio, roundTripRoadUse, routeDistance } from './geometry.mjs';

export class RoutingError extends Error {
  constructor(code, message, status = 422, diagnostics) {
    super(message); Object.assign(this, { code, status, diagnostics });
  }
}
export async function engineJSON(base, path, body, signal) {
  let response;
  try {
    response = await fetch(`${base.replace(/\/$/, '')}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new RoutingError('ENGINE_UNAVAILABLE', `Routing engine unavailable: ${error.name}`, 503);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new RoutingError('ENGINE_RESPONSE', 'Routing engine returned an invalid response.', 502); }
  if (!response.ok) throw new RoutingError('ENGINE_ROUTE', payload.error || payload.message || `Engine HTTP ${response.status}`, 422);
  return payload;
}
export function valhallaRequest(points, { avoidMotorways = true, heading, stopAtWaypoints = false, exclude = [] } = {}) {
  return {
    locations: points.map((p, i) => ({ lat: p.latitude, lon: p.longitude,
      type: stopAtWaypoints || i === 0 || i === points.length - 1 ? 'break' : 'through',
      search_cutoff: i === 0 || i === points.length - 1 ? 200 : 2000,
      ...(i === 0 && heading !== undefined ? { heading, heading_tolerance: 90 } : {}),
    })),
    costing: 'motorcycle',
    costing_options: { motorcycle: { use_highways: avoidMotorways ? 0 : 0.75, exclude_highways: avoidMotorways,
      use_trails: 0, use_ferry: 0, exclude_ferries: true } },
    exclude_locations: exclude.map(p => ({ lat: p.latitude, lon: p.longitude })),
    shape_format: 'polyline6', directions_options: { units: 'kilometers', language: 'en-GB' },
  };
}
export function geometry(payload) {
  const legs = payload.trip?.legs;
  if (payload.trip?.status !== 0 || !legs?.length || !Number.isFinite(payload.trip?.summary?.length)) {
    throw new RoutingError('ENGINE_RESPONSE', 'Valhalla returned no usable road route.', 502);
  }
  const result = [];
  for (const leg of legs) {
    const points = decodePolyline(leg.shape);
    if (result.length && distanceBetween(result.at(-1), points[0]) > 0.001) throw new RoutingError('DISCONNECTED', 'Route legs do not connect.');
    result.push(...(result.length ? points.slice(1) : points));
  }
  if (result.length < 3) throw new RoutingError('ENGINE_RESPONSE', 'Route geometry is empty.', 502);
  return result;
}
export function assess(points, km, targetKm, start) {
  const overlap = repeatedRoadRatio(points);
  const roadUse = roundTripRoadUse(points);
  const distanceErrorKm = Math.abs(km - targetKm);
  const closed = points.length > 2 && distanceBetween(points[0], points.at(-1)) < 0.02;
  const nearStart = closed && distanceBetween(start, points[0]) <= 0.2;
  return { valid: Number.isFinite(km) && km > 0 && distanceErrorKm < 10 && roadUse.valid && nearStart,
    distanceKm: km, distanceErrorKm, overlapRatio: overlap,
    repeatedKm: overlap * routeDistance(points), sharedAccessKm: roadUse.sharedAccessKm,
    remainingRepeatedRatio: roadUse.remainingRepeatedRatio, closed, nearStart };
}
