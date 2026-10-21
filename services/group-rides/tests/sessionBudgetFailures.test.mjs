import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountBudget, AccountRateLimitedError } from '../src/accountBudget.mjs';
import { createLogoutBudget, LogoutRateLimitedError } from '../src/logoutBudget.mjs';
import { createSessionApi } from '../src/sessionApi.mjs';

// These are SDK failure controls, not a transaction emulator or DB acceptance.
const canceled = (CancellationReasons, name = 'TransactionCanceledException') =>
  Object.assign(new Error('synthetic private storage detail'), { name, CancellationReasons });
const reasons = (...codes) => codes.map((Code) => ({ Code, Message: 'synthetic private reason' }));
const conditionalCases = [
  ['global condition', reasons('ConditionalCheckFailed', 'None')],
  ['account/source condition', reasons('None', 'ConditionalCheckFailed')],
  ['both conditions', reasons('ConditionalCheckFailed', 'ConditionalCheckFailed')],
];
const nonconditionalCases = [
  ...['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError', 'ValidationError', 'ItemCollectionSizeLimitExceeded'].flatMap((code) => [
    [`global ${code}`, canceled(reasons(code, 'None'))],
    [`account/source ${code}`, canceled(reasons('None', code))],
  ]),
  ['all None', canceled(reasons('None', 'None'))],
  ['unknown reason', canceled(reasons('FutureFailure', 'None'))],
  ['wrong exception name', canceled(reasons('ConditionalCheckFailed', 'None'), 'ValidationException')],
  ...['TimeoutError', 'ThrottlingException', 'TransactionInProgressException', 'AccessDeniedException', 'ResourceNotFoundException'].map((name) => [name, canceled(undefined, name)]),
  ['plain Error', new Error('synthetic private storage detail')],
  ['non-Error rejection', 'synthetic private storage detail'],
  ['null rejection', null],
  ['undefined rejection', undefined],
];
const malformedCases = [
  ['missing reasons', undefined], ['null reasons', null], ['empty reasons', []],
  ['string reasons', 'ConditionalCheckFailed'], ['object reasons', { Code: 'ConditionalCheckFailed' }],
  ['null item', [null]], ['undefined item', [undefined]], ['empty item', [{}]],
  ['wrong code type', [{ Code: ['ConditionalCheckFailed'] }]],
  ['wrong code case', [{ Code: 'conditionalcheckfailed' }]],
  ['message alone', [{ Message: 'ConditionalCheckFailed' }]],
];
const variants = [
  { name: 'account', create: createAccountBudget, args: ['logout', 'synthetic-subject'], Limited: AccountRateLimitedError },
  { name: 'logout', create: createLogoutBudget, args: ['192.0.2.1'], Limited: LogoutRateLimitedError },
];
function fixture(variant, failure) {
  let sends = 0, samples = 0;
  const consume = variant.create({ tableName: 'synthetic-budget', now: () => { samples++; return 60_000; },
    client: { async send(command) {
      sends++;
      assert.equal(command.constructor.name, 'TransactWriteCommand');
      assert.equal(command.input.TransactItems.length, 2);
      throw failure;
    } },
  });
  return { consume, run: () => consume(...variant.args), sends: () => sends, samples: () => samples };
}
for (const variant of variants) {
  test(`${variant.name}: either counter condition becomes a fresh typed quota error`, async (t) => {
    for (const [label, codes] of conditionalCases) await t.test(label, async () => {
      const failure = canceled(codes), h = fixture(variant, failure);
      await assert.rejects(h.run(), (error) => {
        assert.ok(error instanceof variant.Limited);
        assert.notEqual(error, failure);
        assert.equal(error.retryAfter, 60);
        assert.equal(error.cause, undefined);
        assert.equal(error.CancellationReasons, undefined);
        assert.equal(String(error).includes('private'), false);
        return true;
      });
      assert.equal(h.sends(), 1); assert.equal(h.samples(), 2);
    });
  });
  test(`${variant.name}: nonconditional SDK failures propagate without application retries or clock resampling`, async (t) => {
    for (const [label, failure] of nonconditionalCases) await t.test(label, async () => {
      const h = fixture(variant, failure);
      await assert.rejects(h.run(), (error) => { assert.equal(error, failure); return true; });
      assert.equal(h.sends(), 1); assert.equal(h.samples(), 1);
    });
  });
  test(`${variant.name}: malformed cancellation details never grant a permit or claim a quota denial`, async (t) => {
    for (const [label, codes] of malformedCases) await t.test(label, async () => {
      const h = fixture(variant, canceled(codes));
      await assert.rejects(h.run(), (error) => !(error instanceof variant.Limited));
      assert.equal(h.sends(), 1); assert.equal(h.samples(), 1);
    });
  });
}

const routes = [
  { name: 'bootstrap', method: 'POST', operation: 'bootstrap' },
  { name: 'signed logout', method: 'DELETE', operation: 'logout' },
  { name: 'status', method: 'GET', operation: 'status' },
  { name: 'capability logout', method: 'POST', capability: true },
];
for (const route of routes) {
  test(`${route.name}: real budget storage failures stop all downstream session effects`, async (t) => {
    const cases = [
      ...conditionalCases.map(([label, codes]) => [label, canceled(codes), 429]),
      ...nonconditionalCases.map(([label, failure]) => [label, failure, 503]),
      ...malformedCases.map(([label, codes]) => [label, canceled(codes), 503]),
    ];
    for (const [label, failure, status] of cases) await t.test(label, async () => {
      const calls = [], variant = variants[route.capability ? 1 : 0], h = fixture(variant, failure);
      const effect = (name) => async () => { calls.push(name); return true; };
      const handler = createSessionApi({
        verifyToken: async () => { calls.push('verify'); return { userId: 'synthetic-subject', sessionId: 'synthetic-family', expiresAt: 120_000, authenticatedAt: 60_000 }; },
        consumeAccountBudget: async (...args) => { calls.push(['accountBudget', ...args]); await h.consume(...args); },
        consumeLogoutBudget: async (...args) => { calls.push(['logoutBudget', ...args]); await h.consume(...args); },
        probeProvider: effect('provider'),
        registry: { admitted: effect('admitted'), active: effect('active'), registerWithLogout: effect('register'),
          revoke: effect('revoke'), revokeWithLogout: effect('capabilityRevoke') },
        now: () => { throw new Error('response clock must not run'); },
      });
      const response = await handler({ rawPath: route.capability ? '/v1/session/logout' : '/v1/session',
        requestContext: { http: { method: route.method, sourceIp: '192.0.2.1' } },
        headers: { authorization: 'Bearer synthetic', 'x-forwarded-for': '192.0.2.2' },
        ...(route.method === 'POST' ? { body: JSON.stringify({ logoutSecret: 'a'.repeat(64) }) } : {}),
      });
      assert.equal(response.statusCode, status);
      const code = route.capability ? 'LOGOUT_RATE_LIMITED' : 'ACCOUNT_RATE_LIMITED';
      assert.equal(response.body, JSON.stringify({ error: status === 429 ? code : 'ACCOUNT_SERVICE_UNAVAILABLE' }));
      assert.equal(response.headers['Cache-Control'], 'no-store');
      assert.equal(response.headers['Retry-After'], status === 429 ? '60' : undefined);
      assert.deepEqual(calls, route.capability ? [['logoutBudget', '192.0.2.1']] : ['verify', ['accountBudget', route.operation, 'synthetic-subject']]);
      assert.equal(h.sends(), 1); assert.equal(h.samples(), status === 429 ? 2 : 1);
    });
  });
}
