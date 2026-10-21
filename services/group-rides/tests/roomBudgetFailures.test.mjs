import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoomBudget, RoomRateLimitedError } from '../src/roomBudget.mjs';
import { createRoomApi } from '../src/roomApi.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';

// Synthetic SDK controls only: these do not emulate transactional DB semantics.
const canceled = (CancellationReasons, name = 'TransactionCanceledException') =>
  Object.assign(new Error('synthetic private storage detail'), { name, CancellationReasons });
const reasons = (...codes) => codes.map((Code) => ({ Code, Message: 'synthetic private reason' }));
const conditionalCases = [
  ['global condition', reasons('ConditionalCheckFailed', 'None')],
  ['account condition', reasons('None', 'ConditionalCheckFailed')],
  ['both conditions', reasons('ConditionalCheckFailed', 'ConditionalCheckFailed')],
];
const nonconditionalCases = [
  ...['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError', 'ValidationError', 'ItemCollectionSizeLimitExceeded'].flatMap((code) => [
    [`global ${code}`, canceled(reasons(code, 'None'))],
    [`account ${code}`, canceled(reasons('None', code))],
  ]),
  ['all None', canceled(reasons('None', 'None'))],
  ['unknown reason', canceled(reasons('FutureFailure', 'None'))],
  ['wrong exception name', canceled(reasons('ConditionalCheckFailed', 'None'), 'ValidationException')],
  ...['TimeoutError', 'ThrottlingException', 'TransactionInProgressException', 'AccessDeniedException', 'ResourceNotFoundException'].map((name) => [name, canceled(undefined, name)]),
  ['plain Error', new Error('synthetic private storage detail')],
  ['string rejection', 'synthetic private storage detail'], ['null rejection', null], ['undefined rejection', undefined],
];
const malformedCases = [
  ['missing reasons', undefined], ['null reasons', null], ['empty reasons', []],
  ['string reasons', 'ConditionalCheckFailed'], ['object reasons', { Code: 'ConditionalCheckFailed' }],
  ['null item', [null]], ['undefined item', [undefined]], ['empty item', [{}]],
  ['wrong code type', [{ Code: ['ConditionalCheckFailed'] }]],
  ['wrong code case', [{ Code: 'conditionalcheckfailed' }]],
  ['message alone', [{ Message: 'ConditionalCheckFailed' }]],
];
const failures = [
  ...conditionalCases.map(([label, codes]) => [label, canceled(codes), 429]),
  ...nonconditionalCases.map(([label, failure]) => [label, failure, 503]),
  ...malformedCases.map(([label, codes]) => [label, canceled(codes), 503]),
];
function budget(failure) {
  let sends = 0, samples = 0;
  const consume = createRoomBudget({ tableName: 'synthetic-room-budget',
    now: () => { samples++; return 60_000; }, client: { async send(command) {
      sends++;
      assert.equal(command.constructor.name, 'TransactWriteCommand');
      assert.equal(command.input.TransactItems.length, 2);
      throw failure;
    } },
  });
  return { consume, sends: () => sends, samples: () => samples };
}
test('room adapter classifies either counter condition without retaining private storage details', async (t) => {
  for (const [label, codes] of conditionalCases) await t.test(label, async () => {
    const failure = canceled(codes), h = budget(failure);
    await assert.rejects(h.consume('fix', 'synthetic-subject'), (error) => {
      assert.ok(error instanceof RoomRateLimitedError);
      assert.notEqual(error, failure); assert.equal(error.retryAfter, 60);
      assert.equal(error.cause, undefined); assert.equal(error.CancellationReasons, undefined);
      assert.equal(String(error).includes('private'), false);
      return true;
    });
    assert.equal(h.sends(), 1); assert.equal(h.samples(), 2);
  });
});
test('room adapter propagates nonconditional failures without application retry or completion-clock sampling', async (t) => {
  for (const [label, failure] of nonconditionalCases) await t.test(label, async () => {
    const h = budget(failure);
    await assert.rejects(h.consume('fix', 'synthetic-subject'), (error) => { assert.equal(error, failure); return true; });
    assert.equal(h.sends(), 1); assert.equal(h.samples(), 1);
  });
});
test('malformed room cancellation details cannot grant a permit or claim quota denial', async (t) => {
  for (const [label, codes] of malformedCases) await t.test(label, async () => {
    const h = budget(canceled(codes));
    await assert.rejects(h.consume('fix', 'synthetic-subject'), (error) => !(error instanceof RoomRateLimitedError));
    assert.equal(h.sends(), 1); assert.equal(h.samples(), 1);
  });
});

const id = 'a'.repeat(64);
const event = (method, suffix, input = {}) => ({ rawPath: `/v1/rooms${suffix}`,
  headers: { authorization: 'Bearer synthetic' }, requestContext: { http: { method } }, body: JSON.stringify(input) });
const protectedRoutes = [
  ['create', event('POST', '', { command: {}, title: 'Ride' })],
  ['redeem', event('POST', `/${id}/members`, { inviteToken: 'synthetic-capability' })],
  ['fix', event('PUT', `/${id}/fix`, { version: 1, fix: {} })],
  ['snapshot', event('GET', `/${id}`)],
  ['invite', event('POST', `/${id}/invites`)],
  ['control', event('POST', `/${id}/start`, { command: {} })],
  ['control', event('PUT', `/${id}/profile`, { command: {}, displayName: 'Rider' })],
  ['control', event('PUT', `/${id}/sharing`, { command: {}, enabled: true })],
];
const safetyRoutes = [
  ['sharing', event('PUT', `/${id}/sharing`, { command: {}, enabled: false })],
  ['leave', event('DELETE', `/${id}/members/me`, { command: {} })],
  ['remove', event('DELETE', `/${id}/members/synthetic-member`, { command: {} })],
  ['end', event('POST', `/${id}/end`, { command: {} })],
];
const actor = Object.freeze({ userId: 'synthetic-verified-subject', sessionId: 'synthetic-family' });
function api(failure, { denied = false, fallback = false } = {}) {
  const h = budget(failure), calls = [];
  const effect = (name) => async (...args) => { calls.push([name, ...args]); return {}; };
  const handler = createRoomApi({
    authorize: async (header) => {
      calls.push(['authorize', header]);
      if (denied) throw new UnauthorizedError();
      return actor;
    },
    consumeRoomBudget: async (...args) => { calls.push(['budget', ...args]); await h.consume(...args); },
    rooms: Object.fromEntries(['create', 'join', 'read', 'invite', 'start', 'updateProfile', 'sharing', 'remove', 'leave', 'end'].map((name) => [name, effect(name)])),
    locations: fallback ? undefined : { publish: effect('publish'), read: effect('locationRead') },
  });
  return { ...h, handler, calls };
}
for (const [index, [operation, request]] of protectedRoutes.entries()) {
  test(`protected room route ${index + 1} (${operation}) denies effects after real adapter failures`, async (t) => {
    for (const [label, failure, status] of failures) await t.test(label, async () => {
      const h = api(failure), response = await h.handler(request);
      assert.equal(response.statusCode, status);
      assert.equal(response.body, JSON.stringify({ error: status === 429 ? 'ROOM_RATE_LIMITED' : 'GROUP_SERVICE_UNAVAILABLE' }));
      assert.equal(response.headers['Cache-Control'], 'no-store');
      assert.equal(response.headers['Retry-After'], status === 429 ? '60' : undefined);
      assert.deepEqual(h.calls, [['authorize', 'Bearer synthetic'], ['budget', operation, actor.userId]]);
      assert.equal(h.sends(), 1); assert.equal(h.samples(), status === 429 ? 2 : 1);
    });
  });
}
test('room-only snapshot fallback retains actual budget rejection', async (t) => {
  for (const [label, failure, status] of failures) await t.test(label, async () => {
    const h = api(failure, { fallback: true }), response = await h.handler(event('GET', `/${id}`));
    assert.equal(response.statusCode, status);
    assert.deepEqual(h.calls, [['authorize', 'Bearer synthetic'], ['budget', 'snapshot', actor.userId]]);
    assert.equal(h.sends(), 1);
  });
});
test('safety actions bypass a failing actual budget but retain authorization and actor forwarding', async (t) => {
  for (const [label, failure] of failures) await t.test(label, async () => {
    for (const [name, request] of safetyRoutes) {
      const h = api(failure), response = await h.handler(request);
      assert.equal(response.statusCode, 200);
      const args = [actor, id, {}];
      if (name === 'sharing') args.push(false);
      if (name === 'remove') args.push('synthetic-member');
      assert.deepEqual(h.calls, [['authorize', 'Bearer synthetic'], [name, ...args]]);
      assert.equal(h.sends(), 0); assert.equal(h.samples(), 0);
      const denied = api(failure, { denied: true }), rejection = await denied.handler(request);
      assert.equal(rejection.statusCode, 401);
      assert.equal(rejection.body, JSON.stringify({ error: 'UNAUTHORIZED' }));
      assert.equal(rejection.headers['Cache-Control'], 'no-store');
      assert.deepEqual(denied.calls, [['authorize', 'Bearer synthetic']]);
      assert.equal(denied.sends(), 0); assert.equal(denied.samples(), 0);
    }
  });
});
