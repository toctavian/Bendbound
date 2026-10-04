import { Coordinate, DraftRoute, NavigationManeuver, RoutingProfile, Tour } from '@/types';

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
  const depthKm = Math.max(10, targetKm / 3.5);
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
  const route: Coordinate[] = [start, destination];
  const distanceKm = Math.max(1, Math.round(routeDistance(route)));
  return {
    title,
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
  avoidMotorways?: boolean;
  heading?: number;
};

function decodePolyline(encoded: string, precision = 6): Coordinate[] {
  const coordinates: Coordinate[] = [];
  const factor = 10 ** precision;
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push({ latitude: latitude / factor, longitude: longitude / factor });
  }

  return coordinates;
}

async function routeWithValhalla(waypoints: Coordinate[], profile: RoutingProfile, options: RoadRoutingOptions) {
  const locations = waypoints.map((point, index) => ({
    lat: point.latitude,
    lon: point.longitude,
    type: index === 0 || index === waypoints.length - 1 ? 'break' : 'through',
    search_cutoff: index === 0 || index === waypoints.length - 1 ? 35000 : 5000,
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
      },
    },
    shape_format: 'polyline6',
    directions_options: { units: 'kilometers' },
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(
      `https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(request))}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as ValhallaResponse;
    if (payload.trip?.status !== 0 || !payload.trip.legs?.length || !payload.trip.summary) return null;
    const route: Coordinate[] = [];
    const maneuvers: NavigationManeuver[] = [];
    payload.trip.legs.forEach((leg) => {
      const legRoute = decodePolyline(leg.shape);
      const indexOffset = Math.max(0, route.length - 1);
      route.push(...(route.length ? legRoute.slice(1) : legRoute));
      maneuvers.push(...(leg.maneuvers ?? []).map((maneuver) => ({
        type: maneuver.type,
        instruction: maneuver.instruction,
        spokenInstruction: maneuver.verbal_pre_transition_instruction,
        streetName: maneuver.street_names?.[0],
        beginShapeIndex: maneuver.begin_shape_index + indexOffset,
        endShapeIndex: maneuver.end_shape_index + indexOffset,
        bearingAfter: maneuver.bearing_after,
      })));
    });
    if (route.length < 2) return null;
    return {
      route,
      maneuvers,
      distanceKm: Math.max(1, Math.round(payload.trip.summary.length)),
      durationMin: Math.max(1, Math.round(payload.trip.summary.time / 60)),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function routeWithOsrm(waypoints: Coordinate[]) {
  const coordinates = waypoints.map((point) => `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`).join(';');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false&continue_straight=true`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as OsrmResponse;
    const result = payload.routes?.[0];
    if (payload.code !== 'Ok' || !result?.geometry.coordinates.length) return null;
    return {
      route: result.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })),
      distanceKm: Math.max(1, Math.round(result.distance / 1000)),
      durationMin: Math.max(1, Math.round(result.duration / 60)),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function snapDraftToRoads(draft: DraftRoute, options: RoadRoutingOptions = {}): Promise<DraftRoute> {
  const waypoints = draft.route.slice(0, 10);
  if (waypoints.length < 2) return draft;
  const motorcycleRoute = await routeWithValhalla(waypoints, draft.profile, options);
  const routed = motorcycleRoute ?? (options.avoidMotorways === false ? await routeWithOsrm(waypoints) : null);
  if (!routed) throw new Error('A road-following route could not be calculated. Check your connection and try again.');
  return { ...draft, ...routed };
}

export function repeatedRoadRatio(route: Coordinate[]) {
  const visited = new Set<string>();
  let totalKm = 0;
  let repeatedKm = 0;

  route.slice(1).forEach((point, index) => {
    const previous = route[index];
    const distanceKm = distanceBetween(previous, point);
    if (distanceKm <= 0) return;
    const from = `${previous.latitude.toFixed(5)},${previous.longitude.toFixed(5)}`;
    const to = `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    totalKm += distanceKm;
    if (visited.has(key)) repeatedKm += distanceKm;
    visited.add(key);
  });

  return totalKm ? repeatedKm / totalKm : 0;
}

export function tourFromDraft(draft: DraftRoute): Tour {
  return {
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
