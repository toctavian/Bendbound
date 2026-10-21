import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createAccountAuthorizer, createAccountTokenVerifier, UnauthorizedError } from '../src/authorizer.mjs';
// Entirely synthetic keys/identities. No credentials or live provider needed.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pool = 'eu-west-2_Synthetic', clientId = 'syntheticclient';
const issuer = `https://cognito-idp.eu-west-2.amazonaws.com/${pool}`;
const verifier = CognitoJwtVerifier.create({ userPoolId: pool, clientId, tokenUse: 'access' });
verifier.cacheJwks({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' }] });
const now = Math.floor(Date.now() / 1000);
function jwt(patch = {}) {
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const payload = { iss: issuer, client_id: clientId, token_use: 'access', sub: 'synthetic-user', origin_jti: 'synthetic-family', scope: 'openid bendbound/groups', exp: now + 120, iat: now, auth_time: now, ...patch };
  const body = `${encode({ alg: 'RS256', kid: 'synthetic-key' })}.${encode(payload)}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}
const make = (sessionActive = async () => true) => createAccountAuthorizer({ userPoolId: pool, clientId, verifier, sessionActive });
test('valid provider signature yields a server principal only after registry verification', async () => {
  let checked;
  const auth = make(async (value) => { checked = value; return true; });
  const principal = await auth(`Bearer ${jwt()}`);
  assert.equal(principal.userId, 'synthetic-user'); assert.equal(checked.familyId, 'synthetic-family');
  assert.equal('token' in principal, false); assert.equal(Object.isFrozen(principal), true);
});
test('rejects expired, wrong issuer/client, ID tokens, missing scope and missing session family', async () => {
  for (const patch of [{ exp: now - 10 }, { iss: 'https://wrong.example.test' }, { client_id: 'another-app' }, { token_use: 'id', aud: clientId }, { scope: 'openid' }, { origin_jti: null }]) {
    await assert.rejects(make()(`Bearer ${jwt(patch)}`), UnauthorizedError);
  }
});
test('signature tampering and shared pilot bearer values cannot authenticate accounts', async () => {
  const token = jwt(); const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url')); payload.sub = 'victim';
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  for (const authorization of [`Bearer ${parts.join('.')}`, 'Bearer synthetic-pilot-token', `Bearer ${token}\n`, '', null]) await assert.rejects(make()(authorization), UnauthorizedError);
});
test('revoked/unknown sessions and registry outages fail closed despite valid JWT signatures', async () => {
  for (const check of [async () => false, async () => { throw new Error('registry down'); }]) await assert.rejects(make(check)(`Bearer ${jwt()}`), UnauthorizedError);
  assert.throws(() => createAccountAuthorizer({ userPoolId: pool, clientId }), /registry/);
});


test('authorizer rechecks token expiry after awaited live-session validation', async () => {
  const expiresAt = (now + 120) * 1000;
  for (const finalTime of [expiresAt - 1, expiresAt, expiresAt + 1, NaN, Infinity, -Infinity]) {
    let time = now * 1000, checks = 0;
    const auth = createAccountAuthorizer({ userPoolId: pool, clientId, verifier,
      now: () => time,
      sessionActive: async () => { await Promise.resolve(); checks++; time = finalTime; return true; },
    });
    if (finalTime === expiresAt - 1) assert.equal((await auth(`Bearer ${jwt()}`)).expiresAt, expiresAt);
    else await assert.rejects(auth(`Bearer ${jwt()}`), UnauthorizedError);
    assert.equal(checks, 1);
  }
});


test('direct token verifier rejects nonfinite clocks and overflowing claim deadlines', async (t) => {
  for (const clock of [NaN, Infinity, -Infinity]) {
    await t.test(`nonfinite clock ${clock}`, async () => {
      const verify = createAccountTokenVerifier({ userPoolId: pool, clientId, verifier, now: () => clock });
      await assert.rejects(verify(`Bearer ${jwt()}`), UnauthorizedError);
    });
  }
  for (const patch of [{ exp: Number.MAX_VALUE }, { auth_time: Number.MAX_VALUE }]) {
    await t.test(`overflowing ${Object.keys(patch)[0]}`, async () => {
      const verify = createAccountTokenVerifier({ userPoolId: pool, clientId, verifier, now: () => now * 1000 });
      await assert.rejects(verify(`Bearer ${jwt(patch)}`), UnauthorizedError);
    });
  }
});

test('direct verifier uses one post-verification clock for expiry and auth-time tolerance', async (t) => {
  const at = now * 1000;
  const cases = [
    { name: 'last live millisecond', exp: (at + 1) / 1000, auth_time: now, accepted: true },
    { name: 'exact expiry', exp: now, auth_time: now, accepted: false },
    { name: 'past expiry', exp: (at - 1) / 1000, auth_time: now, accepted: false },
    { name: 'auth time at tolerance', exp: now + 120, auth_time: now + 1, accepted: true },
    { name: 'auth time beyond tolerance', exp: now + 120, auth_time: (at + 1001) / 1000, accepted: false },
    { name: 'negative auth time', exp: now + 120, auth_time: -1, accepted: false },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let completed = false, samples = 0;
      const verify = createAccountTokenVerifier({ userPoolId: pool, clientId,
        verifier: { verify: async () => {
          await Promise.resolve(); completed = true;
          return { sub: 'synthetic-user', origin_jti: 'synthetic-family', scope: 'bendbound/groups', exp: entry.exp, auth_time: entry.auth_time };
        } },
        now: () => { assert.equal(completed, true); samples++; return samples === 1 ? at : NaN; },
      });
      if (entry.accepted) {
        const principal = await verify('Bearer synthetic');
        assert.equal(principal.expiresAt, entry.exp * 1000);
        assert.equal(principal.authenticatedAt, entry.auth_time * 1000);
        assert.equal(Object.isFrozen(principal), true);
      } else await assert.rejects(verify('Bearer synthetic'), UnauthorizedError);
      assert.equal(samples, 1);
    });
  }
});

test('direct verifier observes time advanced during JWT verification and preserves verification failures', async (t) => {
  const expiresAt = (now + 120) * 1000;
  for (const finalTime of [expiresAt - 1, expiresAt, expiresAt + 1, NaN, Infinity, -Infinity]) {
    await t.test(`post-verification time ${finalTime}`, async () => {
      let time = now * 1000;
      const verify = createAccountTokenVerifier({ userPoolId: pool, clientId,
        verifier: { verify: async (token) => {
          const claims = await verifier.verify(token); time = finalTime; return claims;
        } }, now: () => time,
      });
      if (finalTime === expiresAt - 1) assert.equal((await verify(`Bearer ${jwt()}`)).expiresAt, expiresAt);
      else await assert.rejects(verify(`Bearer ${jwt()}`), UnauthorizedError);
    });
  }
  let samples = 0;
  const verify = createAccountTokenVerifier({ userPoolId: pool, clientId,
    verifier: { verify: async () => { await Promise.resolve(); throw new Error('synthetic verification failure'); } },
    now: () => { samples++; return now * 1000; },
  });
  await assert.rejects(verify('Bearer synthetic'), UnauthorizedError);
  assert.equal(samples, 0);
});
