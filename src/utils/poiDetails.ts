import type { PointOfInterest } from '@/types';

export async function highlightPhoto(point: PointOfInterest, signal: AbortSignal): Promise<string | undefined> {
  if (point.imageUrl) return point.imageUrl;
  const endpoint = process.env.EXPO_PUBLIC_POI_URL;
  if (endpoint?.startsWith('https://') && point.wikipedia) {
    const response = await fetch(`${endpoint.replace(/\/pois\/?$/, '/poi-photo')}?wikipedia=${encodeURIComponent(point.wikipedia)}`, { signal, headers: { Authorization: `Bearer ${process.env.EXPO_PUBLIC_ROUTING_TOKEN ?? ''}` } });
    if (!response.ok) return;
    const data = await response.json();
    return typeof data.imageUrl === 'string' && data.imageUrl.startsWith('https://') ? data.imageUrl : undefined;
  }
  const match = point.wikipedia?.match(/^([a-z-]+):(.+)$/i);
  if (!match) return;
  const response = await fetch(`https://${match[1]}.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=pageimages&piprop=thumbnail&pithumbsize=400&titles=${encodeURIComponent(match[2])}`, { signal });
  if (!response.ok) return;
  const payload = await response.json();
  const pages = payload.query?.pages ?? {};
  for (const page of Object.values(pages) as { thumbnail?: { source?: string } }[]) {
    if (page.thumbnail?.source?.startsWith('https://')) return page.thumbnail.source;
  }
}

export const fuelDiscrepancyUrl = 'https://www.fuel-finder.service.gov.uk/motorist/price-report';
export const fuelLicenceUrl = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';
export const fuelFreshnessMs = 5 * 60 * 1000;
export const fuelRefreshMs = 4 * 60 * 1000;
export type FuelPriceSnapshot = { description: string; expiresAt: number };

// Read docs/legal/fuel-finder-access-terms.md before changing this contract.
// checkedAt is the server's last successful upstream verification, NOT the time
// this request was served. A price can remain unchanged for days and be current.
export async function fuelPriceSnapshot(point: PointOfInterest, signal: AbortSignal): Promise<FuelPriceSnapshot | null> {
  const endpoint = process.env.EXPO_PUBLIC_FUEL_PRICES_URL;
  if (!endpoint?.startsWith('https://')) return null;
  const response = await fetch(`${endpoint}${endpoint.includes('?') ? '&' : '?'}latitude=${point.latitude}&longitude=${point.longitude}&name=${encodeURIComponent(point.name)}${point.fuelStationId ? `&stationId=${encodeURIComponent(point.fuelStationId)}` : ''}`, { signal, headers: { Authorization: `Bearer ${process.env.EXPO_PUBLIC_ROUTING_TOKEN ?? ''}` } });
  if (!response.ok) throw new Error('Fuel prices unavailable');
  const data = await response.json();
  const now = Date.now();
  const checked = typeof data?.checkedAt === 'string' ? Date.parse(data.checkedAt) : NaN;
  const parseTimestamp = (value: string) => Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
  const updated = typeof data?.updatedAt === 'string' ? parseTimestamp(data.updatedAt) : NaN;
  if (!Number.isFinite(checked) || checked > now + 60000 || now - checked >= fuelFreshnessMs
    || (data.updatedAt !== null && (!Number.isFinite(updated) || updated > checked + 60000))
    || (point.fuelStationId != null && data.stationId !== point.fuelStationId)
    || !Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)
    || Math.abs(data.latitude - point.latitude) > 0.001 || Math.abs(data.longitude - point.longitude) > 0.001
    || !Array.isArray(data.prices) || !data.prices.length || data.currency !== 'GBP' || data.unit !== 'pence/litre') return null;
  type Price = { fuel: string; amount: number | string | null; updatedAt: string | null; effectiveAt?: string | null };
  const validAmount = (amount: unknown) => (typeof amount === 'number' || typeof amount === 'string' && /^\d+(?:\.\d+)?$/.test(amount))
    && Number.isFinite(Number(amount)) && Number(amount) > 0;
  // Validate the whole snapshot, never silently hide individual fuel types.
  if (!data.prices.every((price: Price | null) => price && typeof price.fuel === 'string' && price.fuel.trim()
    && (price.amount === null || validAmount(price.amount))
    && (price.amount === null && price.updatedAt === null || typeof price.updatedAt === 'string' && Number.isFinite(parseTimestamp(price.updatedAt)) && parseTimestamp(price.updatedAt) <= checked + 60000))) return null;
  return {
    description: `${data.prices.map((price: Price) => `${price.fuel}: ${price.amount === null ? 'Price unavailable' : `${price.amount}p/l`}${price.updatedAt ? ` · Updated ${price.updatedAt}` : ''}${price.effectiveAt ? ` · Effective ${price.effectiveAt}` : ''}`).join('\n')}\n${data.updatedAtBasis === 'latest-price-update' ? 'Latest price update' : 'Site updated'} ${data.updatedAt ?? 'Unavailable'} · ${typeof data.source === 'string' ? data.source : 'Fuel Finder'}\nChecked with Fuel Finder ${data.checkedAt}`,
    expiresAt: checked + fuelFreshnessMs,
  };
}

export async function fuelPriceDescription(point: PointOfInterest, signal: AbortSignal): Promise<string> {
  return (await fuelPriceSnapshot(point, signal))?.description ?? 'Live prices unavailable';
}
