import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeAppleTriggers } from '../src/nativeAppleTriggers.mjs';
import { createNativeCognitoIssuer } from '../src/nativeAppleIssuer.mjs';
import { createNativeAppleApi } from '../src/nativeAppleApi.mjs';
import { AppleAuthenticationError } from '../src/nativeApple.mjs';
const mapping = { username: 'synthetic-user', subject: 'synthetic-sub', providerKey: 'NATIVEAPPLE#synthetic' };
const base = (triggerSource, request = {}) => ({ version: '2', triggerSource, userPoolId: 'synthetic-pool', userName: mapping.username,
  callerContext: { clientId: 'synthetic-client' }, request: { userAttributes: { sub: mapping.subject }, ...request }, response: {} });
function triggers(overrides = {}) { return createNativeAppleTriggers({ poolId: 'synthetic-pool', clientId: 'synthetic-client',
  store: { findUsername: async () => mapping, consumeProof: async () => {} }, admitted: async () => true, ...overrides }); }
test('Cognito only issues after the expected single custom challenge and denies forged contexts/metadata', async () => {
  const run = triggers();
  const first = await run(base('DefineAuthChallenge_Authentication', { session: [] }));
  assert.equal(first.response.issueTokens, false); assert.equal(first.response.challengeName, 'CUSTOM_CHALLENGE');
  const challenge = await run(base('CreateAuthChallenge_Authentication', { session: [], challengeName: 'CUSTOM_CHALLENGE' }));
  assert.match(challenge.response.publicChallengeParameters.nonce, /^[a-f0-9]{64}$/);
  for (const session of [[{ challengeName: 'SRP_A', challengeResult: true }], [{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: false }],
    [{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: true, challengeMetadata: 'forged' }], [{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: true }, {}]]) {
    const event = await run(base('DefineAuthChallenge_Authentication', { session }));
    assert.deepEqual(event.response, { issueTokens: false, failAuthentication: true });
  }
  const success = await run(base('DefineAuthChallenge_Authentication', { session: [{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: true, challengeMetadata: challenge.response.challengeMetadata }] }));
  assert.equal(success.response.issueTokens, true);
  for (const patch of [{ userPoolId: 'other' }, { callerContext: { clientId: 'other' } }, { request: { userNotFound: true } }]) await assert.rejects(run({ ...base('DefineAuthChallenge_Authentication', { session: [] }), ...patch }), AppleAuthenticationError);
});
test('proof mismatch fails authentication; scope on login/refresh requires trusted mapping and live admission', async () => {
  const deniedProof = triggers({ store: { findUsername: async () => mapping, consumeProof: async () => { throw new AppleAuthenticationError(); } } });
  const verification = await deniedProof(base('VerifyAuthChallengeResponse_Authentication', { challengeAnswer: 'forged' }));
  assert.equal(verification.response.answerCorrect, false);
  for (const source of ['TokenGeneration_Authentication', 'TokenGeneration_RefreshTokens']) {
    const event = await triggers()(base(source, { clientMetadata: { trusted: 'true' } }));
    assert.deepEqual(event.response.claimsAndScopeOverrideDetails.accessTokenGeneration.scopesToAdd, ['bendbound/groups', 'aws.cognito.signin.user.admin']);
    await assert.rejects(triggers({ admitted: async () => false })(base(source)), AppleAuthenticationError);
    await assert.rejects(triggers()({ ...base(source), version: '1' }), AppleAuthenticationError);
    await assert.rejects(triggers()(base(source, { userAttributes: { sub: 'victim' } })), AppleAuthenticationError);
  }
});
test('issuer keeps proof private, verifies Cognito identity, and revokes a rejected grant', async () => {
  const seen = [];
  const client = { async send(command) {
    seen.push(command);
    if (command.constructor.name === 'AdminInitiateAuthCommand') return { ChallengeName: 'CUSTOM_CHALLENGE', Session: 'synthetic-session', ChallengeParameters: { nonce: 'a'.repeat(64) } };
    if (command.constructor.name === 'AdminRespondToAuthChallengeCommand') return { AuthenticationResult: { AccessToken: 'synthetic-access', RefreshToken: 'synthetic-refresh', ExpiresIn: 300 } };
    if (command.constructor.name === 'GetUserCommand') return { UserAttributes: [{ Name: 'sub', Value: mapping.subject }] };
    return {};
  } };
  const config = { client, poolId: 'synthetic-pool', clientId: 'synthetic-client', store: { createProof: async (value) => {
    assert.equal(value.subject, mapping.subject); assert.equal(value.challengeNonce, 'a'.repeat(64)); return 'synthetic-proof';
  } }, verifyToken: async () => ({ userId: mapping.subject }) };
  const result = await createNativeCognitoIssuer(config)(mapping);
  assert.deepEqual(result, { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresIn: 300 });
  assert.equal(seen[1].input.ChallengeResponses.ANSWER, 'synthetic-proof'); assert.equal(JSON.stringify(result).includes('synthetic-proof'), false);
  await assert.rejects(createNativeCognitoIssuer({ ...config, verifyToken: async () => ({ userId: 'victim' }) })(mapping), AppleAuthenticationError);
  assert.equal(seen.at(-1).constructor.name, 'RevokeTokenCommand');
});
test('HTTP denies missing pilot admission before exchanging Apple code and rejects body identities/query credentials', async () => {
  let exchanged = 0;
  const run = createNativeAppleApi({ apiId: 'synthetic-api', store: { begin: async () => ({}), consumeChallenge: async () => ({ nonce: 'a'.repeat(64) }),
    findIdentity: async () => mapping, saveProviderToken: async () => {} }, consumeBudget: async () => {},
    verifyIdentity: async () => ({ subject: 'synthetic-apple' }), exchangeCode: async () => { exchanged++; },
    encryptToken: async () => {}, issueSession: async () => {}, admitted: async () => false });
  const event = { rawPath: '/v1/auth/apple/exchange', requestContext: { apiId: 'synthetic-api', http: { method: 'POST', sourceIp: '127.0.0.1' } },
    body: JSON.stringify({ challengeId: 'a'.repeat(64), identityToken: 'synthetic', authorizationCode: 'synthetic' }) };
  assert.equal((await run(event)).statusCode, 401); assert.equal(exchanged, 0);
  assert.equal((await run({ ...event, rawQueryString: 'token=synthetic' })).statusCode, 400);
  assert.equal((await run({ ...event, body: JSON.stringify({ ...JSON.parse(event.body), subject: 'victim' }) })).statusCode, 400);
  assert.equal((await run({ ...event, requestContext: { apiId: 'forged' } })).statusCode, 503);
});
test('only an unknown server-verified identity may request approval; no Apple exchange or app session is issued', async () => {
  const { NativeEnrollmentRequired } = await import('../src/nativeAppleStore.mjs');
  let requests = 0, exchanged = 0, issued = 0;
  const config = { apiId: 'synthetic-api', store: { begin: async () => ({}), consumeChallenge: async () => ({ nonce: 'a'.repeat(64) }),
    findIdentity: async () => { throw new NativeEnrollmentRequired(); }, saveProviderToken: async () => {},
    requestEnrollment: async (subject) => { assert.equal(subject, 'verified-sub'); requests++; return { requestId: 'b'.repeat(64) }; } },
    consumeBudget: async () => {}, verifyIdentity: async () => ({ subject: 'verified-sub' }), exchangeCode: async () => { exchanged++; },
    encryptToken: async () => {}, issueSession: async () => { issued++; }, admitted: async () => false };
  const event = { rawPath: '/v1/auth/apple/exchange', requestContext: { apiId: 'synthetic-api', http: { method: 'POST', sourceIp: '127.0.0.1' } },
    body: JSON.stringify({ challengeId: 'a'.repeat(64), identityToken: 'synthetic', authorizationCode: 'synthetic' }) };
  const response = await createNativeAppleApi(config)(event);
  assert.equal(response.statusCode, 403); assert.deepEqual(JSON.parse(response.body), { error: 'PILOT_APPROVAL_REQUIRED', requestId: 'b'.repeat(64) });
  assert.equal(requests, 1); assert.equal(exchanged, 0); assert.equal(issued, 0);
  const blocked = createNativeAppleApi({ ...config, store: { ...config.store, findIdentity: async () => { throw new AppleAuthenticationError(); } } });
  assert.equal((await blocked(event)).statusCode, 401); assert.equal(requests, 1);
  const invalid = createNativeAppleApi({ ...config, verifyIdentity: async () => { throw new AppleAuthenticationError(); } });
  assert.equal((await invalid(event)).statusCode, 401); assert.equal(requests, 1);
});
