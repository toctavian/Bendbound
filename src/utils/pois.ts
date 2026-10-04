import { Coordinate, PoiCategory, PointOfInterest } from '@/types';

type OverpassElement = {
  id: number;
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

type OverpassResponse = { elements?: OverpassElement[] };

const overpassEndpoints = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const filters: Record<PoiCategory, string[]> = {
  fuel: ['["amenity"="fuel"]'],
  pass: ['["natural"="saddle"]', '["mountain_pass"="yes"]'],
  meet: ['["amenity"~"cafe|pub"]'],
  sight: ['["tourism"~"attraction|viewpoint"]', '["historic"]'],
  forest: ['["natural"="wood"]', '["landuse"="forest"]', '["leisure"="nature_reserve"]'],
};

const categoryNames: Record<PoiCategory, string> = {
  fuel: 'Fuel station',
  pass: 'Mountain pass',
  meet: 'Cafe or meeting place',
  sight: 'Sightseeing highlight',
  forest: 'Forest or nature reserve',
};

const searchRadii: Record<PoiCategory, number> = {
  fuel: 15000,
  pass: 35000,
  meet: 8000,
  sight: 8000,
  forest: 10000,
};

async function requestOverpass(query: string): Promise<OverpassResponse> {
  let lastError: unknown;

  for (const endpoint of overpassEndpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    try {
      const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`POI service returned ${response.status}`);
      return (await response.json()) as OverpassResponse;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('POI service is unavailable.');
}

export async function fetchNearbyPois(category: PoiCategory, center: Coordinate, radius = searchRadii[category]): Promise<PointOfInterest[]> {
  const statements = filters[category]
    .map((filter) => `nwr${filter}(around:${radius},${center.latitude},${center.longitude});`)
    .join('\n');
  const query = `[out:json][timeout:8];\n(\n${statements}\n);\nout center 80;`;
  const payload = await requestOverpass(query);
  return (payload.elements ?? []).flatMap((element) => {
    const latitude = element.lat ?? element.center?.lat;
    const longitude = element.lon ?? element.center?.lon;
    if (latitude == null || longitude == null) return [];
    const tags = element.tags ?? {};
    return [{
      id: `${element.type}-${element.id}`,
      latitude,
      longitude,
      category,
      name: tags.name ?? tags.brand ?? categoryNames[category],
      detail: tags.tourism ?? tags.amenity ?? tags.natural ?? tags.landuse ?? categoryNames[category],
    }];
  });
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
