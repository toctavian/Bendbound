import { Coordinate } from '@/types';
import { distanceBetween } from '@/utils/routes';

export type RoadContext = {
  name: string | null;
  speedLimitKph: number | null;
  roadClass: string | null;
};

type LocateEdge = {
  distance?: number;
  heading?: number;
  edge_info?: {
    names?: string[];
    speed_limit?: number;
  };
  edge?: {
    access?: { motorcycle?: boolean };
    classification?: { classification?: string };
  };
};

type LocateResponse = { edges?: LocateEdge[] }[];

function headingDifference(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

export async function fetchRoadContext(location: Coordinate, heading?: number): Promise<RoadContext> {
  const request = {
    locations: [{ lat: location.latitude, lon: location.longitude }],
    costing: 'motorcycle',
    verbose: true,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(
      `https://valhalla1.openstreetmap.de/locate?json=${encodeURIComponent(JSON.stringify(request))}`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`Road lookup returned ${response.status}`);
    const payload = (await response.json()) as LocateResponse;
    const candidates = (payload[0]?.edges ?? []).filter((edge) => edge.edge?.access?.motorcycle !== false);
    const selected = candidates.sort((a, b) => {
      const aScore = (a.distance ?? 1000) + (heading == null ? 0 : headingDifference(a.heading ?? heading, heading) * 0.35);
      const bScore = (b.distance ?? 1000) + (heading == null ? 0 : headingDifference(b.heading ?? heading, heading) * 0.35);
      return aScore - bScore;
    })[0];
    const speedLimit = selected?.edge_info?.speed_limit;
    return {
      name: selected?.edge_info?.names?.[0] ?? null,
      speedLimitKph: speedLimit && speedLimit > 0 && speedLimit < 255 ? Math.round(speedLimit) : null,
      roadClass: selected?.edge?.classification?.classification ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function cumulativeRouteDistances(route: Coordinate[]) {
  const distances = [0];
  route.slice(1).forEach((point, index) => {
    distances.push(distances[index] + distanceBetween(route[index], point));
  });
  return distances;
}

export function closestRoutePoint(route: Coordinate[], location: Coordinate, hint = -1) {
  if (!route.length) return { index: 0, distanceKm: Number.POSITIVE_INFINITY };
  const start = hint < 0 ? 0 : Math.max(0, hint - 80);
  const end = hint < 0 ? route.length : Math.min(route.length, hint + 1200);
  let closestIndex = start;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (let index = start; index < end; index += 1) {
    const distanceKm = distanceBetween(location, route[index]);
    if (distanceKm < closestDistance) {
      closestDistance = distanceKm;
      closestIndex = index;
    }
  }

  return { index: closestIndex, distanceKm: closestDistance };
}

export function bearingBetween(from: Coordinate, to: Coordinate) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;
  const latitude1 = toRad(from.latitude);
  const latitude2 = toRad(to.latitude);
  const longitudeDelta = toRad(to.longitude - from.longitude);
  const y = Math.sin(longitudeDelta) * Math.cos(latitude2);
  const x = Math.cos(latitude1) * Math.sin(latitude2) - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function cardinalDirection(heading: number) {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round(((heading % 360) + 360) % 360 / 45) % labels.length];
}

export function formatNavigationDistance(distanceKm: number) {
  if (distanceKm < 1) return `${Math.max(10, Math.round((distanceKm * 1000) / 10) * 10)} m`;
  return `${distanceKm < 10 ? distanceKm.toFixed(1) : Math.round(distanceKm)} km`;
}
