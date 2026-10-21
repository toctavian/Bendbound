import type { Coordinate } from '@/types';
import { distanceBetween, routeDistance } from '@/utils/routes';

export function projectToRoad(line: Coordinate[], point: Coordinate, hint = -1, heading?: number) {
  const lonScale = Math.cos(point.latitude * Math.PI / 180);
  let best: { point: Coordinate; index: number; distanceKm: number; score: number } | undefined;
  const start = hint < 0 ? 0 : Math.max(0, hint - 25);
  const end = hint < 0 ? line.length - 1 : Math.min(line.length - 1, hint + 200);
  for (let i = start; i < end; i++) {
    const a = line[i], b = line[i + 1];
    const x = (a.longitude - point.longitude) * lonScale, y = a.latitude - point.latitude;
    const dx = (b.longitude - a.longitude) * lonScale, dy = b.latitude - a.latitude;
    const length = dx * dx + dy * dy;
    if (length < 1e-16) continue;
    const fraction = Math.max(0, Math.min(1, -(x * dx + y * dy) / length));
    const projected = { latitude: a.latitude + (b.latitude - a.latitude) * fraction, longitude: a.longitude + (b.longitude - a.longitude) * fraction };
    const distanceKm = distanceBetween(point, projected);
    const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    const delta = heading === undefined ? 0 : Math.abs(((bearing - heading + 540) % 360) - 180);
    if (heading !== undefined && delta > 70) continue;
    const score = distanceKm + delta * 0.0001 + (hint < 0 ? 0 : Math.abs(i - hint) * 0.000001);
    if (!best || score < best.score) best = { point: projected, index: i, distanceKm, score };
  }
  return best;
}

export function movementPath(from: Coordinate, to: Coordinate, road: Coordinate[]): Coordinate[] {
  const a = projectToRoad(road, from), b = projectToRoad(road, to);
  if (!a || !b || a.distanceKm > 0.05 || b.distanceKm > 0.05 || Math.abs(a.index - b.index) > 120) return [from, to];
  const forward = a.index <= b.index;
  const between = forward ? road.slice(a.index + 1, b.index + 1) : road.slice(b.index + 1, a.index + 1).reverse();
  const path = [from, ...between, to];
  // Avoid following another lap of a loop or a distant branch at a crossing.
  return routeDistance(path) <= Math.max(0.05, distanceBetween(from, to) * 3) ? path : [from, to];
}
export function positionAlong(path: Coordinate[], fraction: number): Coordinate {
  if (fraction <= 0) return path[0];
  if (fraction >= 1) return path[path.length - 1];
  let remaining = routeDistance(path) * fraction;
  for (let i = 1; i < path.length; i++) {
    const km = distanceBetween(path[i - 1], path[i]);
    if (km > 0 && remaining <= km) {
      const t = remaining / km;
      return { latitude: path[i - 1].latitude + (path[i].latitude - path[i - 1].latitude) * t,
        longitude: path[i - 1].longitude + (path[i].longitude - path[i - 1].longitude) * t };
    }
    remaining -= km;
  }
  return path[path.length - 1];
}
export function interpolateHeading(from: number, to: number, fraction: number) {
  return ((from + (((to - from + 540) % 360) - 180) * fraction) % 360 + 360) % 360;
}

// Animate the visible recording endpoint along confirmed road geometry. Never
// join the matched trail to an unmatched GPS fix with a straight connector.
export function trailToRider(lines: Coordinate[][], point: Coordinate | undefined) {
  const last = lines[lines.length - 1];
  if (!point || !last?.length) return { lines, point };
  const projected = projectToRoad(last, point);
  const endpoint = projected && projected.distanceKm <= 0.05 ? projected.point : last[last.length - 1];
  const tail = projected && projected.distanceKm <= 0.05 ? [...last.slice(0, projected.index + 1), endpoint] : last;
  return { lines: [...lines.slice(0, -1), tail], point: endpoint };
}
