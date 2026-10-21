import type { DraftRoute, Coordinate } from '@/types';

export type SharedRoute = { version: 1; route: DraftRoute; avoidMotorways: boolean };
export const validShareId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const origin = () => {
  const url = process.env.EXPO_PUBLIC_ROUTING_URL?.trim().replace(/\/+$/, '');
  if (!url || !url.startsWith('https://')) throw new Error('Route sharing needs a connection to Bendbound.');
  return url;
};
const coordinate = (p: Coordinate) => p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 85 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
export function parseSharedRoute(value: unknown): SharedRoute {
  const payload = value as SharedRoute, r = payload?.route;
  const text = (s: unknown, max = 500) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
  const optionalText = (s: unknown, max = 500) => s == null || typeof s === 'string' && s.length <= max;
  const number = (n: number) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000;
  if (payload?.version !== 1 || typeof payload.avoidMotorways !== 'boolean' || !r || !text(r.title)
    || !['fast', 'winding', 'twisty'].includes(r.profile) || !Array.isArray(r.route) || r.route.length < 2 || r.route.length > 30000 || !r.route.every(coordinate)
    || ![r.distanceKm, r.durationMin, r.curves].every(number)
    || (r.roundTrip !== undefined && typeof r.roundTrip !== 'boolean')
    || (r.stops !== undefined && (!Array.isArray(r.stops) || r.stops.length > 1000 || r.stops.some(s => !coordinate(s) || !text(s.id) || !text(s.name) || !optionalText(s.address, 1000))))
    || (r.maneuvers !== undefined && (!Array.isArray(r.maneuvers) || r.maneuvers.length > 5000 || r.maneuvers.some(m => !Number.isInteger(m.type) || m.type < 0 || m.type > 100
      || !text(m.instruction, 2000) || !Number.isInteger(m.beginShapeIndex) || !Number.isInteger(m.endShapeIndex) || m.beginShapeIndex < 0 || m.endShapeIndex < m.beginShapeIndex || m.endShapeIndex >= r.route.length
      || !optionalText(m.spokenInstruction, 2000) || !optionalText(m.streetName)
      || (m.bearingAfter !== undefined && (!number(m.bearingAfter) || m.bearingAfter > 360)))))) {
    throw new Error('This shared route is invalid or needs a newer Bendbound version.');
  }
  // Copy only planning data. Never import recording state, settings or credentials.
  return { version: 1, avoidMotorways: payload.avoidMotorways, route: {
    title: r.title, profile: r.profile, distanceKm: r.distanceKm, durationMin: r.durationMin, curves: r.curves,
    route: r.route.map(({ latitude, longitude }) => ({ latitude, longitude })),
    ...(r.roundTrip !== undefined ? { roundTrip: r.roundTrip } : {}),
    ...(r.stops ? { stops: r.stops.map(({ id, name, address, latitude, longitude }) => ({ id, name, latitude, longitude, ...(text(address, 1000) ? { address } : {}) })) } : {}),
    ...(r.maneuvers ? { maneuvers: r.maneuvers.map(({ type, instruction, spokenInstruction, streetName, beginShapeIndex, endShapeIndex, bearingAfter }) => ({ type, instruction, beginShapeIndex, endShapeIndex,
      ...(text(spokenInstruction, 2000) ? { spokenInstruction } : {}), ...(text(streetName) ? { streetName } : {}), ...(bearingAfter !== undefined ? { bearingAfter } : {}) })) } : {}),
  } };
}
async function request(path: string, options: RequestInit = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${origin()}${path}`, { ...options, signal: controller.signal });
    if (!response.ok) {
      if ([404, 410].includes(response.status)) throw new Error('This shared route is unavailable or has expired.');
      throw new Error('Could not connect to route sharing. Please try again.');
    }
    const body = await response.text();
    if (body.length > 2097152) throw new Error('This shared route is too large.');
    return JSON.parse(body);
  } finally { clearTimeout(timeout); }
}
export async function createRouteShare(route: DraftRoute, avoidMotorways: boolean) {
  const payload = parseSharedRoute({ version: 1, route, avoidMotorways });
  const body = JSON.stringify(payload);
  if (body.length > 1000000) throw new Error('This route is too large to share.');
  const token = process.env.EXPO_PUBLIC_ROUTING_TOKEN?.trim();
  const result = await request('/shared-routes', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body });
  if (!validShareId(result.id)) throw new Error('The server returned an invalid route link.');
  return `${origin()}/shared/${result.id}`;
}
export async function loadRouteShare(id: unknown) {
  if (!validShareId(id)) throw new Error('This route link is invalid.');
  return parseSharedRoute(await request(`/shared-routes/${id}`));
}
