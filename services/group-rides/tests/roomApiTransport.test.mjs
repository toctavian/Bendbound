import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoomApi } from '../src/roomApi.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';

// Synthetic fixtures only; transport tests deliberately do not validate domain input.
const sentinel = 'SYNTHETIC_PRIVATE_TRANSPORT_VALUE';
const id = 'a'.repeat(64);
const principal = { userId: 'synthetic-subject', sessionId: 'synthetic-family' };
const command = { id: '00000000-0000-4000-8000-000000000001', createdAt: 1_000_000 };
const routes = [
  { name: 'create', method: 'POST', path: '/v1/rooms', effect: 'create', budget: 'create', input: { command, title: 'Synthetic ride', displayName: 'Rider' }, status: 201 },
  { name: 'snapshot', method: 'GET', effect: 'read', budget: 'snapshot', input: {} },
  { name: 'invite', method: 'POST', suffix: '/invites', effect: 'invite', budget: 'invite', input: {} },
  { name: 'redeem', method: 'POST', suffix: '/members', effect: 'join', budget: 'redeem', input: { inviteToken: sentinel, displayName: 'Rider' } },
  { name: 'start', method: 'POST', suffix: '/start', effect: 'start', budget: 'control', input: { command } },
  { name: 'end', method: 'POST', suffix: '/end', effect: 'end', input: { command } },
  { name: 'sharing on', method: 'PUT', suffix: '/sharing', effect: 'sharing', budget: 'control', input: { command, enabled: true } },
  { name: 'sharing off', method: 'PUT', suffix: '/sharing', effect: 'sharing', input: { command, enabled: false } },
  { name: 'profile', method: 'PUT', suffix: '/profile', effect: 'updateProfile', budget: 'control', input: { command, displayName: 'Rider', motorcycleType: 'adventure' } },
  { name: 'leave', method: 'DELETE', suffix: '/members/me', effect: 'leave', input: { command } },
  { name: 'remove', method: 'DELETE', suffix: '/members/synthetic-member', effect: 'remove', input: { command } },
  { name: 'fix', method: 'PUT', suffix: '/fix', effect: 'publish', budget: 'fix', input: { version: 1, fix: {} } },
];
const request = (route, overrides = {}) => ({ rawPath: route.path ?? `/v1/rooms/${id}${route.suffix ?? ''}`,
  requestContext: { http: { method: route.method } }, headers: { authorization: `Bearer ${sentinel}` },
  body: JSON.stringify(route.input), ...overrides });
function fixture({ unauthorized = false, snapshotFallback = false } = {}) {
  const calls = [];
  const effect = (name) => async (...args) => { calls.push([name, ...args]); return {}; };
  const handler = createRoomApi({
    authorize: async () => { calls.push(['authorize']); if (unauthorized) throw new UnauthorizedError(); return principal; },
    consumeRoomBudget: async (...args) => { calls.push(['budget', ...args]); },
    rooms: Object.fromEntries(['create', 'read', 'invite', 'join', 'start', 'end', 'sharing', 'updateProfile', 'leave', 'remove'].map((name) => [name, effect(name)])),
    locations: snapshotFallback ? undefined : { read: effect('read'), publish: effect('publish') },
  });
  return { handler, calls };
}
function denied(response, code = 'INVALID_BODY', statusCode = 400) {
  assert.deepEqual(response, { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify({ error: code }) });
  assert.equal(JSON.stringify(response).includes(sentinel), false);
}
const malformed = [
  ['truncated JSON', '{'], ['trailing JSON', `{}${sentinel}`], ['null', 'null'], ['array', '[]'],
  ['string', JSON.stringify(sentinel)], ['number', '1'], ['boolean', 'false'],
  ['non-string object', { private: sentinel }], ['non-string buffer', Buffer.from('{}')],
  ['oversized raw JSON', `${' '.repeat(11_999)}{}`],
];

for (const route of routes) {
  test(`${route.name}: query capabilities are rejected before authentication or effects`, async () => {
    for (const rawQueryString of [`inviteToken=${sentinel}`, `authorization=${sentinel}`, '%69nviteToken=synthetic', 'unknown=']) {
      const h = fixture();
      denied(await h.handler(request(route, { rawQueryString })), 'INVALID_REQUEST');
      assert.deepEqual(h.calls, []);
    }
  });
  test(`${route.name}: malformed and non-object bodies cannot spend budget or call services`, async (t) => {
    for (const [name, body] of malformed) await t.test(name, async () => {
      const h = fixture();
      denied(await h.handler(request(route, { body })));
      assert.deepEqual(h.calls, [['authorize']]);
    });
  });
  test(`${route.name}: unknown identity and capability fields are rejected in raw and encoded JSON`, async () => {
    for (const key of ['userId', 'sessionId', 'authorization', 'unknown', '__proto__', ...(route.name === 'redeem' ? [] : ['inviteToken'])]) {
      const raw = JSON.stringify({ ...route.input, [key]: sentinel });
      for (const encoded of [false, true]) {
        const h = fixture();
        denied(await h.handler(request(route, { body: encoded ? Buffer.from(raw).toString('base64') : raw, isBase64Encoded: encoded })));
        assert.deepEqual(h.calls, [['authorize']]);
      }
    }
  });
  test(`${route.name}: decoded malformed bodies and oversized encoded envelopes are rejected`, async () => {
    for (const body of [Buffer.from('{').toString('base64'), Buffer.from('null').toString('base64'),
      Buffer.from('[]').toString('base64'), '!!!!', Buffer.from(`${' '.repeat(9_000)}{}`).toString('base64')]) {
      const h = fixture();
      denied(await h.handler(request(route, { body, isBase64Encoded: true })));
      assert.deepEqual(h.calls, [['authorize']]);
    }
  });
  test(`${route.name}: authentication denial precedes body parsing and budget`, async () => {
    const h = fixture({ unauthorized: true });
    denied(await h.handler(request(route, { body: '{' })), 'UNAUTHORIZED', 401);
    assert.deepEqual(h.calls, [['authorize']]);
  });
  test(`${route.name}: valid raw and base64 JSON preserve inputs and safety-action budget exemptions`, async () => {
    for (const isBase64Encoded of [false, true]) {
      const h = fixture();
      const raw = JSON.stringify(route.input);
      const response = await h.handler(request(route, { body: isBase64Encoded ? Buffer.from(raw).toString('base64') : raw, isBase64Encoded, rawQueryString: '' }));
      assert.equal(response.statusCode, route.status ?? 200);
      assert.deepEqual(h.calls.slice(0, -1), [['authorize'], ...(route.budget ? [['budget', route.budget, principal.userId]] : [])]);
      const [effect, actor, ...args] = h.calls.at(-1);
      assert.equal(effect, route.effect);
      assert.equal(actor, principal);
      assert.deepEqual(args, route.effect === 'create' ? [command, { title: 'Synthetic ride', displayName: 'Rider' }]
        : route.effect === 'join' ? [id, sentinel, route.input]
          : route.effect === 'sharing' ? [id, command, route.input.enabled]
            : route.effect === 'updateProfile' ? [id, command, route.input]
              : route.effect === 'publish' ? [id, route.input]
                : route.effect === 'remove' ? [id, command, 'synthetic-member']
                  : ['start', 'end', 'leave'].includes(route.effect) ? [id, command] : [id]);
    }
  });
}

test('snapshot fallback retains transport rejection and accepts absent/empty bodies', async () => {
  const route = routes.find(({ name }) => name === 'snapshot');
  for (const body of [undefined, null, '', '{}']) {
    const h = fixture({ snapshotFallback: true });
    assert.equal((await h.handler(request(route, { body }))).statusCode, 200);
    assert.deepEqual(h.calls, [['authorize'], ['budget', 'snapshot', principal.userId], ['read', principal, id]]);
  }
  const h = fixture({ snapshotFallback: true });
  denied(await h.handler(request(route, { body: JSON.stringify({ inviteToken: sentinel }) })));
  assert.deepEqual(h.calls, [['authorize']]);
});
