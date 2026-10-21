const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
function load(file, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((name) => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}
const contracts = load('src/types/groupRide.ts');
const clock = load('src/utils/groups/clock.ts');
const { newestShareableFix, groupFixFreshness, validGroupFix } = load('src/utils/groups/location.ts', { '@/types/groupRide': contracts, './clock': clock });
// Synthetic positions only; never real rider trace data.
const now = 1_000_000, epoch = 'synthetic-session-epoch';
const sample = (timestamp, extras = {}) => ({ timestamp, coords: { latitude: 0, longitude: 0, accuracy: 5, heading: -1, speed: -1, ...extras } });
test('background batch shares only its newest valid recent fix and handles unknown heading/speed', () => {
  const fix = newestShareableFix([sample(now - 300_000), sample(now - 4000), sample(now - 1000), sample(now + 5000)], now, epoch, 3);
  assert.equal(fix.capturedAt, now - 1000); assert.equal(fix.sequence, 3); assert.equal(fix.headingDeg, null); assert.equal(fix.speedMps, null);
  assert.equal(newestShareableFix([sample(now - 16_000)], now, epoch, 1), null);
});
test('invalid fix fields, clocks and session identifiers are rejected', () => {
  const fix = newestShareableFix([sample(now)], now, epoch, 1);
  for (const patch of [{ latitude: NaN }, { latitude: 91 }, { longitude: 181 }, { accuracyM: -1 }, { accuracyM: 101 }, { headingDeg: 360 }, { speedMps: 151 }, { capturedAt: now + 1001 }, { sequence: 0.5 }, { sessionEpoch: 'short' }]) assert.equal(validGroupFix({ ...fix, ...patch }, now), false);
});
test('recent receipt cannot conceal an ancient capture, with precise freshness thresholds', () => {
  const fix = { ...newestShareableFix([sample(now)], now, epoch, 1), receivedAt: now };
  assert.equal(groupFixFreshness(fix, now + 20_000), 'fresh');
  assert.equal(groupFixFreshness(fix, now + 20_001), 'stale');
  assert.equal(groupFixFreshness(fix, now + 60_000), 'offline');
  assert.equal(groupFixFreshness({ ...fix, receivedAt: now + 60_000 }, now + 60_000), 'offline');
  assert.equal(groupFixFreshness(fix, now + 300_000), 'hidden');
  assert.equal(groupFixFreshness({ ...fix, capturedAt: now + 5000 }, now), 'hidden');
});
