// Deployment gate: run with Node 22, --base and optionally --env-file/--output.
// Only public test locations and compact metrics are persisted.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { conePolygon, insideCone, coneBufferKm } from '../service/cone.mjs';
import { geometry } from '../service/engine.mjs';
const { values } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:8088' }, 'env-file': { type: 'string' }, output: { type: 'string' } } });
let token = process.env.ROUTING_API_TOKEN || process.env.EXPO_PUBLIC_ROUTING_TOKEN;
if (values['env-file']) {
  const line = readFileSync(values['env-file'], 'utf8').split('\n').find(s => /^(ROUTING_API_TOKEN|EXPO_PUBLIC_ROUTING_TOKEN)=/.test(s));
  if (line) token = line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
}
async function request(input) {
  const response = await fetch(values.base.replace(/\/$/, '') + '/round-trip', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input), signal: AbortSignal.timeout(35000),
  });
  return { status: response.status, data: await response.json(), requestId: response.headers.get('x-request-id') };
}
const cases = [
  { name: 'E14-south', center: { latitude: 51.487429, longitude: -0.020573 }, direction: 180, targetKm: 40, radiusKm: 25 },
  { name: 'E14-north', center: { latitude: 51.487429, longitude: -0.020573 }, direction: 0, targetKm: 40, radiusKm: 20 },
  { name: 'Dorking-east', center: { latitude: 51.2328, longitude: -0.3297 }, direction: 90, targetKm: 40, radiusKm: 20 },
  { name: 'Dorking-west', center: { latitude: 51.2328, longitude: -0.3297 }, direction: 270, targetKm: 40, radiusKm: 20 },
  { name: 'Dorking-east-larger-area', center: { latitude: 51.2328, longitude: -0.3297 }, direction: 90, targetKm: 40, radiusKm: 30 },
];
const checks = [];
for (const { name, ...area } of cases) {
  const start = performance.now();
  const result = await request({ ...area, profile: 'winding', avoidMotorways: true });
  assert.equal(result.status, 200, `${name}: ${result.data.message}`);
  const p = result.data.planner;
  assert.equal(p.valid, true); assert.equal(p.insideCone, true);
  assert.equal(p.coneRadiusKm, area.radiusKm); assert.equal(p.coneBufferKm, coneBufferKm(area.radiusKm));
  assert.ok(Math.abs(result.data.trip.summary.length - area.targetKm) < 10);
  assert.ok(p.maxTraversals <= 2 && p.repeatedRatio <= 0.1);
  const ring = conePolygon(area, true);
  assert.ok(geometry(result.data).every(point => insideCone(point, ring)));
  checks.push({ name, status: result.status, requestId: result.requestId, durationMs: Math.round(performance.now() - start),
    distanceKm: p.distanceKm, repeatedRatio: p.repeatedRatio, maxTraversals: p.maxTraversals, radiusKm: p.coneRadiusKm, insideCone: p.insideCone });
}
const invalid = await request({ ...cases[0], radiusKm: 101, profile: 'winding', avoidMotorways: true });
assert.equal(invalid.status, 400); assert.equal(invalid.data.code, 'INVALID_REQUEST');
checks.push({ name: 'invalid-radius', status: invalid.status });
const { name, radiusKm, ...legacy } = cases[0];
const compatible = await request({ ...legacy, profile: 'winding', avoidMotorways: true });
assert.equal(compatible.status, 200); assert.equal(compatible.data.planner.valid, true);
checks.push({ name: 'legacy-client', status: compatible.status });
const report = { verifiedAt: new Date().toISOString(), checks };
if (values.output) writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
