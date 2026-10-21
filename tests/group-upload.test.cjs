const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const ts = require('typescript');
function load(file, imports = {}) {
  const source = readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((name) => imports[name] ?? createRequire(resolve(file))(name), module, module.exports);
  return module.exports;
}
const contract = load('src/types/groupRide.ts');
const location = load('src/utils/groups/location.ts', { '@/types/groupRide': contract, './clock': load('src/utils/groups/clock.ts') });
const { createGroupUploader, createHttpGroupSender } = load('src/services/groupUpload.ts', { '@/types/groupRide': contract, '@/utils/groups/location': location });
const lease = { roomId: 'synthetic-room-123', deviceEpoch: 'synthetic-device-epoch', expiresAt: 2_000_000 };
const sample = (timestamp) => ({ timestamp, coords: { latitude: 0, longitude: 0, accuracy: 5 } });
test('explicit start is required; upload selects latest fix and throttles subsequent callbacks', async () => {
  let now = 1_000_000; const sent = [];
  const uploader = createGroupUploader({ now: () => now, accessToken: async () => 'synthetic-user-token', send: async (room, fix, token) => sent.push({ room, fix, token }) });
  assert.equal(await uploader.upload([sample(now)]), 'inactive'); uploader.start(lease);
  assert.equal(await uploader.upload([sample(now - 300_000), sample(now - 1000), sample(now)]), 'sent');
  assert.equal(sent[0].fix.sequence, 0); assert.equal(sent[0].fix.capturedAt, now);
  assert.equal(await uploader.upload([sample(now)]), 'throttled');
  now += 5000; assert.equal(await uploader.upload([sample(now)]), 'sent'); assert.equal(sent[1].fix.sequence, 1);
  now += 5000; assert.equal(await uploader.upload([sample(now - 5000)]), 'no-fresh-fix');
});
test('stopping while token refresh is pending prevents publication; stopping a send aborts transport', async () => {
  let refresh; let sent = 0;
  const uploader = createGroupUploader({ now: () => 1_000_000, accessToken: () => new Promise((resolve) => { refresh = resolve; }), send: async () => { sent++; } });
  uploader.start(lease); const pending = uploader.upload([sample(1_000_000)]);
  uploader.stop(); refresh('synthetic'); assert.equal(await pending, 'inactive'); assert.equal(sent, 0);
  let observedSignal, finish;
  const active = createGroupUploader({ now: () => 1_000_000, accessToken: async () => 'synthetic', send: async (_l, _f, _t, signal) => { observedSignal = signal; return new Promise((resolve) => { finish = resolve; }); } });
  active.start(lease); const sending = active.upload([sample(1_000_000)]); await new Promise((r) => setImmediate(r));
  active.stop(); assert.equal(observedSignal.aborted, true); finish(); assert.equal(await sending, 'inactive');
});
test('expiry and failed requests never enqueue historic coordinates or duplicate accepted sequence', async () => {
  let now = 1_000_000; let calls = 0;
  const uploader = createGroupUploader({ now: () => now, accessToken: async () => 'synthetic', send: async () => { calls++; throw new Error('network'); } });
  uploader.start({ ...lease, expiresAt: now + 10_000 });
  assert.equal(await uploader.upload([sample(now)]), 'failed');
  now += 5000; assert.equal(await uploader.upload([sample(now - 30_000)]), 'no-fresh-fix'); assert.equal(calls, 1);
  now += 5000; assert.equal(await uploader.upload([sample(now)]), 'inactive');
});
test('HTTP sender uses individual bearer identity and sends no body userId or pilot token', async () => {
  let received;
  assert.throws(() => createHttpGroupSender('http://example.test'), /HTTPS/);
  const send = createHttpGroupSender('https://groups.example.test', async (url, options) => { received = { url, options }; return { ok: true }; });
  await send(lease, { synthetic: true }, 'synthetic-account-token', new AbortController().signal);
  assert.equal(received.url, 'https://groups.example.test/v1/rooms/synthetic-room-123/fix');
  assert.equal(received.options.headers.Authorization, 'Bearer synthetic-account-token');
  assert.deepEqual(JSON.parse(received.options.body), { version: 1, fix: { synthetic: true } });
});

test('stop releases a callback even if token refresh never resolves', async () => {
  const uploader = createGroupUploader({ now: () => 1_000_000, accessToken: () => new Promise(() => {}), send: async () => assert.fail('unexpected send') });
  uploader.start(lease); const pending = uploader.upload([sample(1_000_000)]); uploader.stop();
  assert.equal(await pending, 'inactive');
});
test('a fix that ages out during token refresh is not published', async () => {
  let now = 1_000_000;
  const uploader = createGroupUploader({ now: () => now, accessToken: async () => { now += 10_000; return 'synthetic'; }, send: async () => assert.fail('old fix sent') });
  uploader.start(lease);
  assert.equal(await uploader.upload([sample(now - 14_000)]), 'no-fresh-fix');
});
