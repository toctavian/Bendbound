import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoomApi } from '../src/roomApi.mjs';
import { createRoomService, RoomError } from '../src/rooms.mjs';
import { RoomRateLimitedError } from '../src/roomBudget.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';

// Only synthetic fixtures: never use captured requests, capabilities or positions.
const sentinel = 'SYNTHETIC_PRIVATE_CONTROL_ERROR';
const id = 'a'.repeat(64);
const at = 1_000_000;
const principal = { userId: 'synthetic-owner', sessionId: 'synthetic-family', expiresAt: at + 60_000 };
const command = { id: '00000000-0000-4000-8000-000000000001', createdAt: at };
const profile = { displayName: sentinel, motorcycleType: 'adventure' };
const routes = [
  { name: 'create', method: 'POST', path: '/v1/rooms', operation: 'create', budget: 'create', input: { command, title: sentinel, ...profile }, denial: ['INVALID_ROOM', 400] },
  { name: 'invite', method: 'POST', suffix: '/invites', operation: 'invite', budget: 'invite', input: {}, denial: ['OWNER_REQUIRED', 403] },
  { name: 'redeem', method: 'POST', suffix: '/members', operation: 'join', budget: 'redeem', input: { inviteToken: 's'.repeat(43), ...profile }, denial: ['INVITE_UNAVAILABLE', 404] },
  { name: 'start', method: 'POST', suffix: '/start', operation: 'start', budget: 'control', input: { command }, denial: ['ROUTE_UNAVAILABLE', 409] },
  { name: 'end', method: 'POST', suffix: '/end', operation: 'end', input: { command }, denial: ['OWNER_REQUIRED', 403] },
  { name: 'enable sharing', method: 'PUT', suffix: '/sharing', operation: 'sharing', budget: 'control', input: { command, enabled: true }, denial: ['ROOM_UNAVAILABLE', 404] },
  { name: 'stop sharing', method: 'PUT', suffix: '/sharing', operation: 'sharing', input: { command, enabled: false }, denial: ['ROOM_BUSY', 429] },
  { name: 'profile', method: 'PUT', suffix: '/profile', operation: 'updateProfile', budget: 'control', input: { command, ...profile }, denial: ['COMMAND_CONFLICT', 409] },
  { name: 'leave', method: 'DELETE', suffix: '/members/me', operation: 'leave', input: { command }, denial: ['ROOM_UNAVAILABLE', 404] },
  { name: 'remove', method: 'DELETE', suffix: '/members/synthetic-member', operation: 'remove', input: { command }, denial: ['OWNER_MUST_LEAVE', 400] },
];
const request = (route) => ({ rawPath: route.path ?? `/v1/rooms/${id}${route.suffix}`,
  requestContext: { http: { method: route.method } }, headers: { authorization: `Bearer ${sentinel}` }, body: JSON.stringify(route.input) });
function privateError(error) {
  error.message = sentinel;
  error.stack = sentinel;
  return Object.assign(error, { cause: new Error(sentinel), request: { authorization: sentinel }, inviteToken: sentinel, retryAfter: sentinel });
}
function responseIs(response, statusCode, code, retryAfter) {
  assert.deepEqual(response, { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) }) }, body: JSON.stringify({ error: code }) });
  assert.equal(JSON.stringify(response).includes(sentinel), false);
}
function fixture(route, error, failBudget = false) {
  const calls = [];
  const handler = createRoomApi({
    authorize: async () => { calls.push('authorize'); return principal; },
    consumeRoomBudget: async (...args) => { calls.push(['budget', ...args]); if (failBudget) throw error; },
    rooms: { [route.operation]: async (actor, ...args) => {
      calls.push(route.operation);
      assert.equal(actor, principal);
      if (route.operation !== 'create') assert.equal(args[0], id);
      if (route.operation === 'remove') assert.equal(args[2], 'synthetic-member');
      throw error;
    } },
  });
  return { handler, calls };
}

for (const route of routes) {
  const expectedCalls = ['authorize', ...(route.budget ? [['budget', route.budget, principal.userId]] : []), route.operation];
  test(`${route.name}: unexpected service failures redact all private error fields`, async () => {
    const h = fixture(route, privateError(new Error()));
    responseIs(await h.handler(request(route)), 503, 'GROUP_SERVICE_UNAVAILABLE');
    assert.deepEqual(h.calls, expectedCalls); // Exactly one service attempt; no hidden retry.
  });
  test(`${route.name}: typed denial exposes only its public code and status`, async () => {
    const [code, status] = route.denial;
    const h = fixture(route, privateError(new RoomError(code, status)));
    responseIs(await h.handler(request(route)), status, code);
    assert.deepEqual(h.calls, expectedCalls);
  });
  test(`${route.name}: service session denial remains a generic unauthorized response`, async () => {
    const h = fixture(route, privateError(new UnauthorizedError()));
    responseIs(await h.handler(request(route)), 401, 'UNAUTHORIZED');
    assert.deepEqual(h.calls, expectedCalls);
  });
  if (route.budget) {
    test(`${route.name}: typed budget denial omits private fields and prevents service effects`, async () => {
      const error = privateError(new RoomRateLimitedError(1));
      // The real budget emits bounded integers; private error metadata is unrelated.
      error.retryAfter = 17;
      const h = fixture(route, error, true);
      responseIs(await h.handler(request(route)), 429, 'ROOM_RATE_LIMITED', 17);
      assert.deepEqual(h.calls, expectedCalls.slice(0, -1));
    });
  }
}

test('all control routes recheck revoked sessions in the real room service, including safety actions', async (t) => {
  for (const route of routes) await t.test(route.name, async () => {
    let checks = 0;
    const calls = [];
    const unexpectedStore = async () => { calls.push('store'); throw new Error('Storage must not run after denial.'); };
    const rooms = createRoomService({ now: () => at, sessionActive: async (context) => {
      checks++;
      assert.deepEqual(context, { subject: principal.userId, familyId: principal.sessionId, expiresAt: principal.expiresAt });
      return false;
    }, store: { read: unexpectedStore, create: unexpectedStore, replace: unexpectedStore } });
    const handler = createRoomApi({ rooms, authorize: async () => principal,
      consumeRoomBudget: async (...args) => { calls.push(['budget', ...args]); } });
    responseIs(await handler(request(route)), 401, 'UNAUTHORIZED');
    assert.equal(checks, 1);
    assert.deepEqual(calls, route.budget ? [['budget', route.budget, principal.userId]] : []);
  });
});
