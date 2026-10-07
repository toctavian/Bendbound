import type { Coordinate, PoiCategory, PointOfInterest, RoutePointOfInterest } from '@/types';
import { requestOverpass, type OverpassElement } from '@/utils/pois';
import { distanceBetween } from '@/utils/routes';

const corridorKm = 0.25;
const maxHighlights = 24;

// Project onto the actual road segment, including between sparsely spaced vertices.
function project(point: Coordinate, start: Coordinate, end: Coordinate) {
  const scale = Math.cos(point.latitude * Math.PI / 180);
  const dx = (end.longitude - start.longitude) * scale;
  const dy = end.latitude - start.latitude;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared ? Math.max(0, Math.min(1,
    ((point.longitude - start.longitude) * scale * dx + (point.latitude - start.latitude) * dy) / lengthSquared,
  )) : 0;
  const coordinate = {
    latitude: start.latitude + (end.latitude - start.latitude) * fraction,
    longitude: start.longitude + (end.longitude - start.longitude) * fraction,
  };
  return { coordinate, fraction, distanceKm: distanceBetween(point, coordinate) };
}

function valid(point: Coordinate) {
  return Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
    && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

export function pointsAlongRoute(route: Coordinate[], pois: PointOfInterest[]): RoutePointOfInterest[] {
  if (route.length < 2 || !route.every(valid)) return [];
  const lengths = route.slice(1).map((point, index) => distanceBetween(route[index], point));
  const seen = new Set<string>();
  const matched: Omit<RoutePointOfInterest, 'number'>[] = [];
  for (const poi of pois) {
    if (!valid(poi) || seen.has(poi.id)) continue;
    seen.add(poi.id);
    let nearest: Omit<RoutePointOfInterest, 'number'> | undefined;
    let travelled = 0;
    const latitudeMargin = corridorKm / 110;
    const longitudeMargin = latitudeMargin / Math.max(0.01, Math.cos(poi.latitude * Math.PI / 180));
    for (let i = 0; i < lengths.length; i++) {
      const start = route[i], end = route[i + 1];
      if (poi.latitude >= Math.min(start.latitude, end.latitude) - latitudeMargin
        && poi.latitude <= Math.max(start.latitude, end.latitude) + latitudeMargin
        && poi.longitude >= Math.min(start.longitude, end.longitude) - longitudeMargin
        && poi.longitude <= Math.max(start.longitude, end.longitude) + longitudeMargin) {
        const match = project(poi, start, end);
        if (match.distanceKm <= corridorKm && (!nearest || match.distanceKm < nearest.distanceFromRouteKm)) {
          nearest = { ...poi, routePoint: match.coordinate, distanceFromRouteKm: match.distanceKm, distanceAlongKm: travelled + lengths[i] * match.fraction };
        }
      }
      travelled += lengths[i];
    }
    if (nearest) matched.push(nearest);
  }
  matched.sort((a, b) => a.distanceAlongKm - b.distanceAlongKm || a.id.localeCompare(b.id));
  // A named place can be mapped as both a node and a building/area.
  const unique = matched.filter((poi, index) => !matched.slice(0, index).some((other) =>
    poi.name.toLowerCase() === other.name.toLowerCase() && distanceBetween(poi, other) < 0.05));
  // Keep the preview legible and distribute highlights over the whole ride.
  const selected = unique.length <= maxHighlights ? unique
    : Array.from({ length: maxHighlights }, (_, index) => unique[Math.round(index * (unique.length - 1) / (maxHighlights - 1))]);
  return selected.map((poi, index) => ({ ...poi, number: index + 1 }));
}

export function parseRoutePois(elements: OverpassElement[]): PointOfInterest[] {
  return elements.flatMap((element) => {
    const tags = element.tags ?? {};
    const name = tags.name ?? tags.brand;
    const latitude = element.lat ?? element.center?.lat;
    const longitude = element.lon ?? element.center?.lon;
    if (!name || latitude == null || longitude == null || !valid({ latitude, longitude })) return [];
    const category: PoiCategory = tags.amenity === 'fuel' ? 'fuel'
      : tags.amenity === 'cafe' || tags.amenity === 'pub' ? 'meet'
        : tags.natural === 'saddle' || tags.mountain_pass === 'yes' ? 'pass'
          : tags.natural === 'wood' || tags.landuse === 'forest' || tags.leisure === 'nature_reserve' ? 'forest' : 'sight';
    const kind = tags.tourism ?? tags.amenity ?? tags.historic ?? tags.leisure ?? tags.natural ?? tags.landuse ?? 'Mountain pass';
    const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(' ');
    return [{ id: `${element.type}-${element.id}`, latitude, longitude, category, name,
      detail: [kind.replaceAll('_', ' '), address].filter(Boolean).join(' · ') }];
  });
}

// Simplify only the query corridor (100 m tolerance); matching and map pins
// always use the complete road geometry. The extra 100 m query radius covers bends.
export function routePoiQuery(route: Coordinate[]): string {
  if (route.length < 2 || !route.every(valid)) return '';
  const keep = new Set([0, route.length - 1]);
  const stack = [[0, route.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let furthest = -1;
    let maxDistance = 0.1;
    for (let i = start + 1; i < end; i++) {
      const distance = project(route[i], route[start], route[end]).distanceKm;
      if (distance > maxDistance) { maxDistance = distance; furthest = i; }
    }
    if (furthest !== -1) {
      keep.add(furthest);
      stack.push([start, furthest], [furthest, end]);
    }
  }
  const line = [...keep].sort((a, b) => a - b).map((index) => `${route[index].latitude.toFixed(6)},${route[index].longitude.toFixed(6)}`).join(',');
  const filters = ['["tourism"~"attraction|viewpoint"]', '["historic"]', '["amenity"~"fuel|cafe|pub"]',
    '["natural"~"saddle|wood"]', '["mountain_pass"="yes"]', '["leisure"="nature_reserve"]', '["landuse"="forest"]'];
  return `[out:json][timeout:8];(\n${filters.map((filter) => `nwr${filter}["name"](around:350,${line});`).join('\n')}\n);out center 1000;`;
}

export async function fetchRoutePois(route: Coordinate[], signal?: AbortSignal): Promise<RoutePointOfInterest[]> {
  const query = routePoiQuery(route);
  if (!query) return [];
  const payload = await requestOverpass(query, signal);
  return pointsAlongRoute(route, parseRoutePois(payload.elements ?? []));
}
