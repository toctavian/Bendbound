import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Entry points must never see the developer's environment or resolve credentials.
// Every case gets a fresh module cache and explicit, entirely synthetic settings.
const baseEnvironment = {
  AWS_REGION: 'eu-west-2',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_LAMBDA_FUNCTION_NAME: 'synthetic-cleanup',
  SESSION_TABLE_NAME: 'test-sessions',
  ROOM_TABLE_NAME: 'test-rooms',
  LOCATION_TABLE_NAME: 'test-locations',
  ROOM_BUDGET_TABLE_NAME: 'test-room-budget',
  ACCOUNT_BUDGET_TABLE_NAME: 'test-account-budget',
  LOGOUT_BUDGET_TABLE_NAME: 'test-logout-budget',
  COGNITO_USER_POOL_ID: 'eu-west-2_SyntheticPool',
  COGNITO_CLIENT_ID: 'synthetic-client',
};
const child = `
  let sends = 0, connections = 0;
  const denyNetwork = () => { connections++; throw new Error('Unexpected network access'); };
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
  for (const [name, exports] of [
    ['@aws-sdk/client-dynamodb', ['DynamoDBClient']],
    ['@aws-sdk/lib-dynamodb', ['DynamoDBDocumentClient']],
    ['@aws-sdk/client-cognito-identity-provider', ['CognitoIdentityProviderClient']],
  ]) {
    const sdk = await import(name);
    for (const key of exports) sdk[key].prototype.send = () => {
      sends++; throw new Error('Unexpected SDK send');
    };
  }
  let result;
  try {
    const entry = await import(process.argv[1]);
    result = { ok: true, handler: typeof entry.handler };
  } catch (error) {
    result = { ok: false, name: error.name, message: error.message };
  }
  process.stdout.write(JSON.stringify({ ...result, sends, connections }));
`;

function load(entry, overrides = {}) {
  const env = { ...baseEnvironment, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', child,
    new URL(`../src/${entry}.mjs`, import.meta.url).href], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sends, 0, 'startup must not send SDK operations');
  assert.equal(report.connections, 0, 'startup must not access the network');
  return report;
}

for (const entry of ['sessionLambda', 'roomLambda']) {
  test(`${entry}: valid synthetic configuration exports a handler without I/O`, () => {
    assert.deepEqual(load(entry), { ok: true, handler: 'function', sends: 0, connections: 0 });
  });

  const tables = entry === 'sessionLambda' ? {
    SESSION_TABLE_NAME: 'Session storage must be configured.',
    LOGOUT_BUDGET_TABLE_NAME: 'Logout budget must be configured.',
    ACCOUNT_BUDGET_TABLE_NAME: 'Account budget must be configured.',
  } : {
    SESSION_TABLE_NAME: 'Session storage must be configured.',
    ROOM_TABLE_NAME: 'Room storage must be configured.',
    ROOM_BUDGET_TABLE_NAME: 'Room budget must be configured.',
  };
  for (const [key, message] of Object.entries(tables)) {
    test(`${entry}: rejects absent/malformed ${key} at import`, async (t) => {
      for (const [label, value] of [
        ['absent', undefined], ['empty', ''], ['short', 'ab'],
        ['whitespace', '   '], ['invalid character', 'invalid/name'], ['overlong', 'a'.repeat(256)],
      ]) await t.test(label, () => {
        assert.deepEqual(load(entry, { [key]: value }), {
          ok: false, name: 'Error', message, sends: 0, connections: 0,
        });
      });
    });
  }
  for (const key of ['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID']) {
    test(`${entry}: requires ${key} before exporting a handler`, async (t) => {
      for (const [label, value] of [['absent', undefined], ['empty', '']]) {
        await t.test(label, () => assert.deepEqual(load(entry, { [key]: value }), {
          ok: false, name: 'Error', message: 'Account verification must be configured.',
          sends: 0, connections: 0,
        }));
      }
    });
  }
  test(`${entry}: malformed pool cannot produce a configured verifier`, () => {
    assert.equal(load(entry, { COGNITO_USER_POOL_ID: 'invalid-pool' }).ok, false);
  });
}

test('roomLambda: optional location storage may be absent, but malformed/colliding names fail', async (t) => {
  await t.test('absent location table preserves room-only handler', () => {
    assert.equal(load('roomLambda', { LOCATION_TABLE_NAME: undefined }).handler, 'function');
  });
  for (const [label, value] of [
    ['empty', ''], ['short', 'ab'], ['invalid character', 'invalid/name'],
    ['overlong', 'a'.repeat(256)], ['session collision', baseEnvironment.SESSION_TABLE_NAME],
    ['room collision', baseEnvironment.ROOM_TABLE_NAME],
  ]) await t.test(label, () => assert.deepEqual(load('roomLambda', { LOCATION_TABLE_NAME: value }), {
    ok: false, name: 'Error', message: 'Location storage must be separate.', sends: 0, connections: 0,
  }));
  await t.test('room/session collision', () => assert.deepEqual(load('roomLambda', {
    ROOM_TABLE_NAME: baseEnvironment.SESSION_TABLE_NAME,
  }), { ok: false, name: 'Error', message: 'Room storage must be configured.', sends: 0, connections: 0 }));
});

for (const entry of ['locationCleanupLambda', 'roomCleanupLambda']) {
  test(`${entry}: valid synthetic configuration exports a handler without I/O`, () => {
    assert.deepEqual(load(entry), { ok: true, handler: 'function', sends: 0, connections: 0 });
  });

  test(`${entry}: rejects absent/malformed monitoring dimension at import`, async (t) => {
    for (const [label, value] of [
      ['absent', undefined], ['empty', ''], ['whitespace', ' '],
      ['invalid character', 'invalid/name'], ['overlong', 'a'.repeat(65)],
    ]) await t.test(label, () => assert.deepEqual(load(entry, { AWS_LAMBDA_FUNCTION_NAME: value }), {
      ok: false, name: 'Error', message: 'Cleanup monitoring must be configured.', sends: 0, connections: 0,
    }));
  });

  const tables = entry === 'locationCleanupLambda' ? {
    SESSION_TABLE_NAME: 'Session storage must be configured.',
    ROOM_TABLE_NAME: 'Separate location storage and atomic session checks are required.',
    LOCATION_TABLE_NAME: 'Separate location storage and atomic session checks are required.',
  } : { ROOM_TABLE_NAME: 'Room cleanup storage must be configured.' };
  for (const [key, message] of Object.entries(tables)) {
    test(`${entry}: rejects absent/malformed ${key} at import`, async (t) => {
      for (const [label, value] of [
        ['absent', undefined], ['empty', ''], ['short', 'ab'],
        ['whitespace', '   '], ['invalid character', 'invalid/name'], ['overlong', 'a'.repeat(256)],
      ]) await t.test(label, () => assert.deepEqual(load(entry, { [key]: value }), {
        ok: false, name: 'Error', message, sends: 0, connections: 0,
      }));
    });
  }

  test(`${entry}: accepts boundary-valid names without identity or API budgets`, async (t) => {
    for (const length of [1, 64]) await t.test(`function name length ${length}`, () => {
      assert.equal(load(entry, { AWS_LAMBDA_FUNCTION_NAME: 'a'.repeat(length) }).handler, 'function');
    });
    for (const length of [3, 255]) await t.test(`table name length ${length}`, () => {
      assert.deepEqual(load(entry, {
        AWS_LAMBDA_FUNCTION_NAME: 'synthetic_cleanup-1',
        ROOM_TABLE_NAME: `r${'a'.repeat(length - 1)}`,
        LOCATION_TABLE_NAME: entry === 'locationCleanupLambda' ? `l${'a'.repeat(length - 1)}` : undefined,
        SESSION_TABLE_NAME: entry === 'locationCleanupLambda' ? `s${'a'.repeat(length - 1)}` : undefined,
        COGNITO_USER_POOL_ID: undefined, COGNITO_CLIENT_ID: undefined,
        ROOM_BUDGET_TABLE_NAME: undefined, ACCOUNT_BUDGET_TABLE_NAME: undefined,
        LOGOUT_BUDGET_TABLE_NAME: undefined,
      }), { ok: true, handler: 'function', sends: 0, connections: 0 });
    });
  });
}

test('locationCleanupLambda: every storage collision pair rejects startup', async (t) => {
  for (const [key, other] of [
    ['LOCATION_TABLE_NAME', 'ROOM_TABLE_NAME'],
    ['LOCATION_TABLE_NAME', 'SESSION_TABLE_NAME'],
    ['ROOM_TABLE_NAME', 'SESSION_TABLE_NAME'],
  ]) await t.test(`${key} equals ${other}`, () => assert.deepEqual(load('locationCleanupLambda', {
    [key]: baseEnvironment[other],
  }), {
    ok: false, name: 'Error', message: 'Separate location storage and atomic session checks are required.',
    sends: 0, connections: 0,
  }));
});
