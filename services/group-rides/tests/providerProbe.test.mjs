import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { createProviderProbe } from '../src/providerProbe.mjs';

const token = 'synthetic-access-token';
const subject = 'synthetic-subject';
const privateText = 'SYNTHETIC_PRIVATE_PROVIDER_ERROR';
const validResponse = () => ({ UserAttributes: [{ Name: 'sub', Value: subject }] });

function denied(error) {
  assert.equal(error.constructor, UnauthorizedError);
  assert.equal(error.status, 401);
  assert.equal(error.message, 'Account access is not authorised.');
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes(privateText), false);
  return true;
}
function unavailable(error) {
  assert.equal(error.constructor, Error);
  assert.equal(error.status, undefined);
  assert.equal(error.message, 'Account provider is temporarily unavailable.');
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes(privateText), false);
  return true;
}
function privateError(name) {
  return Object.assign(new Error(privateText, { cause: new Error(privateText) }), {
    name, request: { authorization: privateText },
  });
}
function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const schedule = t.mock.method(globalThis, 'setTimeout');
  const clear = t.mock.method(globalThis, 'clearTimeout');
  return {
    assertCleared() {
      assert.equal(schedule.mock.callCount(), 1);
      assert.equal(schedule.mock.calls[0].arguments[1], 8000);
      assert.equal(clear.mock.callCount(), 1);
      assert.equal(clear.mock.calls[0].arguments[0], schedule.mock.calls[0].result);
    },
  };
}

for (const client of [undefined, null, {}, { send: null }, { send: false }]) {
  test(`unconfigured client fails synchronously (${JSON.stringify(client)})`, () => {
    assert.throws(() => createProviderProbe(client), {
      name: 'Error', message: 'Provider verification must be configured.',
    });
  });
}

test('GetUser forwards only the supplied token and binds the verified subject, not username/email', async (t) => {
  const timer = clock(t);
  let signal;
  let calls = 0;
  const client = {
    async send(command, options) {
      calls++;
      assert.equal(this, client);
      assert.ok(command instanceof GetUserCommand);
      assert.deepEqual(command.input, { AccessToken: token });
      assert.deepEqual(Object.keys(options), ['abortSignal']);
      signal = options.abortSignal;
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      return { Username: 'different-username', UserAttributes: [
        { Name: 'email', Value: 'synthetic@example.invalid' },
        { Name: 'sub', Value: subject },
      ] };
    },
  };
  assert.equal(await createProviderProbe(client)(token, subject), undefined);
  assert.equal(calls, 1);
  timer.assertCleared();
  t.mock.timers.tick(8000);
  assert.equal(signal.aborted, false, 'settled probe must cancel its deadline');
});

const denials = [
  ['absent attributes', {}],
  ['null attributes', { UserAttributes: null }],
  ['empty attributes', { UserAttributes: [] }],
  ['username alone', { Username: subject }],
  ['email is not a subject', { UserAttributes: [{ Name: 'email', Value: subject }] }],
  ['wrong case', { UserAttributes: [{ Name: 'Sub', Value: subject }] }],
  ['missing value', { UserAttributes: [{ Name: 'sub' }] }],
  ['null value', { UserAttributes: [{ Name: 'sub', Value: null }] }],
  ['empty value', { UserAttributes: [{ Name: 'sub', Value: '' }] }],
  ['numeric value', { UserAttributes: [{ Name: 'sub', Value: 123 }] }],
  ['other subject', { UserAttributes: [{ Name: 'sub', Value: 'synthetic-other-subject' }] }],
  ['no subject normalization', { UserAttributes: [{ Name: 'sub', Value: ` ${subject} ` }] }],
];
for (const [label, response] of denials) {
  test(`subject denial: ${label}`, async (t) => {
    const timer = clock(t);
    let signal;
    const probe = createProviderProbe({ send: async (_, options) => {
      signal = options.abortSignal;
      return response;
    } });
    await assert.rejects(probe(token, subject), denied);
    timer.assertCleared();
    t.mock.timers.tick(8000);
    assert.equal(signal.aborted, false);
  });
}

for (const [label, response] of [
  ['undefined response', undefined], ['null response', null],
  ['non-array attributes', { UserAttributes: {} }],
  ['string attributes', { UserAttributes: privateText }],
  ['null attribute', { UserAttributes: [null] }],
]) {
  test(`malformed provider result fails closed as unavailable: ${label}`, async (t) => {
    const timer = clock(t);
    const probe = createProviderProbe({ send: async () => response });
    await assert.rejects(probe(token, subject), unavailable);
    timer.assertCleared();
  });
}

for (const name of ['NotAuthorizedException', 'UserNotFoundException', 'PasswordResetRequiredException']) {
  test(`provider revocation classification: ${name}`, async (t) => {
    const timer = clock(t);
    const original = privateError(name);
    const probe = createProviderProbe({ send: async () => { throw original; } });
    await assert.rejects(probe(token, subject), (error) => {
      assert.notEqual(error, original);
      return denied(error);
    });
    timer.assertCleared();
  });
}

for (const name of ['TooManyRequestsException', 'InternalErrorException', 'ResourceNotFoundException',
  'ForbiddenException', 'InvalidParameterException', 'AbortError', 'TimeoutError', 'Error']) {
  test(`provider outage classification: ${name}`, async (t) => {
    const timer = clock(t);
    const original = privateError(name);
    const probe = createProviderProbe({ send: async () => { throw original; } });
    await assert.rejects(probe(token, subject), (error) => {
      assert.notEqual(error, original);
      return unavailable(error);
    });
    timer.assertCleared();
  });
}

for (const value of [null, undefined, privateText]) {
  test(`non-Error provider rejection is sanitized (${typeof value})`, async (t) => {
    const timer = clock(t);
    const probe = createProviderProbe({ send: async () => { throw value; } });
    await assert.rejects(probe(token, subject), unavailable);
    timer.assertCleared();
  });
}

test('synchronous send throw is sanitized and cancels its deadline', async (t) => {
  const timer = clock(t);
  let signal;
  const probe = createProviderProbe({ send(_, options) {
    signal = options.abortSignal;
    throw privateError('Error');
  } });
  await assert.rejects(probe(token, subject), unavailable);
  timer.assertCleared();
  t.mock.timers.tick(8000);
  assert.equal(signal.aborted, false);
});

test('an existing unauthorized error is replaced without retaining private metadata', async (t) => {
  const timer = clock(t);
  const original = Object.assign(new UnauthorizedError(), {
    message: privateText, cause: new Error(privateText), request: privateText,
  });
  const probe = createProviderProbe({ send: async () => { throw original; } });
  await assert.rejects(probe(token, subject), (error) => {
    assert.notEqual(error, original);
    return denied(error);
  });
  timer.assertCleared();
});

test('8-second deadline aborts the SDK signal and sanitizes its rejection without retry', async (t) => {
  const timer = clock(t);
  let signal;
  let calls = 0;
  const probe = createProviderProbe({ send: (_, options) => {
    calls++;
    signal = options.abortSignal;
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(privateError('AbortError')), { once: true });
    });
  } });
  const pending = probe(token, subject);
  const rejection = assert.rejects(pending, unavailable);
  t.mock.timers.tick(7999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await rejection;
  assert.equal(calls, 1);
  timer.assertCleared();
});

test('overlapping probes have independent deadlines; a settled request cannot cancel another', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  let resolveFirst;
  const probe = createProviderProbe({ send: (_, options) => {
    signals.push(options.abortSignal);
    return new Promise((resolve, reject) => {
      if (signals.length === 1) resolveFirst = resolve;
      options.abortSignal.addEventListener('abort', () => reject(privateError('AbortError')), { once: true });
    });
  } });
  const first = probe(token, subject);
  t.mock.timers.tick(1000);
  const second = probe(token, subject);
  const secondRejection = assert.rejects(second, unavailable);
  assert.notEqual(signals[0], signals[1]);
  resolveFirst(validResponse());
  await first;
  t.mock.timers.tick(7000);
  assert.equal(signals[0].aborted, false);
  assert.equal(signals[1].aborted, false);
  t.mock.timers.tick(1000);
  assert.equal(signals[0].aborted, false);
  assert.equal(signals[1].aborted, true);
  await secondRejection;
});
