import http from 'node:http';
import { engineJSON, RoutingError } from './engine.mjs';
import { planRoundTrip } from './planner.mjs';
import { createRateLimiter } from './rate-limit.mjs';

const base = process.env.VALHALLA_URL || 'http://127.0.0.1:8002';
const allowRequest = createRateLimiter();
let active = 0;
async function body(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new RoutingError('INVALID_REQUEST', 'Request too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new RoutingError('INVALID_REQUEST', 'Expected JSON.', 400); }
}
const server = http.createServer(async (request, response) => {
  const abort = new AbortController();
  response.on('close', () => { if (!response.writableEnded) abort.abort(); });
  const send = (status, payload) => { if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(payload)); } };
  // Caddy overwrites this header. The API port must remain loopback-only.
  const client = request.headers['x-routing-client-ip'] || request.socket.remoteAddress;
  const limit = allowRequest(client);
  if (!limit.allowed) {
    response.setHeader('Retry-After', String(limit.retryAfter));
    return send(429, { code: 'RATE_LIMITED', message: 'Too many routing requests. Please try again in a minute.' });
  }
  if (active >= 2) return send(429, { code: 'BUSY', message: 'Routing is busy. Try again shortly.' });
  active++;
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const engine = await engineJSON(base, 'status', undefined, abort.signal);
      return send(200, { status: 'ready', engine: 'valhalla', version: engine.version });
    }
    if (request.method !== 'POST' || !['/route', '/round-trip'].includes(request.url)) return send(404, { code: 'NOT_FOUND' });
    const input = await body(request);
    if (request.url === '/round-trip') return send(200, await planRoundTrip(input, { base, signal: abort.signal }));
    // The app sends bounded batches; keep arbitrary engine endpoints private.
    if (input.costing !== 'motorcycle' || !Array.isArray(input.locations) || input.locations.length < 2 || input.locations.length > 10) {
      throw new RoutingError('INVALID_REQUEST', 'Expected 2–10 motorcycle routing locations.', 400);
    }
    send(200, await engineJSON(base, 'route', input, abort.signal));
  } catch (error) {
    send(error.status || 500, { code: error.code || 'INTERNAL', message: error.status ? error.message : 'Routing failed.', diagnostics: error.diagnostics });
  } finally { active--; }
});
server.requestTimeout = 35000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || 8088), '0.0.0.0', () => console.log('Bendbound routing API ready'));
