import { Coordinate, DraftRoute, NavigationManeuver, RoutingProfile, Tour, TripStop } from '@/types';

const earthRadiusKm = 6371;

export function distanceBetween(a: Coordinate, b: Coordinate) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function routeDistance(route: Coordinate[]) {
  return route.slice(1).reduce((total, point, index) => total + distanceBetween(route[index], point), 0);
}

export function pointAtBearing(center: Coordinate, distanceKm: number, bearingDeg: number): Coordinate {
  const bearing = (bearingDeg * Math.PI) / 180;
  const angular = distanceKm / earthRadiusKm;
  const lat = (center.latitude * Math.PI) / 180;
  const lon = (center.longitude * Math.PI) / 180;
  const nextLat = Math.asin(Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing));
  const nextLon = lon + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat), Math.cos(angular) - Math.sin(lat) * Math.sin(nextLat));
  return { latitude: (nextLat * 180) / Math.PI, longitude: (nextLon * 180) / Math.PI };
}

function scenicAnchors(anchors: Coordinate[], pois: Coordinate[], targetKm: number) {
  const used = new Set<number>();
  const maxDetourKm = Math.min(8, Math.max(2, targetKm * 0.035));

  return anchors.map((anchor) => {
    const match = pois
      .map((poi, index) => ({ index, poi, distance: distanceBetween(anchor, poi) }))
      .filter((candidate) => !used.has(candidate.index) && candidate.distance <= maxDetourKm)
      .sort((a, b) => a.distance - b.distance)[0];
    if (!match) return anchor;
    used.add(match.index);
    return match.poi;
  });
}

export function buildRoundTrip(
  center: Coordinate,
  targetKm: number,
  direction: number,
  profile: RoutingProfile,
  pois: Coordinate[] = [],
  variant = 0,
): DraftRoute {
  const depthKm = Math.max(0.5, targetKm / 3.5);
  const spread = (profile === 'twisty' ? 48 : profile === 'winding' ? 42 : 34) + variant * 10;
  const shoulderKm = depthKm * (variant ? 0.76 : 0.62);
  const anchors = scenicAnchors([
    pointAtBearing(center, shoulderKm, direction - spread),
    pointAtBearing(center, depthKm, direction),
    pointAtBearing(center, shoulderKm, direction + spread),
  ], pois, targetKm);
  const points = [center, ...anchors, center];
  const distanceKm = Math.round(routeDistance(points));
  return {
    title: `${distanceKm} km round trip`,
    route: points,
    distanceKm,
    durationMin: Math.round((distanceKm / (profile === 'fast' ? 64 : 49)) * 60),
    curves: Math.round(distanceKm * (profile === 'twisty' ? 1.05 : profile === 'winding' ? 0.75 : 0.35)),
    profile,
  };
}

export function buildPointToPoint(start: Coordinate, destination: Coordinate, profile: RoutingProfile, title: string): DraftRoute {
  return buildStandardTrip(start, [{ ...destination, id: `destination-${destination.latitude}-${destination.longitude}`, name: title }], profile);
}

export function tripStopLabel(index: number): string {
  let label = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + (value - 1) % 26) + label;
  }
  return label;
}

export function buildStandardTrip(start: Coordinate, stops: TripStop[], profile: RoutingProfile): DraftRoute {
  if (!stops.length) throw new Error('Add a destination before creating your route.');
  const route: Coordinate[] = [start, ...stops.map(({ latitude, longitude }) => ({ latitude, longitude }))];
  if (route.some((point) => !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
    || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180)) throw new Error('One of the stops has an invalid location.');
  const distanceKm = Math.max(1, Math.round(routeDistance(route)));
  return {
    title: stops.length === 1 ? stops[0].name : `${stops[stops.length - 1].name} via ${stops.length - 1} stop${stops.length > 2 ? 's' : ''}`,
    stops: stops.map((stop) => ({ ...stop })),
    route,
    distanceKm,
    durationMin: Math.round((distanceKm / (profile === 'fast' ? 68 : 50)) * 60),
    curves: Math.round(distanceKm * (profile === 'twisty' ? 0.95 : profile === 'winding' ? 0.68 : 0.28)),
    profile,
  };
}

type OsrmResponse = {
  code: string;
  routes?: {
    distance: number;
    duration: number;
    geometry: { coordinates: [number, number][] };
  }[];
};

type ValhallaResponse = {
  planner?: { valid?: boolean };
  trip?: {
    status: number;
    legs?: {
      shape: string;
      maneuvers?: {
        type: number;
        instruction: string;
        verbal_pre_transition_instruction?: string;
        street_names?: string[];
        begin_shape_index: number;
        end_shape_index: number;
        bearing_after?: number;
      }[];
    }[];
    summary?: { length: number; time: number };
  };
};

type RoadRoutingOptions = {
  stopAtWaypoints?: boolean;
  avoidMotorways?: boolean;
  heading?: number;
};

type RoadRoute = Pick<DraftRoute, 'route' | 'maneuvers' | 'distanceKm' | 'durationMin'> & {
  roadDistanceKm: number;
  roadDurationMin: number;
};

// Expo inlines this public URL at bundle time. It must never contain a secret.
function selfHostedRoutingUrl() {
  return process.env.EXPO_PUBLIC_ROUTING_URL?.trim().replace(/\/+$/, '');
}

async function requestSelfHosted(path: string, body: unknown, timeoutMs = 15000): Promise<ValhallaResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A shared pilot credential is extractable from the app, not user authentication.
    const token = process.env.EXPO_PUBLIC_ROUTING_TOKEN?.trim();
    const response = await fetch(`${selfHostedRoutingUrl()}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.message || `Routing service returned HTTP ${response.status}.`);
    return payload as ValhallaResponse;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('The routing service took too long. Please try again.');
    if (error instanceof TypeError) throw new Error('Cannot reach your routing service. Check its address and connection.');
    throw error;
  } finally { clearTimeout(timeout); }
}

function parseValhallaRoute(payload: ValhallaResponse): RoadRoute | null {
  if (payload?.trip?.status !== 0 || !Array.isArray(payload.trip.legs) || !payload.trip.legs.length || !payload.trip.summary) return null;
  if (!Number.isFinite(payload.trip.summary.length) || payload.trip.summary.length <= 0
    || !Number.isFinite(payload.trip.summary.time) || payload.trip.summary.time < 0) return null;
  const route: Coordinate[] = [];
  const maneuvers: NavigationManeuver[] = [];
  for (const leg of payload.trip.legs) {
    if (!leg || typeof leg.shape !== 'string' || (leg.maneuvers !== undefined && !Array.isArray(leg.maneuvers))) return null;
    const legRoute = decodePolyline(leg.shape);
    if (legRoute.length < 2 || (route.length && distanceBetween(route[route.length - 1], legRoute[0]) > 0.001)) return null;
    if (legRoute.some(point => !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90
      || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180)) return null;
    if (leg.maneuvers?.some(maneuver => !maneuver || !Number.isInteger(maneuver.type) || typeof maneuver.instruction !== 'string'
      || !Number.isInteger(maneuver.begin_shape_index) || !Number.isInteger(maneuver.end_shape_index)
      || maneuver.begin_shape_index < 0 || maneuver.end_shape_index < maneuver.begin_shape_index
      || maneuver.end_shape_index >= legRoute.length)) return null;
    const indexOffset = Math.max(0, route.length - 1);
    route.push(...(route.length ? legRoute.slice(1) : legRoute));
    maneuvers.push(...(leg.maneuvers ?? []).map((maneuver) => ({
      type: maneuver.type, instruction: maneuver.instruction,
      spokenInstruction: maneuver.verbal_pre_transition_instruction, streetName: maneuver.street_names?.[0],
      beginShapeIndex: maneuver.begin_shape_index + indexOffset, endShapeIndex: maneuver.end_shape_index + indexOffset,
      bearingAfter: maneuver.bearing_after,
    })));
  }
  return { route, maneuvers, roadDistanceKm: payload.trip.summary.length, roadDurationMin: payload.trip.summary.time / 60,
    distanceKm: Math.max(1, Math.round(payload.trip.summary.length)), durationMin: Math.max(1, Math.round(payload.trip.summary.time / 60)) };
}

function decodePolyline(encoded: string, precision = 6): Coordinate[] {
  const coordinates: Coordinate[] = [];
  const factor = 10 ** precision;
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  const component = (): number | null => {
    let result = 0;
    for (let shift = 0; shift <= 30 && index < encoded.length; shift += 5) {
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63 || (shift === 30 && byte > 3)) return null;
      result |= (byte & 0x1f) << shift;
      if (byte < 32) return result & 1 ? ~(result >>> 1) : result >>> 1;
    }
    return null;
  };
  while (index < encoded.length) {
    const latDelta = component(), lonDelta = component();
    if (latDelta === null || lonDelta === null) return [];
    latitude += latDelta;
    longitude += lonDelta;
    coordinates.push({ latitude: latitude / factor, longitude: longitude / factor });
  }

  return coordinates;
}

async function routeWithValhalla(waypoints: Coordinate[], profile: RoutingProfile, options: RoadRoutingOptions): Promise<RoadRoute | null> {
  const locations = waypoints.map((point, index) => ({
    lat: point.latitude,
    lon: point.longitude,
    type: options.stopAtWaypoints || index === 0 || index === waypoints.length - 1 ? 'break' : 'through',
    search_cutoff: selfHostedRoutingUrl() ? 200 : index === 0 || index === waypoints.length - 1 ? 35000 : 5000,
    ...(index === 0 && options.heading != null ? { heading: options.heading, heading_tolerance: 45 } : {}),
  }));
  const useHighways = options.avoidMotorways === false ? 0.75 : 0.05;
  const request = {
    locations,
    costing: 'motorcycle',
    costing_options: {
      motorcycle: {
        use_highways: useHighways,
        use_tolls: options.avoidMotorways === false ? 0.5 : 0.2,
        use_trails: profile === 'twisty' ? 0.1 : 0,
        ...(selfHostedRoutingUrl() ? { exclude_highways: options.avoidMotorways !== false, use_trails: 0 } : {}),
      },
    },
    shape_format: 'polyline6',
    directions_options: { units: 'kilometers' },
  };
  if (selfHostedRoutingUrl()) {
    const result = parseValhallaRoute(await requestSelfHosted('route', request));
    if (!result) throw new Error('Your routing service returned an invalid road route.');
    return result;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(
      `https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(request))}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as ValhallaResponse;
    return parseValhallaRoute(payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function routeWithOsrm(waypoints: Coordinate[], stopAtWaypoints = false): Promise<RoadRoute | null> {
  const coordinates = waypoints.map((point) => `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`).join(';');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false&continue_straight=${!stopAtWaypoints}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as OsrmResponse;
    const result = payload.routes?.[0];
    if (payload.code !== 'Ok' || !result?.geometry.coordinates.length) return null;
    return {
      route: result.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })),
      roadDistanceKm: result.distance / 1000,
      roadDurationMin: result.duration / 60,
      distanceKm: Math.max(1, Math.round(result.distance / 1000)),
      durationMin: Math.max(1, Math.round(result.duration / 60)),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function snapDraftToRoads(draft: DraftRoute, options: RoadRoutingOptions = {}): Promise<DraftRoute & { roadDistanceKm?: number }> {
  const waypoints = draft.stops?.length ? [draft.route[0], ...draft.stops] : draft.route.slice(0, 10);
  if (waypoints.length < 2) return draft;
  const route: Coordinate[] = [];
  const maneuvers: NavigationManeuver[] = [];
  let roadDistanceKm = 0;
  let roadDurationMin = 0;
  let completeGuidance = true;
  // Limit request size, not itinerary size. Adjacent requests share a stop.
  // Only publish the complete itinerary after every section succeeds.
  for (let offset = 0; offset < waypoints.length - 1; offset += 9) {
    const section = waypoints.slice(offset, offset + 10);
    const motorcycleRoute = await routeWithValhalla(section, draft.profile, {
      ...options, heading: offset === 0 ? options.heading : undefined, stopAtWaypoints: !!draft.stops?.length,
    });
    const routed = motorcycleRoute ?? (options.avoidMotorways === false ? await routeWithOsrm(section, !!draft.stops?.length) : null);
    if (!routed) throw new Error('A road-following route could not be calculated. Check your connection and try again.');
    const previousEnd = route[route.length - 1];
    const nextStart = routed.route[0];
    if (previousEnd && distanceBetween(previousEnd, nextStart) > 0.001) {
      throw new Error(`Road sections could not be joined at stop ${tripStopLabel(offset - 1)}. Try adjusting that stop.`);
    }
    const duplicate = previousEnd && previousEnd.latitude === nextStart.latitude && previousEnd.longitude === nextStart.longitude;
    const indexOffset = route.length - (duplicate ? 1 : 0);
    for (let i = duplicate ? 1 : 0; i < routed.route.length; i++) route.push(routed.route[i]);
    if (!routed.maneuvers) completeGuidance = false;
    for (const maneuver of routed.maneuvers ?? []) maneuvers.push({
      ...maneuver, beginShapeIndex: maneuver.beginShapeIndex + indexOffset, endShapeIndex: maneuver.endShapeIndex + indexOffset,
    });
    roadDistanceKm += routed.roadDistanceKm;
    roadDurationMin += routed.roadDurationMin;
  }
  return { ...draft, route, maneuvers: completeGuidance ? maneuvers : undefined, roadDistanceKm,
    distanceKm: Math.max(1, Math.round(roadDistanceKm)), durationMin: Math.max(1, Math.round(roadDurationMin)) };
}

type RoadPoint = { x: number; y: number };
type RoadSegment = { start: RoadPoint; end: RoadPoint; length: number };
const overlapToleranceMetres = 0.5;
const roadCellMetres = 100;

// Walk only cells along the line, rather than every cell in its bounding box.
function roadCells(segment: RoadSegment): [number, number][] {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / roadCellMetres));
  const cells: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const cell: [number, number] = [
      Math.floor((segment.start.x + dx * i / steps) / roadCellMetres),
      Math.floor((segment.start.y + dy * i / steps) / roadCellMetres),
    ];
    const last = cells[cells.length - 1];
    if (!last || last[0] !== cell[0] || last[1] !== cell[1]) cells.push(cell);
  }
  return cells;
}

function sharedRoadInterval(current: RoadSegment, previous: RoadSegment): [number, number] | null {
  const ux = (current.end.x - current.start.x) / current.length;
  const uy = (current.end.y - current.start.y) / current.length;
  const vx = (previous.end.x - previous.start.x) / previous.length;
  const vy = (previous.end.y - previous.start.y) / previous.length;
  // A crossing is not road reuse. Allow only near-collinear overlap, in either direction.
  if (Math.abs(ux * vy - uy * vx) > 0.01) return null;
  const ax = previous.start.x - current.start.x;
  const ay = previous.start.y - current.start.y;
  const bx = previous.end.x - current.start.x;
  const by = previous.end.y - current.start.y;
  const from = ax * ux + ay * uy;
  const to = bx * ux + by * uy;
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(current.length, Math.max(from, to));
  if (end - start <= 0.01) return null;
  const offsetStart = ax * -uy + ay * ux;
  const offsetEnd = bx * -uy + by * ux;
  const offsetAt = (distance: number) => offsetStart + (offsetEnd - offsetStart) * (distance - from) / (to - from);
  if (Math.abs(offsetAt(start)) > overlapToleranceMetres || Math.abs(offsetAt(end)) > overlapToleranceMetres) return null;
  return [start, end];
}

/** Detect reused road sections even when a waypoint splits an edge differently.
 * Opposite directions count as reuse; sharing a junction or the loop endpoint does not.
 * Half-metre tolerance accommodates polyline rounding without conflating nearby roads.
 */
export function repeatedRoadRatio(route: Coordinate[]) {
  if (route.length < 2) return 0;
  const origin = route[0];
  const metresPerDegree = earthRadiusKm * 1000 * Math.PI / 180;
  const longitudeScale = Math.cos(origin.latitude * Math.PI / 180);
  const points = route.map((point) => ({
    x: (point.longitude - origin.longitude) * metresPerDegree * longitudeScale,
    y: (point.latitude - origin.latitude) * metresPerDegree,
  }));
  const cells = new Map<string, number[]>();
  const segments: RoadSegment[] = [];
  let total = 0;
  let repeated = 0;
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length <= 0.01) continue;
    const segment = { start, end, length };
    const occupied = roadCells(segment);
    const candidates = new Set<number>();
    for (const [x, y] of occupied) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const index of cells.get(`${x + dx},${y + dy}`) ?? []) candidates.add(index);
      }
    }
    const overlaps = [...candidates].map((index) => sharedRoadInterval(segment, segments[index]))
      .filter((interval): interval is [number, number] => interval !== null).sort((a, b) => a[0] - b[0]);
    let coveredUntil = 0;
    for (const [from, to] of overlaps) {
      repeated += Math.max(0, to - Math.max(from, coveredUntil));
      coveredUntil = Math.max(coveredUntil, to);
    }
    total += length;
    const index = segments.push(segment) - 1;
    for (const [x, y] of occupied) {
      const key = `${x},${y}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(index);
      else cells.set(key, [index]);
    }
  }
  return total ? repeated / total : 0;
}

// Match departure against the reversed arrival, walking both polylines so
// different vertex sampling does not change the access-road allowance.
export function splitSharedAccess(route: Coordinate[]) {
  let left = 0, right = route.length - 1;
  let outward = route[0], inward = route[right];
  let accessKm = 0;
  const interpolate = (a: Coordinate, b: Coordinate, fraction: number): Coordinate => ({
    latitude: a.latitude + (b.latitude - a.latitude) * fraction,
    longitude: a.longitude + (b.longitude - a.longitude) * fraction,
  });
  while (left + 1 < right && distanceBetween(outward, inward) <= 0.0005) {
    const outKm = distanceBetween(outward, route[left + 1]);
    const inKm = distanceBetween(inward, route[right - 1]);
    if (outKm < 0.00001) { outward = route[++left]; continue; }
    if (inKm < 0.00001) { inward = route[--right]; continue; }
    const step = Math.min(outKm, inKm);
    const nextOut = interpolate(outward, route[left + 1], step / outKm);
    const nextIn = interpolate(inward, route[right - 1], step / inKm);
    if (distanceBetween(nextOut, nextIn) > 0.0005) break;
    accessKm += step;
    outward = nextOut; inward = nextIn;
    if (outKm <= inKm) outward = route[++left];
    if (inKm <= outKm) inward = route[--right];
  }
  if (!accessKm) return { accessKm: 0, outbound: [], loop: route, returning: [], withoutReturn: route };
  const outbound = route.slice(0, left + 1);
  if (distanceBetween(outbound[outbound.length - 1], outward) > 0.00000001) outbound.push(outward);
  const returning = route.slice(right);
  if (distanceBetween(inward, returning[0]) > 0.00000001) returning.unshift(inward);
  return {
    accessKm,
    outbound,
    loop: [outward, ...route.slice(left + 1, right), inward],
    returning,
    // Keep the outbound access: this also detects a loop that reuses it again.
    withoutReturn: [...route.slice(0, right), inward],
  };
}

export function roundTripRoadUse(route: Coordinate[]) {
  const split = splitSharedAccess(route);
  const remainingRepeatedRatio = repeatedRoadRatio(split.withoutReturn);
  const limitKm = Math.min(0.5, routeDistance(route) * 0.05);
  return {
    valid: route.length > 2 && split.accessKm <= limitKm && remainingRepeatedRatio === 0,
    sharedAccessKm: split.accessKm,
    remainingRepeatedRatio,
  };
}

export async function calculateRoundTrip(
  center: Coordinate,
  targetKm: number,
  direction: number,
  profile: RoutingProfile,
  pois: Coordinate[] = [],
  options: RoadRoutingOptions = {},
): Promise<DraftRoute> {
  if (!Number.isFinite(targetKm) || targetKm <= 0) throw new Error('Choose a positive round-trip distance.');
  if (selfHostedRoutingUrl()) {
    const payload = await requestSelfHosted('round-trip', {
      center, targetKm, direction, profile, avoidMotorways: options.avoidMotorways !== false,
    }, 35000);
    // The server owns distance, overlap, closure and start-snapping policy.
    // Require its acceptance and usable navigation data, without reapplying rules.
    const routed = parseValhallaRoute(payload);
    if (payload?.planner?.valid !== true || !routed) {
      throw new Error('The routing service returned an invalid round-trip response. Please try again.');
    }
    return { ...routed, profile, curves: Math.round(routed.distanceKm * (profile === 'twisty' ? 1.05 : profile === 'winding' ? 0.75 : 0.35)),
      roundTrip: true, title: `${routed.distanceKm} km round trip` };
  }
  // Broaden and rotate the loop; omit scenic stops on later attempts because a
  // scenic stop on a dead-end road would force an out-and-back section.
  const attempts = [
    { rotation: 0, variant: 0, scenic: true },
    { rotation: 0, variant: 1, scenic: true },
    { rotation: -25, variant: 1, scenic: false },
    { rotation: 25, variant: 1, scenic: false },
    { rotation: -45, variant: 2, scenic: false },
    { rotation: 45, variant: 2, scenic: false },
  ];
  let routedAny = false;
  let lastError: unknown;
  let loopSizeKm = targetKm;
  for (const attempt of attempts) {
    try {
      // Once resizing, avoid snapping back to scenic stops at the old radius.
      const stops = attempt.scenic && loopSizeKm === targetKm ? pois : [];
      const draft = buildRoundTrip(center, loopSizeKm, direction + attempt.rotation, profile, stops, attempt.variant);
      const routed = await snapDraftToRoads(draft, { ...options, heading: direction });
      routedAny = true;
      // Use the provider's unrounded road length, not the waypoint estimate or
      // the whole-kilometre value used for display. Exactly +/-10 km is excluded.
      const actualKm = routed.roadDistanceKm;
      if (actualKm === undefined || !Number.isFinite(actualKm) || actualKm <= 0) continue;
      if (Math.abs(actualKm - targetKm) >= 10) {
        // Bound each adjustment so one unusually long detour cannot collapse
        // the next loop. Road distance is measured again on every attempt.
        loopSizeKm *= Math.max(0.5, Math.min(1.5, targetKm / actualKm));
        continue;
      }
      if (roundTripRoadUse(routed.route).valid) return { ...routed, roundTrip: true, title: `${routed.distanceKm} km round trip` };
    } catch (error) {
      lastError = error;
    }
  }
  if (!routedAny && lastError instanceof Error) throw lastError;
  throw new Error(`No round trip within 10 km of ${targetKm} km without repeated road sections outside the short start/finish access could be found. Try another direction, distance, or starting point.`);
}

export function tourFromDraft(draft: DraftRoute): Tour {
  return {
    stops: draft.stops?.map((stop) => ({ ...stop })),
    roundTrip: draft.roundTrip,
    id: `tour-${Date.now()}`,
    title: draft.title,
    place: 'Created in Bendbound',
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    distanceKm: draft.distanceKm,
    durationMin: draft.durationMin,
    curves: draft.curves,
    elevationM: Math.round(draft.distanceKm * 8.2),
    author: 'Octavian',
    saved: true,
    completed: false,
    route: draft.route,
    maneuvers: draft.maneuvers,
  };
}

export function formatDuration(minutes: number) {
  const roundedMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(roundedMinutes / 60);
  const remainder = roundedMinutes % 60;
  return hours ? `${hours} h ${remainder.toString().padStart(2, '0')} min` : `${remainder} min`;
}

export function toGpx(tour: Tour) {
  if (tour.completed && !tour.recording) throw new Error('The GPS track for this older ride was not stored.');
  const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const segments = tour.recording?.segments ?? [tour.route];
  const tracks = segments.map((segment) => {
    const points = segment.map((point) => {
      const time = 'timestamp' in point && typeof point.timestamp === 'number' ? `<time>${new Date(point.timestamp).toISOString()}</time>` : '';
      return `    <trkpt lat="${point.latitude}" lon="${point.longitude}">${time}</trkpt>`;
    }).join('\n');
    return `  <trkseg>\n${points}\n  </trkseg>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Bendbound" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${escapeXml(tour.title)}</name>\n${tracks}\n  </trk>\n</gpx>`;
}

export function fromGpx(contents: string): Coordinate[] {
  const points: Coordinate[] = [];
  const regex = /<(?:trkpt|rtept)[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*>/gi;
  let match = regex.exec(contents);
  while (match) {
    points.push({ latitude: Number(match[1]), longitude: Number(match[2]) });
    match = regex.exec(contents);
  }
  return points.filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}
