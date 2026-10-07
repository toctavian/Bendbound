import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { planRoundTrip } from './service/planner.mjs';
import { assess, engineJSON, geometry } from './service/engine.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const valhalla = process.env.VALHALLA_URL || 'http://127.0.0.1:8002';
const graphhopper = process.env.GRAPHHOPPER_URL || 'http://127.0.0.1:8989';
const sites = [
  { name: 'Greenwich', center: { latitude: 51.481, longitude: -0.009 }, direction: 90 },
  { name: 'Richmond', center: { latitude: 51.461, longitude: -0.303 }, direction: 45 },
  { name: 'Enfield', center: { latitude: 51.651, longitude: -0.083 }, direction: 180 },
];
const fixtures = sites.flatMap(site => [20, 40].flatMap(targetKm => [true, false].flatMap(avoidMotorways =>
  ['fast', 'winding', 'twisty'].map(profile => ({ ...site, targetKm, avoidMotorways, profile })))));
const selected = process.argv.includes('--smoke') ? fixtures.slice(0, 2) : fixtures;
const manifest = JSON.parse(await readFile(`${root}.data/map/manifest.json`, 'utf8'));
// Readiness checks fail the run instead of manufacturing a losing score for an offline engine.
const versions = { valhalla: await engineJSON(valhalla, 'status'), graphhopper: await engineJSON(graphhopper, 'info') };
const rows = [];
async function graphhopperLoop(input) {
  const start = Date.now(); let requested = input.targetKm; const diagnostics = [];
  for (let seed = 0; seed < 24 && Date.now() - start < 25000; seed++) {
    try {
      const payload = await engineJSON(graphhopper, 'route', {
        profile: 'motorcycle', points: [[input.center.longitude, input.center.latitude]],
        algorithm: 'round_trip', 'round_trip.distance': requested * 1000, 'round_trip.seed': seed,
        headings: [input.direction], points_encoded: false, instructions: true,
        'ch.disable': true, custom_model: { priority: input.avoidMotorways ? [{ if: 'road_class == MOTORWAY', multiply_by: '0' }] : [] },
      }, AbortSignal.timeout(Math.max(1, 25000 - (Date.now() - start))));
      const route = payload.paths?.[0];
      if (!route?.points?.coordinates?.length) throw new Error('No GraphHopper path');
      const points = route.points.coordinates.map(([longitude, latitude]) => ({ latitude, longitude }));
      const metrics = assess(points, route.distance / 1000, input.targetKm, input.center);
      diagnostics.push(metrics);
      if (metrics.valid) return { ...metrics, elapsedMs: Date.now() - start, attempts: seed + 1 };
      requested *= Math.max(0.65, Math.min(1.35, input.targetKm / metrics.distanceKm));
    } catch (error) { diagnostics.push({ code: error.code, message: error.message }); }
  }
  return { valid: false, elapsedMs: Date.now() - start, attempts: diagnostics.length, diagnostics };
}
// Sequential, alternating order to reduce warm-cache/order bias and contention.
for (const [index, input] of selected.entries()) {
  for (const engine of index % 2 ? ['graphhopper', 'valhalla'] : ['valhalla', 'graphhopper']) {
    const started = Date.now(); let result;
    try {
      if (engine === 'graphhopper') result = await graphhopperLoop(input);
      else {
        const payload = await planRoundTrip(input, { base: valhalla });
        result = { ...assess(geometry(payload), payload.trip.summary.length, input.targetKm, input.center), ...payload.planner };
      }
    } catch (error) { result = { valid: false, elapsedMs: Date.now() - started, code: error.code, diagnostics: error.diagnostics }; }
    rows.push({ fixture: input, engine, ...result });
    console.log(`${input.name} ${input.targetKm} km ${input.profile} avoidMotorways=${input.avoidMotorways}: ${engine} ${result.valid ? 'PASS' : 'NO MATCH'} ${result.elapsedMs} ms`);
  }
}
const summary = Object.fromEntries(['valhalla', 'graphhopper'].map(engine => {
  const engineRows = rows.filter(row => row.engine === engine);
  const times = engineRows.map(row => row.elapsedMs).sort((a,b) => a-b);
  return [engine, { valid: engineRows.filter(row => row.valid).length, cases: engineRows.length,
    medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1] }];
}));
const timestamp = new Date().toISOString().replaceAll(':', '-');
const report = { timestamp, map: manifest, versions, benchmark: { maxAttempts: 24, budgetMs: 25000, area: 'Greater London',
  notes: 'Pilot feasibility comparison, not proof of motorcycle access equivalence or winding quality. Stock GraphHopper motorcycle uses car_access. Geometry overlap validator cannot distinguish stacked roads. No claim of optimality or impossibility for failed cases.' }, summary, rows };
await mkdir(`${root}results`, { recursive: true });
await writeFile(`${root}results/${timestamp}.json`, JSON.stringify(report, null, 2));
await writeFile(`${root}results/latest.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
