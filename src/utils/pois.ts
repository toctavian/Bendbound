import { Coordinate, PoiCategory, PointOfInterest } from '@/types';

export type OverpassElement = {
  id: number;
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
};

type OverpassResponse = { elements?: OverpassElement[]; remark?: string };

const overpassEndpoints = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const filters: Record<PoiCategory, string[]> = {
  fuel: ['["amenity"="fuel"]'],
  pass: ['["natural"="saddle"]', '["mountain_pass"="yes"]'],
  meet: ['["amenity"~"cafe|pub|restaurant"]["name"~"Ace Caf|Squires|Loomies",i]'],
  sight: ['["tourism"~"attraction|viewpoint"]', '["historic"]'],
  forest: ['["natural"="wood"]["name"]', '["landuse"="forest"]["name"]'],
};

const categoryNames: Record<PoiCategory, string> = {
  fuel: 'Fuel station',
  pass: 'Mountain pass',
  meet: 'Established biker meeting spot',
  sight: 'Sightseeing highlight',
  forest: 'Forest road',
};

const searchRadii: Record<PoiCategory, number> = {
  fuel: 15000,
  pass: 35000,
  meet: 60000,
  sight: 8000,
  forest: 10000,
};

export async function requestOverpass(query: string, signal?: AbortSignal): Promise<OverpassResponse> {
  let lastError: unknown;

  for (const endpoint of overpassEndpoints) {
    if (signal?.aborted) throw new Error('POI lookup cancelled.');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel);
    const timeout = setTimeout(() => controller.abort(), 9000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`POI service returned ${response.status}`);
      const payload = (await response.json()) as OverpassResponse;
      if (payload.remark || !Array.isArray(payload.elements)) throw new Error('POI service could not complete the search.');
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('POI service is unavailable.');
}

// A small, reviewed catalogue: venue websites document a regular motorcycle community.
const bikerVenues = [
  { pattern: /ace caf[eé]/i, latitude: 51.5406, longitude: -0.2786, url: 'https://london.acecafe.com/monthly-meets/' },
  { pattern: /squires/i, latitude: 53.782, longitude: -1.285, url: 'https://www.squires-cafe.co.uk/about/' },
  { pattern: /loomies/i, latitude: 51.031, longitude: -1.075, url: 'https://www.loomiescafe.co.uk/' },
];
export function bikerVenue(tags: Record<string, string>, point: Coordinate) {
  return bikerVenues.find((venue) => venue.pattern.test(tags.name ?? '')
    && Math.abs(point.latitude - venue.latitude) < 0.015 && Math.abs(point.longitude - venue.longitude) < 0.02);
}
export function poiFromElement(element: OverpassElement, category: PoiCategory): PointOfInterest | undefined {
  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;
  if (latitude == null || longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
  const tags = element.tags ?? {};
  const venue = category === 'meet' ? bikerVenue(tags, { latitude, longitude }) : undefined;
  if (category === 'meet' && !venue) return;
  const wiki = tags.wikipedia;
  const wikiMatch = wiki?.match(/^([a-z-]+):(.+)$/i);
  const image = tags.image;
  const commons = tags.wikimedia_commons?.replace(/^File:/, '');
  const imageUrl = commons && tags.wikimedia_commons?.startsWith('File:')
    ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(commons)}?width=400`
    : image?.startsWith('https://') ? image : undefined;
  const moreUrl = venue?.url ?? (wikiMatch ? `https://${wikiMatch[1]}.wikipedia.org/wiki/${encodeURIComponent(wikiMatch[2])}` : category === 'sight' ? `https://www.openstreetmap.org/${element.type}/${element.id}` : undefined);
  return { id: `${element.type}-${element.id}`, latitude, longitude, category,
    name: tags.name ?? tags.brand ?? categoryNames[category],
    detail: [category === 'meet' ? 'Regular biker gathering venue' : (tags.description ?? tags.tourism ?? tags.amenity ?? tags.historic ?? tags.natural ?? tags.landuse ?? categoryNames[category]).replaceAll('_', ' '),
      [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
    imageUrl, moreUrl, wikipedia: wiki, wikidata: tags.wikidata, fuelStationId: tags.fuel_station_id };
}

// Use a road vertex inside a named forest polygon, never the inaccessible area centre.
export function forestRoadPois(elements: OverpassElement[]): PointOfInterest[] {
  const roads = elements.filter((e) => /^(trunk|primary|secondary|tertiary|unclassified|residential|living_street)$/.test(e.tags?.highway ?? '')
    && !['access', 'vehicle', 'motor_vehicle', 'motorcycle'].some((key) => /^(no|private|agricultural|forestry|destination|customers)$/.test(e.tags?.[key] ?? ''))
    && e.tags?.noexit !== 'yes'
    && !/^(unpaved|gravel|dirt|ground|sand|mud)$/.test(e.tags?.surface ?? ''));
  return elements.flatMap((forest) => {
    const ring = forest.geometry;
    if (!forest.tags?.name || !(forest.tags.natural === 'wood' || forest.tags.landuse === 'forest') || !ring || ring.length < 4
      || ring[0].lat !== ring[ring.length - 1].lat || ring[0].lon !== ring[ring.length - 1].lon) return [];
    const inside = (point: { lat: number; lon: number }) => {
      let result = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.lat > point.lat) !== (b.lat > point.lat) && point.lon < (b.lon - a.lon) * (point.lat - a.lat) / (b.lat - a.lat) + a.lon) result = !result;
      }
      return result;
    };
    for (const road of roads) {
      const vertex = road.geometry?.find(inside);
      if (!vertex) continue;
      const poi = poiFromElement({ ...forest, lat: vertex.lat, lon: vertex.lon }, 'forest');
      return poi ? [{ ...poi, detail: `Public road through forest${road.tags?.name ? ` · ${road.tags.name}` : ''}` }] : [];
    }
    return [];
  });
}
export async function fetchNearbyPois(category: PoiCategory, center: Coordinate, radius = searchRadii[category], signal?: AbortSignal): Promise<PointOfInterest[]> {
  const endpoint = process.env.EXPO_PUBLIC_POI_URL;
  if (endpoint?.startsWith('https://')) {
    const response = await fetch(`${endpoint}?category=${category}&latitude=${center.latitude}&longitude=${center.longitude}&radius=${Math.min(radius, searchRadii[category])}`, {
      signal, headers: { Authorization: `Bearer ${process.env.EXPO_PUBLIC_ROUTING_TOKEN ?? ''}` },
    });
    if (!response.ok) throw new Error('Place service is unavailable.');
    const data = await response.json();
    if (!Array.isArray(data.points)) throw new Error('Invalid place response.');
    return data.points as PointOfInterest[];
  }
  const around = `(around:${radius},${center.latitude},${center.longitude})`;
  const statements = filters[category].map((filter) => `nwr${filter}${around};`).join('\n');
  const roads = category === 'forest' ? `way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"]${around};` : '';
  const query = `[out:json][timeout:8];(\n${statements}\n${roads}\n);out ${category === 'forest' ? 'geom' : 'center'} ${category === 'forest' ? 500 : 80};`;
  const payload = await requestOverpass(query, signal);
  const points = category === 'forest' ? forestRoadPois(payload.elements ?? [])
    : (payload.elements ?? []).flatMap((element) => { const poi = poiFromElement(element, category); return poi ? [poi] : []; });
  return points.filter((point, index) => !points.slice(0, index).some((other) => other.name === point.name
    && Math.abs(other.latitude - point.latitude) + Math.abs(other.longitude - point.longitude) < 0.001));
}

export async function fetchScenicPois(center: Coordinate, radiusKm: number): Promise<Coordinate[]> {
  const radius = Math.round(Math.min(35000, Math.max(8000, radiusKm * 1000)));
  const query = `[out:json][timeout:8];
(
nwr["tourism"~"attraction|viewpoint"](around:${radius},${center.latitude},${center.longitude});
nwr["natural"="saddle"](around:${radius},${center.latitude},${center.longitude});
nwr["mountain_pass"="yes"](around:${radius},${center.latitude},${center.longitude});
nwr["leisure"="nature_reserve"](around:${radius},${center.latitude},${center.longitude});
nwr["natural"="wood"]["name"](around:${radius},${center.latitude},${center.longitude});
);
out center 120;`;
  const payload = await requestOverpass(query);
  return (payload.elements ?? []).flatMap((element) => {
    const latitude = element.lat ?? element.center?.lat;
    const longitude = element.lon ?? element.center?.lon;
    return latitude == null || longitude == null ? [] : [{ latitude, longitude }];
  });
}
