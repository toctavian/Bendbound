import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Invoke real entry points, constructors and adapters in a fresh module cache.
// No inherited environment, real credentials, AWS sends or network are allowed.
const child = `
  const { inspect } = await import('node:util');
  let connections = 0, unexpectedSends = 0;
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
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  DynamoDBClient.prototype.send = () => { unexpectedSends++; throw new Error('Unexpected raw SDK send'); };
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  const calls = [], lines = [];
  const scenario = process.argv[2], room = process.argv[1].includes('roomCleanupLambda');
  const privateValue = 'SYNTHETIC_PRIVATE_HANDLER_SENTINEL';
  const failure = () => Object.assign(new Error(privateValue), {
    cause: new Error(privateValue), request: { authorization: privateValue },
  });
  const items = [0, 1].map((i) => room
    ? { pk: 'ROOM#synthetic-' + i, revision: i + 1, purgeAt: 90000 + i * 1000 }
    : { pk: 'ROOM#synthetic', sk: 'POINT#synthetic-' + i, pointVersion: 'v' + i, expiresAt: 90000 + i * 1000 });
  let queries = 0, invocation = 0, clock = 100000;
  DynamoDBDocumentClient.prototype.send = async (command) => {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    if (name === 'QueryCommand') {
      if (scenario === 'query-failure') throw failure();
      queries++;
      if (scenario === 'warm-query-failure' && invocation === 0 && queries === 2) throw failure();
      return { Items: [items[queries - 1]], ...(queries === 1 ? { LastEvaluatedKey: { pk: 'synthetic-cursor' } } : {}) };
    }
    if (name !== 'DeleteCommand') { unexpectedSends++; throw new Error('Unexpected document SDK send'); }
    if (scenario === 'delete-failure' || (scenario === 'warm-delete-failure' && invocation === 0 && queries === 2)) throw failure();
    if (scenario === 'conflict' && calls.length === 2) {
      throw Object.assign(failure(), { name: 'ConditionalCheckFailedException' });
    }
    return {};
  };
  Date.now = () => clock;
  const write = process.stdout.write;
  process.stdout.write = (line) => { lines.push(String(line)); return true; };
  const { handler } = await import(process.argv[1]);
  const invokeHandler = async () => {
    let budgetChecks = 0;
    try {
      const value = await handler({ privatePayload: privateValue }, {
        // Exactly five seconds is exhausted; stop warm work after its first page.
        getRemainingTimeInMillis: () => scenario === 'budget' ||
          (scenario === 'warm-budget' && invocation === 0 && ++budgetChecks >= 3) ? 5000 : 5001,
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: { name: error.name, message: error.message,
        hasCause: Object.hasOwn(error, 'cause'), keys: Object.keys(error), inspected: inspect(error) } };
    }
  };
  let result;
  if (scenario.startsWith('warm-')) {
    const invocations = [];
    for (invocation = 0; invocation < 3; invocation++) {
      clock = 100000 + invocation * 100000;
      queries = 0;
      const callStart = calls.length, lineStart = lines.length;
      const outcome = await invokeHandler();
      invocations.push({ ...outcome, calls: calls.slice(callStart), lines: lines.slice(lineStart) });
    }
    result = { invocations };
  } else {
    result = await invokeHandler();
  }
  process.stdout.write = write;
  process.stdout.write(JSON.stringify({ ...result, calls, lines, connections, unexpectedSends }));
`;

function invoke(entry, scenario) {
  const processResult = spawnSync(process.execPath, ['--input-type=module', '--eval', child,
    new URL(`../src/${entry}.mjs`, import.meta.url).href, scenario], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    env: { AWS_REGION: 'eu-west-2', AWS_EC2_METADATA_DISABLED: 'true',
      AWS_LAMBDA_FUNCTION_NAME: 'synthetic-cleanup', ROOM_TABLE_NAME: 'test-rooms',
      ...(entry === 'locationCleanupLambda' ? { LOCATION_TABLE_NAME: 'test-locations', SESSION_TABLE_NAME: 'test-sessions' } : {}),
    },
  });
  assert.equal(processResult.error, undefined);
  assert.equal(processResult.signal, null);
  assert.equal(processResult.status, 0, processResult.stderr);
  const report = JSON.parse(processResult.stdout);
  assert.equal(report.connections, 0);
  assert.equal(report.unexpectedSends, 0);
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_PRIVATE_HANDLER_SENTINEL'), false);
  return report;
}

function expectedQuery(room, page = 0, at = 100000) {
  return { name: 'QueryCommand', input: {
    TableName: room ? 'test-rooms' : 'test-locations', IndexName: 'ExpiryIndex',
    KeyConditionExpression: `cleanupBucket = :bucket AND ${room ? 'purgeAt' : 'expiresAt'} <= :now`,
    ExpressionAttributeValues: { ':bucket': room ? 'ROOMS' : 'ACTIVE', ':now': at }, Limit: 100,
    ...(page ? { ExclusiveStartKey: { pk: 'synthetic-cursor' } } : {}),
  } };
}
function expectedDelete(room, index, at = 100000) {
  return { name: 'DeleteCommand', input: {
    TableName: room ? 'test-rooms' : 'test-locations',
    Key: room ? { pk: `ROOM#synthetic-${index}` } : { pk: 'ROOM#synthetic', sk: `POINT#synthetic-${index}` },
    ConditionExpression: room ? '#version = :version AND purgeAt = :purgeAt AND purgeAt <= :now' : '#version = :version AND expiresAt <= :now',
    ExpressionAttributeNames: { '#version': room ? 'revision' : 'pointVersion' },
    ExpressionAttributeValues: { ':version': room ? index + 1 : `v${index}`,
      ...(room ? { ':purgeAt': 90000 + index * 1000 } : {}), ':now': at },
  } };
}
function assertMetric(report, values, at = 100000) {
  assert.equal(report.lines.length, 1, 'one aggregate metric record per invocation');
  assert.deepEqual(JSON.parse(report.lines[0]), {
    _aws: { Timestamp: at, CloudWatchMetrics: [{ Namespace: 'Bendbound/GroupRides',
      Dimensions: [['FunctionName']], Metrics: Object.keys(values).map((Name) => ({ Name,
        Unit: Name === 'OldestObservedOverdueMs' ? 'Milliseconds' : 'Count' })),
    }] }, FunctionName: 'synthetic-cleanup', ...values,
  });
}

for (const entry of ['locationCleanupLambda', 'roomCleanupLambda']) {
  const room = entry === 'roomCleanupLambda', entity = room ? 'Rooms' : 'Points';
  for (const scenario of ['success', 'conflict', 'budget']) {
    test(`${entry}: real handler ${scenario} keeps table scope and entity metrics`, () => {
      const report = invoke(entry, scenario), budget = scenario === 'budget';
      const deleted = budget ? 0 : scenario === 'conflict' ? 1 : 2;
      assert.equal(report.ok, true);
      assert.deepEqual(report.value, { deleted, examined: budget ? 0 : 2, more: budget, oldestOverdueMs: budget ? 0 : 10000 });
      assert.deepEqual(report.calls, budget ? [] : [expectedQuery(room), expectedDelete(room, 0), expectedQuery(room, 1), expectedDelete(room, 1)]);
      assertMetric(report, { CleanupSucceeded: 1, CleanupFailed: 0, CleanupBacklog: budget ? 1 : 0,
        [`${entity}Deleted`]: deleted, [`${entity}Examined`]: budget ? 0 : 2, OldestObservedOverdueMs: budget ? 0 : 10000 });
    });
  }
  for (const scenario of ['query-failure', 'delete-failure']) {
    test(`${entry}: real handler sanitizes ${scenario} without retry or other-table effects`, () => {
      const report = invoke(entry, scenario);
      assert.equal(report.ok, false);
      assert.equal(report.error.name, 'Error');
      assert.equal(report.error.message, room ? 'GROUP_ROOM_CLEANUP_FAILED' : 'GROUP_LOCATION_CLEANUP_FAILED');
      assert.equal(report.error.hasCause, false);
      assert.deepEqual(report.error.keys, []);
      assert.deepEqual(report.calls, scenario === 'query-failure' ? [expectedQuery(room)] : [expectedQuery(room), expectedDelete(room, 0)]);
      assertMetric(report, { CleanupSucceeded: 0, CleanupFailed: 1 });
    });
  }
}

for (const entry of ['locationCleanupLambda', 'roomCleanupLambda']) {
  const room = entry === 'roomCleanupLambda', entity = room ? 'Rooms' : 'Points';
  for (const scenario of ['warm-budget', 'warm-query-failure', 'warm-delete-failure']) {
    test(`${entry}: same handler recovers from ${scenario} with fresh invocation state`, () => {
      const report = invoke(entry, scenario);
      assert.equal(report.invocations.length, 3);
      const [first, ...recovered] = report.invocations;
      const firstCalls = [expectedQuery(room), expectedDelete(room, 0)];
      if (scenario !== 'warm-budget') firstCalls.push(expectedQuery(room, 1));
      if (scenario === 'warm-delete-failure') firstCalls.push(expectedDelete(room, 1));
      assert.deepEqual(first.calls, firstCalls);
      if (scenario === 'warm-budget') {
        assert.equal(first.ok, true);
        assert.deepEqual(first.value, { deleted: 1, examined: 1, more: true, oldestOverdueMs: 10000 });
        assertMetric(first, { CleanupSucceeded: 1, CleanupFailed: 0, CleanupBacklog: 1,
          [`${entity}Deleted`]: 1, [`${entity}Examined`]: 1, OldestObservedOverdueMs: 10000 });
      } else {
        assert.equal(first.ok, false);
        assert.equal(first.error.message, room ? 'GROUP_ROOM_CLEANUP_FAILED' : 'GROUP_LOCATION_CLEANUP_FAILED');
        assert.equal(first.error.name, 'Error');
        assert.equal(first.error.hasCause, false);
        assert.deepEqual(first.error.keys, []);
        assertMetric(first, { CleanupSucceeded: 0, CleanupFailed: 1 });
      }
      recovered.forEach((outcome, index) => {
        const at = 200000 + index * 100000;
        assert.equal(outcome.ok, true);
        assert.deepEqual(outcome.value, { deleted: 2, examined: 2, more: false, oldestOverdueMs: at - 90000 });
        // Restart at the oldest entry, never a previous invocation's cursor or cutoff.
        assert.deepEqual(outcome.calls, [expectedQuery(room, 0, at), expectedDelete(room, 0, at),
          expectedQuery(room, 1, at), expectedDelete(room, 1, at)]);
        assertMetric(outcome, { CleanupSucceeded: 1, CleanupFailed: 0, CleanupBacklog: 0,
          [`${entity}Deleted`]: 2, [`${entity}Examined`]: 2, OldestObservedOverdueMs: at - 90000 }, at);
      });
    });
  }
}
