import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Exercise the deployed entry point with synthetic SDK replies, never credentials
// or injected API/registry substitutes. This is not DynamoDB persistence evidence.
const sentinel = 'SYNTHETIC_PRIVATE_LOGOUT_SENTINEL';
const child = `
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  let connections = 0, unexpectedSends = 0;
  const violations = [], lines = [], outcomes = [];
  const denyNetwork = () => { connections++; throw new Error('Unexpected network'); };
  const { Socket } = await import('node:net');
  Socket.prototype.connect = denyNetwork;
  for (const name of ['node:http', 'node:https']) {
    const { default: transport } = await import(name);
    transport.request = denyNetwork; transport.get = denyNetwork;
  }
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
  globalThis.fetch = denyNetwork;
  for (const [name, key] of [['@aws-sdk/client-dynamodb', 'DynamoDBClient'],
    ['@aws-sdk/client-cognito-identity-provider', 'CognitoIdentityProviderClient']]) {
    const sdk = await import(name);
    sdk[key].prototype.send = () => { unexpectedSends++; throw new Error('Unexpected raw/provider SDK'); };
  }
  const at = 60000, lifetime = 30 * 24 * 60 * 60000;
  let time = at;
  Date.now = () => time;
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const secret = 'a'.repeat(64), capKey = { pk: 'LOGOUT#' + digest(secret) };
  const familyKey = 'SESSION#' + digest('synthetic-family');
  const subject = 'synthetic-user';
  const failure = (name = 'SyntheticFailure', code) => Object.assign(
    new Error(process.argv[3], { cause: new Error(process.argv[3]) }),
    { name, ...(code ? { CancellationReasons: [{ Code: code }] } : {}) });
  let queue = [], calls = [];
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  DynamoDBDocumentClient.prototype.send = async (command) => {
    calls.push(command.constructor.name);
    const next = queue.shift();
    try {
      assert.ok(next, 'unexpected document SDK call');
      assert.equal(command.constructor.name, next.name);
      next.check(command.input);
      assert.equal(JSON.stringify(command.input).includes(secret), false, 'never persist raw capability');
    } catch (error) { violations.push(error.message); throw error; }
    if (next.advance !== undefined) time = next.advance;
    if (next.error) throw next.error;
    return next.reply ?? {};
  };
  const write = process.stdout.write;
  process.stdout.write = (line) => { lines.push(String(line)); return true; };
  const { handler } = await import(process.argv[1]);
  for (const scenario of JSON.parse(process.argv[2])) {
    time = at; calls = []; queue = [];
    if (!scenario.noBudget) queue.push({ name: 'TransactWriteCommand', check: (input) => {
      const update = (suffix, limit) => ({ Update: { TableName: 'test-logout-budget',
        Key: { pk: 'LOGOUT_RATE#1#' + suffix },
        UpdateExpression: 'SET #ttl = :ttl ADD #count :one',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':ttl': 180, ':one': 1, ':limit': limit } } });
      assert.deepEqual(input, { TransactItems: [update('GLOBAL', 60), update(digest('1\\0' + '192.0.2.1'), 6)] });
    }, ...(scenario.budgetError ? { error: failure(scenario.budgetError, scenario.budgetCode) } : {}),
      ...(scenario.budgetAdvance !== undefined ? { advance: scenario.budgetAdvance } : {}) });
    for (const attempt of scenario.attempts ?? []) {
      const capability = attempt.capability === 'known'
        ? { state: 'active', subject, familyKey, expiresAt: at + 10000, ...attempt.patch }
        : attempt.capability === 'revoked' ? { state: 'revoked' } : undefined;
      queue.push({ name: 'GetCommand', check: (input) => assert.deepEqual(input,
        { TableName: 'test-sessions', Key: capKey, ConsistentRead: true }),
        reply: { Item: capability }, ...(attempt.readError ? { error: failure() } : {}),
        ...(attempt.advanceRead !== undefined ? { advance: attempt.advanceRead } : {}) });
      if (!attempt.write) continue;
      queue.push({ name: 'TransactWriteCommand', check: (input) => {
        const deadline = time + lifetime + 1000;
        const expiry = capability?.expiresAt ?? deadline;
        const tombstone = { Put: { TableName: 'test-sessions',
          Item: { ...capKey, state: 'revoked', expiresAt: expiry, ttl: Math.ceil(expiry / 1000) },
          ConditionExpression: capability ? '#state = :active AND familyKey = :family AND subject = :subject' : 'attribute_not_exists(pk)',
          ...(capability ? { ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: { ':active': 'active', ':family': familyKey, ':subject': subject } } : {}) } };
        const writes = [tombstone];
        if (capability && capability.expiresAt > time) writes.push({ Update: { TableName: 'test-sessions', Key: { pk: familyKey },
          ConditionExpression: 'subject = :subject AND logoutKey = :key',
          UpdateExpression: 'SET #state = :revoked, revokedAt = :now, expiresAt = :deadline, #ttl = :ttl',
          ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':subject': subject, ':key': capKey.pk, ':revoked': 'revoked',
            ':now': time, ':deadline': deadline, ':ttl': Math.ceil(deadline / 1000) } } });
        assert.deepEqual(input, { TransactItems: writes });
      }, ...(attempt.writeError ? { error: failure(attempt.writeError, attempt.code) } : {}),
        ...(attempt.advanceWrite !== undefined ? { advance: attempt.advanceWrite } : {}) });
    }
    const event = { rawPath: '/v1/session/logout', body: JSON.stringify({ logoutSecret: secret }),
      requestContext: { http: { method: 'POST', ...(scenario.missingSource ? {} : { sourceIp: '192.0.2.1' }) } },
      headers: { 'x-forwarded-for': '192.0.2.99', ...(scenario.authorization ? { authorization: scenario.authorization } : {}) } };
    const response = await handler(event);
    if (queue.length) violations.push('unconsumed SDK expectations: ' + queue.length);
    outcomes.push({ response, calls });
  }
  process.stdout.write = write;
  process.stdout.write(JSON.stringify({ outcomes, violations, lines, connections, unexpectedSends }));
`;
const env = {
  AWS_REGION: 'eu-west-2', AWS_EC2_METADATA_DISABLED: 'true',
  SESSION_TABLE_NAME: 'test-sessions', ACCOUNT_BUDGET_TABLE_NAME: 'test-account-budget',
  LOGOUT_BUDGET_TABLE_NAME: 'test-logout-budget',
  COGNITO_USER_POOL_ID: 'eu-west-2_SyntheticPool', COGNITO_CLIENT_ID: 'synthetic-client',
};
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const unknown = { write: true };
const known = { capability: 'known', write: true };
const conflict = (code = 'ConditionalCheckFailed') => ({ ...unknown, writeError: 'TransactionCanceledException', code });
const cases = [
  { name: 'no bearer: unknown capability receives tombstone', attempts: [unknown] },
  { name: 'invalid bearer does not obstruct known-family logout', authorization: 'Bearer invalid', attempts: [known] },
  { name: 'already revoked: budget then one read, no write', attempts: [{ capability: 'revoked' }] },
  { name: 'unknown conflict rereads newly bound family', attempts: [conflict(), known] },
  { name: 'transaction conflict rereads revoked capability', attempts: [conflict('TransactionConflict'), { capability: 'revoked' }] },
  { name: 'known conflict retries with current binding', attempts: [{ ...known, writeError: 'TransactionCanceledException', code: 'TransactionConflict' }, known] },
  { name: 'six conflicts exhaust bounded loop', attempts: Array.from({ length: 6 }, () => conflict()), status: 503 },
  { name: 'nonconditional cancellation does not retry', attempts: [{ ...known, writeError: 'TransactionCanceledException', code: 'ValidationError' }], status: 503 },
  { name: 'cancellation without reasons does not retry', attempts: [{ ...unknown, writeError: 'TransactionCanceledException' }], status: 503 },
  { name: 'read outage is sanitized', attempts: [{ readError: true }], status: 503 },
  { name: 'ambiguous write outage is sanitized', attempts: [{ ...known, writeError: 'TimeoutError' }], status: 503 },
  { name: 'expired capability tombstones without touching family', attempts: [{ ...known, patch: { expiresAt: 60000 } }] },
  { name: 'read crosses capability deadline: no family write', attempts: [{ ...known, advanceRead: 70000 }] },
  { name: 'unknown post-read clock sets tombstone deadline', attempts: [{ ...unknown, advanceRead: 70001 }] },
  { name: 'invalid stored deadline fails closed', attempts: [{ capability: 'known', patch: { expiresAt: 'invalid' } }], status: 401 },
  { name: 'budget conditional denial prevents capability read', budgetError: 'TransactionCanceledException', budgetCode: 'ConditionalCheckFailed', status: 429 },
  { name: 'budget outage prevents capability read', budgetError: 'TimeoutError', status: 503 },
  { name: 'budget conflict fails closed without registry retry', budgetError: 'TransactionCanceledException', budgetCode: 'TransactionConflict', status: 503 },
  { name: 'old-window permit prevents capability read', budgetAdvance: 120000, status: 503 },
  { name: 'missing Gateway source cannot use forwarded source', missingSource: true, noBudget: true, status: 503 },
  { name: 'warm recovery after denied budget', attempts: [known] },
  { name: 'warm repeat remains idempotent', attempts: [{ capability: 'revoked' }] },
];

test('sessionLambda actual capability logout composes budget, tombstone and family revocation without token/read scope', async (t) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', child,
    new URL('../src/sessionLambda.mjs', import.meta.url).href, JSON.stringify(cases), sentinel], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.violations, [], 'all SDK calls must match exact expectations');
  assert.equal(report.connections, 0);
  assert.equal(report.unexpectedSends, 0);
  assert.deepEqual(report.lines, [], 'private handler must not log');
  assert.equal(JSON.stringify(report).includes(sentinel), false);
  assert.equal(JSON.stringify(report).includes('a'.repeat(64)), false);
  assert.equal(report.outcomes.length, cases.length);
  for (const [i, scenario] of cases.entries()) await t.test(scenario.name, () => {
    const statusCode = scenario.status ?? 200;
    const error = statusCode === 401 ? 'UNAUTHORIZED' : statusCode === 429 ? 'LOGOUT_RATE_LIMITED' : 'ACCOUNT_SERVICE_UNAVAILABLE';
    assert.deepEqual(report.outcomes[i].response, { statusCode,
      headers: { ...headers, ...(statusCode === 429 ? { 'Retry-After': '60' } : {}) },
      body: JSON.stringify(statusCode === 200 ? { revoked: true } : { error }) });
    assert.deepEqual(report.outcomes[i].calls, [
      ...(scenario.noBudget ? [] : ['TransactWriteCommand']),
      ...(scenario.attempts ?? []).flatMap((attempt) => ['GetCommand', ...(attempt.write ? ['TransactWriteCommand'] : [])]),
    ]);
  });
});
