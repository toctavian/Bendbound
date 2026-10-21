import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountAuthorizer, createAccountTokenVerifier, UnauthorizedError } from '../src/authorizer.mjs';

// Synthetic verifier controls isolate the boundary; signed JWT tests remain separate.
const at = 1_000_000;
const claims = () => ({ sub: 'synthetic-user', origin_jti: 'synthetic-family',
  scope: 'openid bendbound/groups', auth_time: at / 1000, exp: (at + 60_000) / 1000 });
function fixture(patch = {}, verifyEffect) {
  const calls = [];
  const options = { userPoolId: 'eu-west-2_Synthetic', clientId: 'synthetic-client',
    verifier: { verify: async (token) => {
      calls.push(['verify', token]);
      if (verifyEffect) return verifyEffect();
      return { ...claims(), ...patch };
    } }, now: () => { calls.push(['clock']); return at; } };
  return { calls, verify: createAccountTokenVerifier(options),
    authorize: createAccountAuthorizer({ ...options, sessionActive: async (session) => {
      calls.push(['registry', session]); return true;
    } }) };
}
function denied(error) {
  assert.equal(error.constructor, UnauthorizedError);
  assert.equal(error.status, 401);
  assert.equal(error.message, 'Account access is not authorised.');
  assert.equal(error.cause, undefined);
  assert.deepEqual(Object.keys(error), ['status']);
  return true;
}

const malformedHeaders = [
  ['absent', undefined], ['null', null], ['number', 1], ['array', ['Bearer synthetic']],
  ['boxed string', new String('Bearer synthetic')], ['object', { authorization: 'Bearer synthetic' }],
  ['empty', ''], ['missing token', 'Bearer '], ['lowercase scheme', 'bearer synthetic'],
  ['uppercase scheme', 'BEARER synthetic'], ['basic scheme', 'Basic synthetic'],
  ['leading space', ' Bearer synthetic'], ['two spaces', 'Bearer  synthetic'],
  ['tab separator', 'Bearer\tsynthetic'], ['embedded space', 'Bearer syn thetic'],
  ['trailing space', 'Bearer synthetic '], ['padded token', 'Bearer synthetic='],
  ['slash', 'Bearer syn/thetic'], ['plus', 'Bearer syn+thetic'],
  ['comma joined', 'Bearer synthetic,Bearer other'], ['unicode', 'Bearer synthétic'],
  ['NUL', 'Bearer synthetic\0'], ['embedded LF', 'Bearer syn\nthetic'],
  ['final LF', 'Bearer synthetic\n'], ['final CR', 'Bearer synthetic\r'],
  ['final CRLF', 'Bearer synthetic\r\n'], ['line separator', 'Bearer synthetic\u2028'],
  ['paragraph separator', 'Bearer synthetic\u2029'],
  ['over length limit', `Bearer ${'a'.repeat(16_378)}`],
];
for (const [name, header] of malformedHeaders) {
  test(`malformed Authorization ${name} rejects before verifier, clock and registry`, async () => {
    for (const method of ['verify', 'authorize']) {
      const h = fixture();
      await assert.rejects(h[method](header), denied);
      assert.deepEqual(h.calls, []);
    }
  });
}

for (const token of ['synthetic', 'a.b-c_D.0', 'a'.repeat(16_377)]) {
  test(`allowed header forwards the exact token (${token.length} characters) and frozen principal`, async () => {
    const h = fixture();
    const principal = await h.authorize(`Bearer ${token}`);
    assert.deepEqual(principal, { userId: 'synthetic-user', sessionId: 'synthetic-family',
      expiresAt: at + 60_000, authenticatedAt: at });
    assert.equal(Object.isFrozen(principal), true);
    assert.deepEqual(h.calls, [['verify', token], ['clock'], ['registry', {
      subject: 'synthetic-user', familyId: 'synthetic-family', expiresAt: at + 60_000,
    }], ['clock']]);
  });
}

for (const field of ['sub', 'origin_jti', 'scope']) {
  for (const [name, value] of [['missing', undefined], ['null', null], ['empty', ''],
    ['number', 1], ['boolean', true], ['array', ['bendbound/groups']], ['object', {}]]) {
    test(`${field} ${name} denies before the live registry`, async () => {
      const h = fixture({ [field]: value });
      await assert.rejects(h.authorize('Bearer synthetic'), denied);
      assert.deepEqual(h.calls, [['verify', 'synthetic'], ['clock']]);
    });
  }
}

for (const scope of ['openid', 'bendbound/groups-extra', 'prefixbendbound/groups',
  'Bendbound/groups', 'bendbound/Groups', 'bendbound/group',
  'openid\tbendbound/groups', 'bendbound/groups\n', 'openid,bendbound/groups']) {
  test(`scope must contain an exact space-delimited group permission: ${JSON.stringify(scope)}`, async () => {
    const h = fixture({ scope });
    await assert.rejects(h.authorize('Bearer synthetic'), denied);
    assert.deepEqual(h.calls, [['verify', 'synthetic'], ['clock']]);
  });
}
for (const scope of ['bendbound/groups', 'bendbound/groups openid', 'openid bendbound/groups profile',
  'openid  bendbound/groups', ' bendbound/groups ', 'bendbound/groups bendbound/groups']) {
  test(`exact scope token permits registry verification: ${JSON.stringify(scope)}`, async () => {
    const h = fixture({ scope, email: 'synthetic@example.test', username: 'unused', token: 'private-synthetic' });
    const principal = await h.authorize('Bearer synthetic');
    assert.deepEqual(principal, { userId: 'synthetic-user', sessionId: 'synthetic-family',
      expiresAt: at + 60_000, authenticatedAt: at });
    assert.equal(h.calls.filter(([effect]) => effect === 'registry').length, 1);
  });
}

for (const [name, effect] of [
  ['synchronous error', () => { throw new Error('synthetic private detail', { cause: 'synthetic cause' }); }],
  ['asynchronous error', async () => { await Promise.resolve(); throw new Error('synthetic private detail'); }],
  ['non-Error rejection', async () => { throw { private: 'synthetic detail' }; }],
]) {
  test(`JWT ${name} becomes sanitized unauthorized without clock or registry access`, async () => {
    const h = fixture({}, effect);
    await assert.rejects(h.authorize('Bearer synthetic'), denied);
    assert.deepEqual(h.calls, [['verify', 'synthetic']]);
  });
}
