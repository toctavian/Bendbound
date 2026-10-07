import type { Coordinate, NavigationManeuver } from '@/types';

type XY = [number, number];
type Turn = { index: number; distance: number };
export type ArrowRoute = { points: XY[]; distances: number[]; turns: Turn[] };
const earthRadius = 6378137;
const radians = Math.PI / 180;
const turnTypes = new Set([9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 23, 24, 25, 26, 27, 37, 38]);
const length = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const project = ({ latitude, longitude }: Coordinate): XY => [
  earthRadius * longitude * radians,
  earthRadius * Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, latitude)) * radians / 2)),
];
const unproject = ([x, y]: XY): XY => [x / earthRadius / radians, (2 * Math.atan(Math.exp(y / earthRadius)) - Math.PI / 2) / radians];

// Interpolate ON the polyline, never across the chord between two road segments.
function sample(route: ArrowRoute, distance: number): { point: XY; segment: number } {
  let low = 1;
  let high = route.distances.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (route.distances[middle] < distance) low = middle + 1;
    else high = middle;
  }
  while (low < route.points.length - 1 && route.distances[low] === route.distances[low - 1]) low++;
  const a = route.points[low - 1];
  const b = route.points[low];
  const span = route.distances[low] - route.distances[low - 1];
  const ratio = span > 0 ? Math.max(0, Math.min(1, (distance - route.distances[low - 1]) / span)) : 0;
  return { point: [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio], segment: low };
}

function turnAngle(route: ArrowRoute, index: number, reach: number) {
  const center = route.points[index];
  const before = sample(route, route.distances[index] - reach).point;
  const after = sample(route, route.distances[index] + reach).point;
  const a: XY = [center[0] - before[0], center[1] - before[1]];
  const b: XY = [after[0] - center[0], after[1] - center[1]];
  if (Math.hypot(...a) < 0.1 || Math.hypot(...b) < 0.1) return 0;
  return Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) / radians);
}

export function prepareArrowRoute(coordinates: Coordinate[], maneuvers?: NavigationManeuver[]): ArrowRoute {
  const route: ArrowRoute = { points: coordinates.map(project), distances: [0], turns: [] };
  for (let i = 1; i < route.points.length; i++) route.distances.push(route.distances[i - 1] + length(route.points[i - 1], route.points[i]));
  if (coordinates.length < 3) return route;
  // Valhalla's 'becomes', 'continue', starts and arrivals are deliberately excluded.
  // Routes imported without instructions use geometry as a fallback.
  const candidates = maneuvers?.length
    ? maneuvers.filter((maneuver) => turnTypes.has(maneuver.type)).map((maneuver) => maneuver.beginShapeIndex)
    : coordinates.map((_, index) => index);
  for (const index of [...new Set(candidates)].sort((a, b) => a - b)) {
    if (!Number.isInteger(index) || index < 1 || index >= coordinates.length - 1) continue;
    const metresScale = 1 / Math.cos(coordinates[index].latitude * radians);
    const angle = turnAngle(route, index, 15 * metresScale);
    if (angle < (maneuvers?.length ? 15 : 35)) continue;
    const previous = route.turns.at(-1);
    if (!maneuvers?.length && previous && route.distances[index] - previous.distance < 25 * metresScale) {
      // Pick the strongest bend in a cluster of sampled curve vertices.
      if (angle > turnAngle(route, previous.index, 15 * metresScale)) route.turns[route.turns.length - 1] = { index, distance: route.distances[index] };
    } else route.turns.push({ index, distance: route.distances[index] });
  }
  return route;
}

function section(route: ArrowRoute, start: number, end: number): XY[] {
  const first = sample(route, start);
  const last = sample(route, end);
  const points = [first.point];
  for (let i = first.segment; i < last.segment; i++) {
    if (length(points[points.length - 1], route.points[i]) > 0.001) points.push(route.points[i]);
  }
  if (length(points[points.length - 1], last.point) > 0.001) points.push(last.point);
  return points;
}

/** Ground-aligned geometry uses the same MapLibre projection as the route.
 * Shaft widths are 20% larger than a 6px arrow; heads are 19.2px across.
 * No icon rotation or bearing from the routing provider is used.
 */
export function routeArrowFeatures(route: ArrowRoute, zoom: number, progressIndex = 0): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (route.points.length < 3 || zoom < 15 || !Number.isFinite(zoom)) return { type: 'FeatureCollection', features };
  const unit = 2 * Math.PI * earthRadius / (512 * 2 ** zoom);
  const total = route.distances[route.distances.length - 1];
  route.turns.forEach((turn, ordinal) => {
    if (turn.index < progressIndex) return;
    const previous = route.turns[ordinal - 1]?.distance ?? 0;
    const next = route.turns[ordinal + 1]?.distance ?? total;
    const start = Math.max(0, turn.distance - 24 * unit, (previous + turn.distance) / 2 + 2 * unit);
    const end = Math.min(total, turn.distance + 32 * unit, (turn.distance + next) / 2 - 2 * unit);
    if (end - turn.distance < 10 * unit || turn.distance - start < 5 * unit) return;
    const tip = sample(route, end);
    // Head direction is the FINAL segment tangent, not a chord across a bend.
    const segmentStart = route.points[tip.segment - 1];
    const segmentLength = length(segmentStart, tip.point);
    if (segmentLength < 0.001) return;
    const direction: XY = [(tip.point[0] - segmentStart[0]) / segmentLength, (tip.point[1] - segmentStart[1]) / segmentLength];
    const headLength = Math.min(16.8 * unit, (end - turn.distance) * 0.8);
    if (headLength < 4 * unit) return;
    const headWidth = Math.min(9.6 * unit, headLength * 0.75);
    const offset = (along: number, across: number): XY => [
      tip.point[0] - direction[0] * along - direction[1] * across,
      tip.point[1] - direction[1] * along + direction[0] * across,
    ];
    const head = (inset: number): XY[] => {
      const points = [offset(inset, 0), offset(headLength, headWidth - inset), offset(headLength, -headWidth + inset)];
      return [...points, points[0]].map(unproject);
    };
    // Extend the shaft slightly inside the head so the joint has no red seam.
    const shaft = section(route, start, end - headLength * 0.65).map(unproject);
    features.push(
      { type: 'Feature', properties: { part: 'shaft', turn: turn.index }, geometry: { type: 'LineString', coordinates: shaft } },
      { type: 'Feature', properties: { part: 'head-outline', turn: turn.index }, geometry: { type: 'Polygon', coordinates: [head(0)] } },
      { type: 'Feature', properties: { part: 'head', turn: turn.index }, geometry: { type: 'Polygon', coordinates: [head(1.5 * unit)] } },
    );
  });
  return { type: 'FeatureCollection', features };
}
