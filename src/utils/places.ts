import type { Coordinate } from '@/types';

export type PlaceSuggestion = Coordinate & { id: string; name: string; address: string };

const object = (value: unknown): Record<string, unknown> => value != null && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function parsePlaceSuggestions(payload: unknown): PlaceSuggestion[] {
  const features = object(payload).features;
  if (!Array.isArray(features)) throw new Error('Invalid place search response.');
  const places = new Map<string, PlaceSuggestion>();
  for (const feature of features) {
    const geometry = object(object(feature).geometry);
    const properties = object(object(feature).properties);
    const coordinates = geometry.coordinates;
    if (geometry.type !== 'Point' || !Array.isArray(coordinates)) continue;
    const [longitude, latitude] = coordinates;
    if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    const street = [text(properties.housenumber), text(properties.street)].filter(Boolean).join(' ');
    const name = text(properties.name) || street || text(properties.city) || text(properties.postcode);
    if (!name) continue;
    const address = [...new Set([street, text(properties.district), text(properties.city), text(properties.state), text(properties.postcode), text(properties.country)])]
      .filter((part) => part && part !== name).join(', ');
    const id = `${text(properties.osm_type)}:${properties.osm_id ?? name}:${longitude}:${latitude}`;
    places.set(id, { id, name, address, latitude, longitude });
  }
  return [...places.values()].slice(0, 8);
}

export async function fetchPlaceSuggestions(query: string, center: Coordinate, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  if (query.trim().length < 2) return [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 8000);
  try {
    // Photon supports search-as-you-type; the public Nominatim API does not.
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', query.trim().slice(0, 120));
    url.searchParams.set('limit', '8');
    url.searchParams.set('lang', 'en');
    if (Number.isFinite(center.latitude) && Number.isFinite(center.longitude)) {
      url.searchParams.set('lat', center.latitude.toFixed(2));
      url.searchParams.set('lon', center.longitude.toFixed(2));
    }
    const response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) throw new Error(`Place search returned ${response.status}.`);
    return parsePlaceSuggestions(await response.json());
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
