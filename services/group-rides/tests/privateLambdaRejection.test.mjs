import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Test the actual composition, not injected API/verifier substitutes. Children
// inherit no environment or credentials; every SDK/network path is guarded.
const sentinel = 'SYNTHETIC_PRIVATE_REJECTION_SENTINEL';
const child = `
  let connections = 0, sends = 0;
  const lines = [], documentCalls = [];
  const denyNetwork = () => { connections++; throw new Error('Unexpected network'); };
  const { Socket } = await import('node:net');
  Socket.prototype.connect = denyNetwork;
  for (const name of ['node:http', 'node:https']) {
    const { default: transport } = await import(name);
    transport.request = denyNetwork;
    transport.get = denyNetwork;
  }
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
  globalThis.fetch = denyNetwork;
  for (const name of ['@aws-sdk/client-dynamodb', '@aws-sdk/client-cognito-identity-provider']) {
    const sdk = await import(name);
    const key = name.includes('cognito') ? 'CognitoIdentityProviderClient' : 'DynamoDBClient';
    sdk[key].prototype.send = () => { sends++; throw new Error('Unexpected raw SDK send'); };
  }
  let permitBudgetFailure = false;
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  DynamoDBDocumentClient.prototype.send = async (command) => {
    if (!permitBudgetFailure) sends++;
    documentCalls.push({ name: command.constructor.name,
      tables: command.input.TransactItems?.map((item) => item.Update?.TableName) });
    throw new Error(process.argv[3], { cause: new Error(process.argv[3]) });
  };
  const write = process.stdout.write;
  process.stdout.write = (line) => { lines.push(String(line)); return true; };
  const { handler } = await import(process.argv[1]);
  const outcomes = [];
  for (const { event, budgetFailure } of JSON.parse(process.argv[2])) {
    permitBudgetFailure = Boolean(budgetFailure);
    const start = documentCalls.length;
    outcomes.push({ response: await handler(event), calls: documentCalls.slice(start) });
  }
  process.stdout.write = write;
  process.stdout.write(JSON.stringify({ outcomes, connections, sends, lines }));
`;
const env = {
  AWS_REGION: 'eu-west-2', AWS_EC2_METADATA_DISABLED: 'true',
  SESSION_TABLE_NAME: 'test-sessions', ROOM_TABLE_NAME: 'test-rooms',
  LOCATION_TABLE_NAME: 'test-locations', ROOM_BUDGET_TABLE_NAME: 'test-room-budget',
  ACCOUNT_BUDGET_TABLE_NAME: 'test-account-budget', LOGOUT_BUDGET_TABLE_NAME: 'test-logout-budget',
  COGNITO_USER_POOL_ID: 'eu-west-2_SyntheticPool', COGNITO_CLIENT_ID: 'synthetic-client',
};
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff' };
const request = (rawPath, method, body = '') => ({ rawPath, body,
  requestContext: { http: { method, sourceIp: '192.0.2.1' } },
  headers: { authorization: `Bearer ${sentinel}` } });
function invoke(entry, cases) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', child,
    new URL(`../src/${entry}.mjs`, import.meta.url).href, JSON.stringify(cases), sentinel], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.connections, 0, 'no JWKS, credential-provider or other network work');
  assert.equal(report.sends, 0, 'no unexpected document/raw DynamoDB or Cognito work');
  assert.deepEqual(report.lines, [], 'private rejection paths must not log');
  assert.equal(JSON.stringify(report).includes(sentinel), false);
  assert.equal(report.outcomes.length, cases.length);
  return report.outcomes;
}
function denied(event, statusCode, error, name) { return { event, statusCode, error, name }; }
async function verify(t, entry, cases) {
  const outcomes = invoke(entry, cases);
  for (let i = 0; i < cases.length; i++) await t.test(cases[i].name, () => {
    const c = cases[i];
    assert.deepEqual(outcomes[i].response, { statusCode: c.statusCode, headers,
      body: JSON.stringify({ error: c.error }) });
    assert.deepEqual(outcomes[i].calls, c.budgetFailure
      ? [{ name: 'TransactWriteCommand', tables: ['test-logout-budget', 'test-logout-budget'] }] : []);
  });
}

const sessionRoutes = [['/v1/session', 'POST', JSON.stringify({ logoutSecret: 'a'.repeat(64) })],
  ['/v1/session', 'GET', ''], ['/v1/session', 'DELETE', '']];
const logout = () => request('/v1/session/logout', 'POST', JSON.stringify({ logoutSecret: 'a'.repeat(64) }));
test('sessionLambda: actual export rejects transport/credentials and retains logout budget boundary', async (t) => {
  const cases = [];
  for (const [path, method, body] of [...sessionRoutes, ['/v1/session/logout', 'POST', logout().body]]) {
    const event = request(path, method, body);
    cases.push(denied({ ...event, rawQueryString: `authorization=${sentinel}` }, 400, 'INVALID_REQUEST', `${method} ${path}: query`));
    cases.push(denied({ ...event, body: '{' }, 400, 'INVALID_REQUEST', `${method} ${path}: malformed body`));
    cases.push(denied({ ...event, body: JSON.stringify({ userId: sentinel }), isBase64Encoded: false }, 400, 'INVALID_REQUEST', `${method} ${path}: body identity`));
  }
  for (const [path, method] of [['/v1/session', 'PUT'], ['/v1/session/logout', 'GET'], ['/v1/session/unknown', 'POST']]) {
    cases.push(denied(request(path, method, '{'), 404, 'NOT_FOUND', `${method} ${path}: unsupported route`));
  }
  for (const [path, method, body] of sessionRoutes) {
    for (const authorization of [undefined, ['Bearer synthetic'], 'Basic synthetic', 'Bearer synthetic\n', 'Bearer synthetic']) {
      cases.push(denied({ ...request(path, method, body), headers: { authorization } }, 401, 'UNAUTHORIZED', `${method}: credential ${JSON.stringify(authorization)}`));
    }
  }
  cases.push({ ...denied(logout(), 503, 'ACCOUNT_SERVICE_UNAVAILABLE', 'valid secret logout: sanitized SDK budget failure'), budgetFailure: true });
  // Repeat an early rejection after the controlled failure in the same module.
  cases.push(denied({ ...logout(), body: '{' }, 400, 'INVALID_REQUEST', 'warm rejection after budget failure'));
  await verify(t, 'sessionLambda', cases);
});

const id = 'a'.repeat(64);
const roomRoutes = [['/v1/rooms', 'POST'], [`/v1/rooms/${id}`, 'GET'],
  ...['invites', 'members', 'start', 'end'].map((op) => [`/v1/rooms/${id}/${op}`, 'POST']),
  ...['sharing', 'profile', 'fix'].map((op) => [`/v1/rooms/${id}/${op}`, 'PUT']),
  ...['me', 'synthetic-member'].map((target) => [`/v1/rooms/${id}/members/${target}`, 'DELETE'])];
test('roomLambda: actual export rejects queries/paths and denies before parsing unauthenticated bodies', async (t) => {
  const cases = [];
  for (const [path, method] of roomRoutes) {
    cases.push(denied({ ...request(path, method, '{'), rawQueryString: `inviteToken=${sentinel}` }, 400, 'INVALID_REQUEST', `${method} ${path}: query`));
    for (const authorization of [undefined, 'Bearer synthetic\n', 'Bearer synthetic']) {
      cases.push(denied({ ...request(path, method, '{'), headers: { authorization } }, 401, 'UNAUTHORIZED', `${method} ${path}: credential ${JSON.stringify(authorization)}`));
    }
  }
  for (const path of ['/v1/unknown', '/v1/rooms/invalid', `/v1/rooms/${id}/unknown`]) {
    cases.push(denied(request(path, 'POST', '{'), 404, 'NOT_FOUND', `${path}: unknown route`));
  }
  // Known paths with unsupported methods still authenticate first by design.
  cases.push(denied(request('/v1/rooms', 'PATCH', '{'), 401, 'UNAUTHORIZED', 'known path unsupported method preserves authentication ordering'));
  await verify(t, 'roomLambda', cases);
});
