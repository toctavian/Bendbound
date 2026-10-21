const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
function load(file, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((name) => imports[name], module, module.exports);
  return module.exports;
}
const clock = load('src/utils/groups/clock.ts');
const contracts = load('src/types/groupRide.ts');
const { createPublisherCaptureClock } = load('src/utils/groups/publisherClock.ts', { './clock': clock, '@/types/groupRide': contracts });
const base = 1_000_000;
const reading = (elapsed, skew = 0) => ({ wallTimeMs: base + elapsed + skew, monotonicTimeMs: 10_000 + elapsed });
const sample = (rtt = 100, skew = 0, forward = 0) => clock.sampleServerClock(reading(0, skew), reading(rtt, skew), base + forward);

test('capture preserves raw skewed time and full asymmetric calibration uncertainty', () => {
  for (const skew of [-800_000, 0, 800_000]) {
    for (const rtt of [0, 100, 2000]) {
      for (const forward of [0, rtt / 2, rtt]) {
        const publisher = createPublisherCaptureClock(sample(rtt, skew, forward));
        const capture = publisher.capture(reading(2000, skew));
        assert.equal(capture.version, 1);
        assert.equal(capture.rawCapturedAt, base + 2000 + skew);
        assert.ok(capture.serverCaptureEarliestMs <= base + 2000);
        assert.ok(capture.serverCaptureLatestMs >= base + 2000);
        const publication = publisher.publication(capture, reading(7000, skew));
        assert.ok(publication.youngestAgeMs <= 5000);
        assert.ok(publication.oldestAgeMs >= 5000);
        assert.equal(publication.capture, capture);
      }
    }
  }
});
test('uncertainty consumes the upload age budget; delayed captures cannot become fresh', () => {
  const publisher = createPublisherCaptureClock(sample(2000));
  const capture = publisher.capture(reading(2000));
  assert.ok(publisher.publication(capture, reading(14_000)));
  // Actual age 13 seconds, plus full RTT and resolution/drift exceeds 15 seconds.
  assert.equal(publisher.publication(capture, reading(15_000)), null);
  assert.equal(publisher.publication(capture, reading(60_000)), null);
  assert.equal(capture.rawCapturedAt, base + 2000);
});
test('prior calibration is required and clock discontinuities/expiry fail closed', () => {
  const publisher = createPublisherCaptureClock(sample());
  for (const value of [reading(99), reading(60_101), reading(100, 101), reading(100, -101),
    { ...reading(100), monotonicTimeMs: NaN }, { ...reading(100), wallTimeMs: 0.5 }]) {
    assert.equal(publisher.capture(value), null);
  }
  const capture = publisher.capture(reading(1000));
  for (const value of [reading(999), reading(60_101), reading(2000, 101), reading(2000, -101),
    { ...reading(2000), wallTimeMs: Infinity }]) assert.equal(publisher.publication(capture, value), null);
  // Each endpoint is within the sample's tolerance, but their difference is not.
  const shifted = publisher.capture(reading(1000, 60));
  assert.equal(publisher.publication(shifted, reading(2000, -60)), null);
});
test('later calibration, serialisation and forged bounds cannot rebind old capture handles', () => {
  const publisher = createPublisherCaptureClock(sample());
  const capture = publisher.capture(reading(1000));
  const next = createPublisherCaptureClock(clock.sampleServerClock(reading(30_000), reading(30_100), base + 30_000));
  assert.equal(next.publication(capture, reading(30_100)), null);
  assert.equal(publisher.publication({ ...capture }, reading(1000)), null);
  assert.equal(publisher.publication({ ...capture, serverCaptureEarliestMs: base + 10_000 }, reading(10_000)), null);
  assert.equal(publisher.publication(capture, reading(30_100)), null);
  assert.equal(next.capture(reading(1000)), null);
});
test('capture handles, calibration and paired readings are immutable snapshots', () => {
  const calibration = { ...sample(), received: { ...sample().received } };
  const publisher = createPublisherCaptureClock(calibration);
  const captured = reading(1000);
  const timing = publisher.capture(captured);
  const expected = publisher.publication(timing, reading(2000));
  calibration.serverTimeMs = 0; calibration.received.wallTimeMs = 0;
  captured.wallTimeMs = 0; captured.monotonicTimeMs = 0;
  assert.ok(Object.isFrozen(timing)); assert.ok(Object.isFrozen(expected));
  assert.deepEqual(publisher.publication(timing, reading(2000)), expected);
});
test('existing server v1 refuses draft timing metadata and retains strict raw clock validation', async () => {
  const { validFix } = await import('../services/group-rides/src/locations.mjs');
  const fix = { latitude: 0, longitude: 0, accuracyM: 5, headingDeg: null, speedMps: null,
    capturedAt: base, sessionEpoch: 'synthetic-session-epoch', sequence: 0 };
  assert.equal(validFix(fix, base), true);
  const publisher = createPublisherCaptureClock(sample());
  assert.equal(validFix({ ...fix, captureTiming: publisher.capture(reading(100)) }, base + 100), false);
  assert.equal(validFix({ ...fix, capturedAt: base - 800_000 }, base), false);
  assert.equal(validFix({ ...fix, capturedAt: base + 800_000 }, base), false);
});

test('scope invalidation permanently disables capture and retained publication handles', () => {
  const publisher = createPublisherCaptureClock(sample());
  const capture = publisher.capture(reading(1000));
  assert.ok(publisher.publication(capture, reading(1000)));
  publisher.invalidate(); publisher.invalidate();
  assert.equal(publisher.capture(reading(2000)), null);
  assert.equal(publisher.publication(capture, reading(2000)), null);
  const next = createPublisherCaptureClock(sample());
  assert.equal(next.publication(capture, reading(2000)), null);
  assert.ok(next.capture(reading(2000)));
});
