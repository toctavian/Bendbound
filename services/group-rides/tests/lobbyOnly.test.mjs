import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomApi } from '../src/roomApi.mjs';
test('lobby-only mode refuses start, sharing and coordinate publication without calling services', async () => {
  let calls = 0;
  const handler = createRoomApi({ lobbyOnly: true, authorize: async () => { calls++; return {}; }, consumeRoomBudget: async () => { calls++; }, rooms: {} });
  for (const op of ['start', 'sharing', 'fix']) {
    const r = await handler({ rawPath: `/v1/rooms/${'a'.repeat(64)}/${op}`, requestContext: { http: { method: 'POST' } } });
    assert.equal(r.statusCode, 409); assert.equal(r.headers['Cache-Control'], 'no-store');
  }
  assert.equal(calls, 3);
});
test('lobby-only read never touches coordinate storage even if a locations adapter was passed', async () => {
  let read = false;
  const handler = createRoomApi({ lobbyOnly: true, authorize: async () => ({}), consumeRoomBudget: async () => {}, rooms: { read: async () => { read = true; return {}; } }, locations: { read: async () => { throw new Error('Must not read coordinates'); } } });
  const r = await handler({ rawPath: `/v1/rooms/${'a'.repeat(64)}`, requestContext: { http: { method: 'GET' } } });
  assert.equal(r.statusCode, 200); assert.equal(read, true);
});
