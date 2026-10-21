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
const core = load('src/services/auth/sessionManager.ts');
const clock = load('src/utils/groups/clock.ts');
const { createGroupSessionClient } = load('src/services/auth/groupSessions.ts', { './sessionManager': core, '@/utils/groups/clock': clock });
test('no insecure/unconfigured group API can receive account credentials', () => {
  for (const value of [undefined, '', 'http://example.test', 'https://u:p@example.test', 'https://example.test?token=bad']) assert.equal(createGroupSessionClient(value), null);
});
test('session bootstrap and logout carry only bearer proof, no client body identities', async () => {
  const requests = [];
  const api = createGroupSessionClient('https://groups.example.test', async (url, options) => {
    requests.push({ url, options }); return { ok: true, json: async () => options.method === 'POST' ? { userId: 'synthetic-user' } : { revoked: true } };
  });
  await api.register('synthetic-access', { id: 'synthetic-user', displayName: 'Rider' }, 'a'.repeat(64)); await api.revoke('synthetic-access');
  assert.equal(requests[0].url, 'https://groups.example.test/v1/session');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer synthetic-access'); assert.deepEqual(JSON.parse(requests[0].options.body), { logoutSecret: 'a'.repeat(64) });
  assert.equal(requests[1].options.method, 'DELETE');
});
test('mismatched identity and definitive rejection require a new sign-in; outages do not', async () => {
  const wrong = createGroupSessionClient('https://groups.example.test', async () => ({ ok: true, json: async () => ({ userId: 'another-user' }) }));
  await assert.rejects(wrong.register('synthetic', { id: 'synthetic-user' }, 'a'.repeat(64)), core.SessionExpiredError);
  for (const status of [401, 503]) {
    const api = createGroupSessionClient('https://groups.example.test', async () => ({ ok: false, status }));
    await assert.rejects(api.register('synthetic', { id: 'synthetic-user' }, 'a'.repeat(64)), (error) => (error instanceof core.SessionExpiredError) === (status === 401));
  }
});
test('revocation capability travels in a bounded HTTPS body without bearer proof or query tokens', async () => {
  let received;
  const api = createGroupSessionClient('https://groups.example.test', async (url, options) => { received = { url, options }; return { ok: true, json: async () => ({ revoked: true }) }; });
  await api.revokeWithSecret('b'.repeat(64));
  assert.equal(received.url, 'https://groups.example.test/v1/session/logout');
  assert.equal(received.options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(received.options.body), { logoutSecret: 'b'.repeat(64) });
});
test('capability binding uses canonical server URL and malformed secrets never leave the device', async () => {
  let calls = 0;
  const api = createGroupSessionClient('https://groups.example.test/', async () => { calls++; return {}; });
  assert.equal(api.baseUrl, 'https://groups.example.test');
  for (const value of [undefined, '', 'too-short', 'x'.repeat(64)]) {
    await assert.rejects(api.revokeWithSecret(value));
    await assert.rejects(api.register('synthetic', { id: 'synthetic-user' }, value));
  }
  assert.equal(calls, 0);
});
