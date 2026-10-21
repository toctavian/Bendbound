const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
function load(file, imports = {}, timers = {}) {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', outputText)((name) => imports[name], module, module.exports, timers.setTimeout ?? setTimeout, timers.clearTimeout ?? clearTimeout);
  return module.exports;
}
const clock = load('src/utils/groups/clock.ts');
const contracts = load('src/types/groupRide.ts');
const { calibratedGroupFixFreshness } = load('src/utils/groups/location.ts', { '@/types/groupRide': contracts, './clock': clock });
const core = load('src/services/auth/sessionManager.ts');
const imports = { './sessionManager': core, '@/utils/groups/clock': clock };
const { createGroupSessionClient } = load('src/services/auth/groupSessions.ts', imports);
const at = 1_000_000;
const reading = (elapsed, skew = 0) => ({ wallTimeMs: at + elapsed + skew, monotonicTimeMs: 10_000 + elapsed });
const sample = (rtt = 100) => clock.sampleServerClock(reading(0), reading(rtt), at);
const point = (capturedAt, receivedAt = capturedAt) => ({ capturedAt, receivedAt });
test('server interval contains either extreme of asymmetric network delay, with skewed receiver clocks', () => {
  for (const skew of [-800_000, 800_000]) {
    const calibration = clock.sampleServerClock(reading(0, skew), reading(100, skew), at);
    const bounds = clock.serverTimeBounds(calibration, reading(200, skew));
    assert.ok(bounds.earliest <= at + 100); assert.ok(bounds.latest >= at + 200);
    assert.ok(bounds.latest - bounds.earliest > 100);
    assert.equal(calibratedGroupFixFreshness(point(at - 30_000, at), calibration, reading(200, skew)), 'stale');
  }
});
test('invalid, reversed, delayed and discontinuous timings cannot establish calibration', () => {
  for (const [start, end, server] of [
    [reading(0), reading(2001), at], [reading(100), reading(0), at],
    [reading(0), reading(100, 101), at], [reading(0), reading(100, -101), at],
    [reading(0), reading(0), NaN], [reading(0), reading(0), -1],
    [reading(0), reading(0), 0.5], [reading(0), reading(0), Number.MAX_SAFE_INTEGER],
    [{ ...reading(0), monotonicTimeMs: Infinity }, reading(100), at],
  ]) assert.equal(clock.sampleServerClock(start, end, server), null);
  assert.ok(sample(2000));
});
test('samples expire, reject clock jumps and cannot mutate through captured clock readings', () => {
  const end = reading(100), calibration = clock.sampleServerClock(reading(0), end, at);
  end.wallTimeMs = 0; assert.ok(clock.serverTimeBounds(calibration, reading(100)));
  for (const current of [reading(60_101), reading(99), reading(101, 101), reading(101, -101), { ...reading(101), wallTimeMs: NaN }]) {
    assert.equal(clock.serverTimeBounds(calibration, current), null);
    assert.equal(calibratedGroupFixFreshness(point(at), calibration, current), 'hidden');
  }
  assert.ok(clock.serverTimeBounds(calibration, reading(60_100)));
  assert.equal(calibratedGroupFixFreshness(point(at), null, reading(100)), 'hidden');
});
test('oldest plausible age governs thresholds; receipt, delay and recalibration never rewrite old captures', () => {
  const calibration = sample(0), current = reading(0);
  assert.equal(calibratedGroupFixFreshness(point(at - 19_999), calibration, current), 'fresh');
  assert.equal(calibratedGroupFixFreshness(point(at - 20_000), calibration, current), 'stale');
  assert.equal(calibratedGroupFixFreshness(point(at - 59_999), calibration, current), 'offline');
  assert.equal(calibratedGroupFixFreshness(point(at - 299_999, at), calibration, current), 'hidden');
  assert.equal(calibratedGroupFixFreshness(point(at + 1000), calibration, current), 'hidden');
  const fix = Object.freeze(point(at - 20_000, at));
  assert.equal(calibratedGroupFixFreshness(fix, sample(2000), reading(2000)), 'stale');
  const next = clock.sampleServerClock(reading(20_000), reading(20_100), at + 20_000);
  assert.equal(calibratedGroupFixFreshness(fix, next, reading(20_100)), 'stale');
  assert.equal(fix.capturedAt, at - 20_000);
  assert.equal(calibratedGroupFixFreshness(point(NaN), calibration, current), 'hidden');
});
test('session clock GET uses bearer identity, no request body and includes JSON processing in RTT', async () => {
  let elapsed = 0, received;
  const api = createGroupSessionClient('https://groups.example.test', async (url, options) => {
    received = { url, options }; elapsed = 80;
    return { ok: true, json: async () => { elapsed = 100; return { userId: 'synthetic-user', serverTime: at, expiresAt: at + 120_000 }; } };
  });
  const calibration = await api.sampleClock('synthetic', { id: 'synthetic-user' }, () => reading(elapsed));
  assert.equal(calibration.roundTripMs, 100); assert.equal(calibration.serverTimeMs, at);
  assert.equal(received.url, 'https://groups.example.test/v1/session');
  assert.equal(received.options.method, 'GET'); assert.equal(received.options.body, undefined);
  assert.deepEqual(received.options.headers, { Authorization: 'Bearer synthetic' });
});
test('invalid status identity/expiry/time cannot calibrate and does not prevent capability logout', async () => {
  for (const body of [null, { userId: 'other' }, { userId: 'synthetic-user' },
    { userId: 'synthetic-user', serverTime: at, expiresAt: at },
    { userId: 'synthetic-user', serverTime: '1000000', expiresAt: at + 1000 },
    { userId: 'synthetic-user', serverTime: at, expiresAt: at + 50 },
  ]) {
    let reads = 0;
    const api = createGroupSessionClient('https://groups.example.test', async (_url, options) => ({ ok: true, json: async () => options.method === 'GET' ? body : { revoked: true } }));
    await assert.rejects(api.sampleClock('synthetic', { id: 'synthetic-user' }, () => reading(reads++ * 100)));
    await api.revokeWithSecret('a'.repeat(64));
  }
});
test('status 401/403 require sign-in, 429/503 do not; logout remains independent', async () => {
  for (const status of [401, 403, 429, 503]) {
    const api = createGroupSessionClient('https://groups.example.test', async (_url, options) => options.method === 'GET'
      ? { ok: false, status } : { ok: true, json: async () => ({ revoked: true }) });
    await assert.rejects(api.sampleClock('synthetic', { id: 'synthetic-user' }, () => reading(0)), (error) => (error instanceof core.SessionExpiredError) === (status === 401 || status === 403));
    await api.revokeWithSecret('a'.repeat(64));
  }
});
test('status timeout bounds stalled JSON parsing even if transport ignores abort; no sample is returned', async () => {
  let trigger, signal, reads = 0, cleared = false;
  const { createGroupSessionClient: client } = load('src/services/auth/groupSessions.ts', imports, {
    setTimeout: (fn, duration) => { assert.equal(duration, 10_000); trigger = fn; return 1; }, clearTimeout: () => { cleared = true; },
  });
  const api = client('https://groups.example.test', async (_url, options) => { signal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; });
  const pending = api.sampleClock('synthetic', { id: 'synthetic-user' }, () => { reads++; return reading(0); });
  await new Promise((resolve) => setImmediate(resolve)); trigger();
  await assert.rejects(pending, /timed out/); assert.equal(signal.aborted, true); assert.equal(reads, 1); assert.equal(cleared, true);
});

test('actual session handler status response calibrates only after its existing budget and live registry checks', async () => {
  const { createSessionApi } = await import('../services/group-rides/src/sessionApi.mjs');
  const { AccountRateLimitedError } = await import('../services/group-rides/src/accountBudget.mjs');
  const calls = []; let blocked = false;
  const api = createSessionApi({ now: () => at,
    verifyToken: async () => { calls.push('verify'); return { userId: 'synthetic-user', sessionId: 'synthetic-family', expiresAt: at + 120_000 }; },
    consumeAccountBudget: async (operation, user) => { calls.push([operation, user]); if (blocked) throw new AccountRateLimitedError(10); },
    consumeLogoutBudget: async () => {}, probeProvider: async () => assert.fail('GET probed provider'),
    registry: { active: async () => { calls.push('active'); return true; }, registerWithLogout: async () => assert.fail('GET registered'),
      admitted: async () => true, revoke: async () => {}, revokeWithLogout: async () => { calls.push('logout'); } },
  });
  const client = createGroupSessionClient('https://groups.example.test', async (url, options) => {
    const response = await api({ rawPath: new URL(url).pathname, headers: options.headers, body: options.body,
      requestContext: { http: { method: options.method, sourceIp: '192.0.2.1' } } });
    assert.equal(response.headers['Cache-Control'], 'no-store');
    return { ok: response.statusCode === 200, status: response.statusCode, json: async () => JSON.parse(response.body) };
  });
  const calibrated = await client.sampleClock('synthetic', { id: 'synthetic-user' }, () => reading(0));
  assert.equal(calibrated.serverTimeMs, at);
  assert.deepEqual(calls, ['verify', ['status', 'synthetic-user'], 'active']);
  calls.length = 0; blocked = true;
  await assert.rejects(client.sampleClock('synthetic', { id: 'synthetic-user' }, () => reading(0)));
  assert.deepEqual(calls, ['verify', ['status', 'synthetic-user']]);
  await client.revokeWithSecret('a'.repeat(64)); assert.equal(calls.at(-1), 'logout');
});
