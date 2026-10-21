const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript'), fs = require('node:fs');
const mod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(fs.readFileSync('src/services/groups/client.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(mod, mod.exports);
const { createRoomClient, groupInviteLink, parseGroupInvite } = mod.exports;
const id = 'a'.repeat(64), token = 'b'.repeat(43), route = 'c'.repeat(32);
const room = { version: 1, id, state: 'lobby', title: 'Ride', expiresAt: Date.now() + 60000, members: [{ userId: 'verified-sub', displayName: 'Name', role: 'owner', motorcycleType: 'sports' }] };
test('invite fragments roundtrip without query credentials; reject other hosts/rooms and invalid capabilities', () => {
  const link = groupInviteLink(id, token, route);
  assert.equal(new URL(link).search, '');
  assert.deepEqual(parseGroupInvite(link, id), { token, routeId: route });
  for (const bad of [link.replace('bendbound:', 'https:'), link.replace('/group/', '/else/'), link.replace(id, 'd'.repeat(64)), `bendbound://group/${id}?invite=${token}`, `bendbound://group/${id}#invite=short`]) assert.equal(parseGroupInvite(bad, id), null);
});
test('room client uses live bearer proof, no-store/redirect rejection, and POST-body invite capabilities', async () => {
  const calls = [];
  const c = createRoomClient('https://groups.example.test', async () => 'verified-access', async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ room }) }; });
  await c.join(id, token, 'Name', 'sports');
  assert.equal(calls[0].url.includes(token), false);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer verified-access');
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(JSON.parse(calls[0].options.body).inviteToken, token);
  assert.equal(JSON.parse(calls[0].options.body).userId, undefined);
});
test('account/invite denials do not yield successful room state', async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const c = createRoomClient('https://groups.example.test', async () => 'proof', async () => ({ ok: false, status, json: async () => ({ error: 'ROOM_UNAVAILABLE' }) }));
    await assert.rejects(c.read(id));
  }
  for (const endpoint of ['http://groups.test', 'https://u:p@groups.test', 'https://groups.test?q=x', 'https://groups.test/path']) assert.equal(createRoomClient(endpoint, async () => ''), null);
});
