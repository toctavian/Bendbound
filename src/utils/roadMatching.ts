import Storage from 'expo-sqlite/kv-store';
import type { Coordinate, TrackPoint } from '@/types';

const memory = new Map<string, Coordinate[]>();
let queue: Promise<unknown> = Promise.resolve();
let lastRequest = 0;
function cacheId(key: string) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return `bendbound-road-display-v1-${hash >>> 0}`;
}
export async function matchRoadChunk(points: Coordinate[], signal?: AbortSignal): Promise<Coordinate[]> {
  const url = process.env.EXPO_PUBLIC_ROUTING_URL?.trim().replace(/\/+$/, '');
  if (!url || points.length < 2 || points.length > 128) return points;
  const key = JSON.stringify(points), id = cacheId(key);
  if (memory.has(key)) return memory.get(key)!;
  try {
    const cached = JSON.parse(Storage.getItemSync(id) ?? 'null');
    if (cached?.key === key && Array.isArray(cached.geometry)) { memory.set(key, cached.geometry); return cached.geometry; }
  } catch { /* Display caching cannot interrupt a recording. */ }
  const operation = queue.catch(() => undefined).then(async () => {
    if (signal?.aborted) return points;
    if (memory.has(key)) return memory.get(key)!;
    const wait = Math.max(0, 2500 - (Date.now() - lastRequest));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    if (signal?.aborted) return points;
    lastRequest = Date.now();
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 8000);
    const abort = () => timeout.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const token = process.env.EXPO_PUBLIC_ROUTING_TOKEN?.trim();
      const response = await fetch(`${url}/match`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ points }), signal: timeout.signal });
      if (!response.ok) return points;
      const result = await response.json();
      const geometry = result.geometry as Coordinate[];
      if (!Array.isArray(geometry) || geometry.length < 2 || geometry.some(p => !Number.isFinite(p?.latitude) || Math.abs(p.latitude) > 85 || !Number.isFinite(p.longitude) || Math.abs(p.longitude) > 180)) return points;
      memory.set(key, geometry);
      while (memory.size > 64) memory.delete(memory.keys().next().value!);
      try {
        const indexKey = 'bendbound-road-display-index-v1';
        const ids: string[] = JSON.parse(Storage.getItemSync(indexKey) ?? '[]');
        const updated = [...ids.filter(i => i !== id), id];
        Storage.setItemSync(id, JSON.stringify({ key, geometry }));
        while (updated.length > 64) Storage.removeItemSync(updated.shift()!);
        Storage.setItemSync(indexKey, JSON.stringify(updated));
      } catch { /* Raw recordings are still durable if this optional cache fails. */ }
      return geometry;
    } catch { return points; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  });
  queue = operation;
  return operation;
}
// Split at recorded pauses/outages and use overlapping batches. Drawing batches
// as separate lines avoids inventing a connector if two matches disagree.
export function recordingChunks(segments: Coordinate[][]): Coordinate[][] {
  const result: Coordinate[][] = [];
  for (const segment of segments) {
    let run: Coordinate[] = [];
    const flush = () => { for (let i = 0; i < run.length; i += 95) { const chunk = run.slice(i, i + 96); if (chunk.length) result.push(chunk); if (i + 96 >= run.length) break; } run = []; };
    for (const point of segment) {
      const previous = run[run.length - 1] as TrackPoint | undefined;
      const current = point as TrackPoint;
      if (previous && Number.isFinite(current.timestamp) && Number.isFinite(previous.timestamp) && current.timestamp - previous.timestamp > 30000) flush();
      run.push(point);
    }
    flush();
  }
  return result;
}
