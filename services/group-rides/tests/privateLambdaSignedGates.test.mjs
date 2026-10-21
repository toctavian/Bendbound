import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

// Real exported handlers and signature verification; only the synthetic JWKS
// cache and external SDK boundary are controlled. No inherited credentials.
const sentinel = 'SYNTHETIC_PRIVATE_SIGNED_GATE_SENTINEL';
const child = `
  import assert from 'node:assert/strict';
  import { createHash, generateKeyPairSync, sign } from 'node:crypto';
  let connections = 0, rawSends = 0, verifiers = 0;
  const lines = [], violations = [], outcomes = [];
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
  // Anchor away from a minute edge so controlled short advances stay in-window.
  const at = Math.floor(Date.now() / 60000) * 60000 + 10000;
  let time = at;
  Date.now = () => time; // Controlled synthetic samples; not elapsed-time evidence.
  const subject = 'synthetic-user', family = 'synthetic-family';
  const digest = (text) => createHash('sha256').update(text).digest('hex');
  const keys = { user: 'USER#' + digest(subject), family: 'SESSION#' + digest(family),
    capability: 'LOGOUT#' + digest('a'.repeat(64)) };
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { CognitoJwtVerifier } = await import('aws-jwt-verify');
  const originalCreate = CognitoJwtVerifier.create;
  CognitoJwtVerifier.create = function (...args) {
    const verifier = originalCreate.apply(this, args);
    verifier.cacheJwks({ keys: [{ ...publicKey.export({ format: 'jwk' }),
      kid: 'synthetic-key', alg: 'RS256', use: 'sig' }] });
    verifiers++;
    return verifier;
  };
  function token(patch = {}, tamper = false) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = { iss: 'https://cognito-idp.eu-west-2.amazonaws.com/' + process.env.COGNITO_USER_POOL_ID,
      client_id: process.env.COGNITO_CLIENT_ID, token_use: 'access', sub: subject,
      origin_jti: family, scope: 'openid bendbound/groups', exp: at / 1000 + 300,
      iat: Math.floor(at / 1000), auth_time: Math.floor(at / 1000), ...patch };
    const body = encode({ alg: 'RS256', kid: 'synthetic-key' }) + '.' + encode(claims);
    const signature = sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url');
    return (tamper ? body.split('.')[0] + '.' + encode({ ...claims, sub: 'tampered-user' }) : body) + '.' + signature;
  }
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  DynamoDBClient.prototype.send = () => { rawSends++; throw new Error('Unexpected raw SDK send'); };
  let queue = [], calls = [];
  const failure = (name = 'SyntheticFailure') => Object.assign(new Error(process.argv[3],
    { cause: new Error(process.argv[3]) }), { name });
  function consume(kind, command) {
    calls.push(kind + ':' + command.constructor.name);
    const next = queue.shift();
    try {
      assert.ok(next, 'unexpected SDK call');
      assert.equal(kind, next.kind);
      assert.equal(command.constructor.name, next.name);
      next.check(command.input);
    } catch (error) { violations.push(error.message); throw error; }
    if (next.advance !== undefined) time = at + next.advance;
    if (next.error) throw next.error;
    return next.reply ?? {};
  }
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  DynamoDBDocumentClient.prototype.send = async (command) => consume('document', command);
  const { CognitoIdentityProviderClient } = await import('@aws-sdk/client-cognito-identity-provider');
  CognitoIdentityProviderClient.prototype.send = async (command) => consume('provider', command);
  const write = process.stdout.write;
  process.stdout.write = (line) => { lines.push(String(line)); return true; };
  const { handler } = await import(process.argv[1]);
  for (const scenario of JSON.parse(process.argv[2])) {
    calls = [];
    time = at;
    const jwt = token({ ...(scenario.tokenLifetime !== undefined ? { exp: (at + scenario.tokenLifetime) / 1000 } : {}),
      ...scenario.patch }, scenario.tamper);
    const user = { subject, state: 'active', pilotExpiresAt: at + (scenario.pilotLifetime ?? 60000), ...scenario.user };
    const session = { subject, state: 'active', expiresAt: at + (scenario.familyLifetime ?? 60000), ...scenario.family };
    const read = (key, value) => ({ kind: 'document', name: 'GetCommand',
      check: (input) => assert.deepEqual(input, { TableName: 'test-sessions', Key: { pk: keys[key] }, ConsistentRead: true }),
      reply: { Item: value },
      ...(scenario.advanceRead?.key === key ? { advance: scenario.advanceRead.elapsed } : {}),
      ...(scenario.readFailure === key ? { error: failure() } : {}) });
    queue = [];
    const isSession = process.argv[1].includes('sessionLambda');
    if (!scenario.noIo) {
      if (isSession) queue.push({ kind: 'document', name: 'TransactWriteCommand', check: (input) => {
        assert.equal(input.TransactItems.length, 2);
        const operation = scenario.revoke ? 'logout' : scenario.bootstrap ? 'bootstrap' : 'status';
        const window = Math.floor(at / 60000);
        const account = digest(JSON.stringify([window, operation, subject]));
        assert.deepEqual(input.TransactItems.map((item) => ({ table: item.Update.TableName, pk: item.Update.Key.pk })),
          ['GLOBAL', account].map((suffix) => ({ table: 'test-account-budget', pk: 'ACCOUNT_RATE#' + operation + '#' + window + '#' + suffix })));
        if (scenario.revoke || scenario.statusTiming) assert.deepEqual(input, { TransactItems: ['GLOBAL', account].map((suffix, i) => ({ Update: {
          TableName: 'test-account-budget', Key: { pk: 'ACCOUNT_RATE#' + operation + '#' + window + '#' + suffix },
          UpdateExpression: 'SET #ttl = :ttl ADD #count :one',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':ttl': Math.ceil(((window + 2) * 60000) / 1000), ':one': 1, ':limit': operation === 'status' ? (i ? 60 : 600) : (i ? 6 : 60) },
        } })) });
      }, ...(scenario.budgetAdvance !== undefined ? { advance: scenario.budgetAdvance } : {}),
      ...(scenario.budgetError ? { error: scenario.budgetError === 'outage' ? failure()
        : Object.assign(failure('TransactionCanceledException'), { CancellationReasons: [
          { Code: scenario.budgetError === 'global' ? 'ConditionalCheckFailed' : 'None' },
          { Code: scenario.budgetError === 'account' ? 'ConditionalCheckFailed' : 'None' },
        ] }) } : {}) });
      if (!scenario.revoke && !scenario.stopAfterBudget) {
        if (!scenario.bootstrap) queue.push(read('family', scenario.missingFamily ? undefined : session));
        queue.push(read('user', scenario.missingUser ? undefined : user));
      }
      if (scenario.provider) queue.push({ kind: 'provider', name: 'GetUserCommand',
        check: (input) => assert.deepEqual(input, { AccessToken: jwt }),
        ...(scenario.provider === 'matching'
          ? { reply: { UserAttributes: [{ Name: 'sub', Value: subject }] } }
          : scenario.provider === 'mismatch'
          ? { reply: { UserAttributes: [{ Name: 'sub', Value: 'another-synthetic-user' }] } }
          : { error: failure(scenario.provider) }) });
    }
    if (scenario.revoke && !scenario.noIo && !scenario.budgetError && scenario.budgetAdvance === undefined) {
      queue.push({ kind: 'document', name: 'UpdateCommand', check: (input) => {
        const deadline = time + 30 * 24 * 60 * 60000;
        assert.deepEqual(input, { TableName: 'test-sessions', Key: { pk: keys.family },
          ConditionExpression: 'attribute_not_exists(pk) OR subject = :subject',
          UpdateExpression: 'SET subject = :subject, #state = :revoked, revokedAt = :now, expiresAt = :deadline, #ttl = :ttl',
          ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':subject': subject, ':revoked': 'revoked', ':now': time,
            ':deadline': deadline, ':ttl': Math.ceil(deadline / 1000) } });
      }, ...(scenario.updateError ? { error: failure(scenario.updateError) } : {}),
      ...(scenario.updateAdvance !== undefined ? { advance: scenario.updateAdvance } : {}) });
    }
    for (const attempt of scenario.registration ?? []) {
      const existing = attempt.existing ? { ...session, logoutKey: keys.capability, ...attempt.family } : undefined;
      const capability = attempt.capability ? { subject, familyKey: keys.family, state: 'active',
        expiresAt: session.expiresAt, ...attempt.capability } : undefined;
      const registrationUser = { ...user, ...attempt.user };
      queue.push(read('family', existing), read('capability', capability), {
        ...read('user', registrationUser),
        ...(attempt.advanceRead !== undefined ? { advance: attempt.advanceRead } : {}),
        ...(attempt.readError ? { error: failure() } : {}),
      });
      if (!attempt.write) continue;
      queue.push({ kind: 'document', name: 'TransactWriteCommand', check: (input) => {
        assert.equal(input.TransactItems.length, 3);
        const [admission, familyWrite, capWrite] = input.TransactItems;
        assert.deepEqual(admission, { ConditionCheck: { TableName: 'test-sessions', Key: { pk: keys.user },
          ConditionExpression: '#state = :active AND subject = :subject AND pilotExpiresAt > :now AND attribute_not_exists(lifecycleHold)',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':active': 'active', ':subject': subject, ':now': time } } });
        const deadline = existing?.expiresAt ?? Math.floor(at / 1000) * 1000 + 30 * 24 * 60 * 60000;
        const expectedItem = { subject, state: 'active', expiresAt: deadline, ttl: Math.ceil(deadline / 1000) };
        if (existing) {
          assert.equal(familyWrite.Update.TableName, 'test-sessions');
          assert.deepEqual(familyWrite.Update.Key, { pk: keys.family });
          assert.equal(familyWrite.Update.UpdateExpression, 'SET logoutKey = :key');
          assert.deepEqual(familyWrite.Update.ExpressionAttributeValues,
            { ':key': keys.capability, ':active': 'active', ':subject': subject, ':deadline': deadline });
          assert.equal(familyWrite.Update.ConditionExpression,
            '#state = :active AND subject = :subject AND expiresAt = :deadline AND (attribute_not_exists(logoutKey) OR logoutKey = :key)');
        } else assert.deepEqual(familyWrite, { Put: { TableName: 'test-sessions',
          Item: { pk: keys.family, ...expectedItem, logoutKey: keys.capability, createdAt: time },
          ConditionExpression: 'attribute_not_exists(pk)' } });
        assert.deepEqual(capWrite, { Put: { TableName: 'test-sessions',
          Item: { pk: keys.capability, ...expectedItem, familyKey: keys.family },
          ConditionExpression: 'attribute_not_exists(pk) OR (#state = :active AND subject = :subject AND familyKey = :family AND expiresAt = :deadline)',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':active': 'active', ':subject': subject, ':family': keys.family, ':deadline': deadline } } });
        assert.equal(JSON.stringify(input).includes('a'.repeat(64)), false);
      }, ...(attempt.advanceWrite !== undefined ? { advance: attempt.advanceWrite } : {}),
      ...(attempt.conflict ? { error: Object.assign(failure('TransactionCanceledException'),
        { CancellationReasons: [{ Code: attempt.conflict }] }) } : attempt.writeError ? { error: failure() } : {}) });
    }
    if (scenario.roomCreate) {
      const step = scenario.roomCreate;
      queue.push({ kind: 'document', name: 'TransactWriteCommand', check: (input) => {
        const window = Math.floor(at / 60000);
        const account = digest(JSON.stringify([window, 'create', subject]));
        assert.deepEqual(input, { TransactItems: ['GLOBAL', account].map((suffix, i) => ({ Update: {
          TableName: 'test-room-budget', Key: { pk: 'ROOM_RATE#create#' + window + '#' + suffix },
          UpdateExpression: 'SET #ttl = :ttl ADD #count :one',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':ttl': Math.ceil(((window + 2) * 60000) / 1000), ':one': 1, ':limit': i ? 6 : 60 },
        } })) });
      }, ...(step.advance !== undefined ? { advance: step.advance } : {}),
      ...(step.error ? { error: step.error === 'outage' ? failure()
        : Object.assign(failure('TransactionCanceledException'), { CancellationReasons: [
          { Code: step.error === 'global' ? 'ConditionalCheckFailed' : 'None' },
          { Code: step.error === 'account' ? 'ConditionalCheckFailed' : 'None' },
        ] }) } : {}) });
      if (!step.stop) for (const key of ['family', 'user']) queue.push({
        ...read(key, { ...(key === 'family' ? session : user), ...step[key] }),
        ...(step.advanceRead?.key === key ? { advance: step.advanceRead.elapsed } : {}),
        ...(step.readFailure === key ? { error: failure() } : {}),
      });
    }
    if (scenario.snapshot) {
      const step = scenario.snapshot;
      const id = 'b'.repeat(64), roomKey = { pk: 'ROOM#' + id };
      queue.push({ kind: 'document', name: 'TransactWriteCommand', check: (input) => {
        const window = Math.floor(at / 60000), account = digest(JSON.stringify([window, 'snapshot', subject]));
        assert.deepEqual(input, { TransactItems: ['GLOBAL', account].map((suffix, i) => ({ Update: {
          TableName: 'test-room-budget', Key: { pk: 'ROOM_RATE#snapshot#' + window + '#' + suffix },
          UpdateExpression: 'SET #ttl = :ttl ADD #count :one',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':ttl': Math.ceil(((window + 2) * 60000) / 1000), ':one': 1, ':limit': i ? 60 : 600 },
        } })) });
      }, ...(step.budgetAdvance !== undefined ? { advance: step.budgetAdvance } : {}),
      ...(step.budgetError ? { error: step.budgetError === 'outage' ? failure()
        : Object.assign(failure('TransactionCanceledException'), { CancellationReasons: [
          { Code: step.budgetError === 'global' ? 'ConditionalCheckFailed' : 'None' },
          { Code: step.budgetError === 'account' ? 'ConditionalCheckFailed' : 'None' },
        ] }) } : {}) });
      if (!step.stop) for (const readStep of (step.reads ?? Array.from({ length: step.revisions ? 6 : 1 }, () => ({})))) {
        const current = { ...step, ...readStep };
        const roster = (spec) => [subject, 'synthetic-peer'].map((userId) => ({ userId,
          displayName: userId === subject ? 'Synthetic rider' : 'Synthetic peer', motorcycleType: 'adventure',
          sharing: Boolean(spec.sharing?.includes(userId === subject ? 'viewer' : 'peer')),
          deviceEpoch: 'synthetic-private-epoch',
          deviceFamily: userId === subject ? (spec.otherDevice ? 'synthetic-other-family' : family) : (spec.peerDeviceFamily ?? 'synthetic-peer-family'),
          deviceStartedAt: at }));
        const members = roster(current);
        const room = { id, revision: current.revision ?? 1, title: 'Synthetic ride', state: current.sharing ? 'riding' : 'lobby', expiresAt: at + 43200000,
          ownerId: subject, routeSnapshotId: null, members, invite: 'synthetic-private-invite', commands: ['synthetic-private-command'] };
        const discovery = current.discoveryMissing ? undefined : { ...room, ...current.discoveryRoom,
          ...(current.discoveryRemoved ? { members: members.slice(1) } : {}) };
        queue.push({ kind: 'document', name: 'GetCommand', check: (input) =>
          assert.deepEqual(input, { TableName: 'test-rooms', Key: roomKey, ConsistentRead: true }),
          reply: { Item: discovery ? { room: discovery } : undefined },
          ...(current.discoveryAdvance !== undefined ? { advance: current.discoveryAdvance } : {}),
          ...(current.discoveryError ? { error: failure() } : {}) });
        if (current.discoveryStop) break;
        const atomic = current.roomMissing ? undefined : { ...room, ...current.room,
          ...(current.atomicRoster ? { members: roster(current.atomicRoster) } : {}),
          ...(current.removed ? { members: members.slice(1) } : {}), ...(current.revisions ? { revision: 2 } : {}) };
        queue.push({ kind: 'document', name: 'TransactGetCommand', check: (input) => {
          assert.deepEqual(input, { TransactItems: [
            { Get: { TableName: 'test-rooms', Key: roomKey } },
            { Get: { TableName: 'test-sessions', Key: { pk: keys.family } } },
            { Get: { TableName: 'test-sessions', Key: { pk: keys.user } } },
            { Get: { TableName: 'test-locations', Key: { ...roomKey, sk: 'RIDER#' + digest(subject) } } },
            ...(current.sharing?.includes('viewer') && current.otherDevice ? [
              { Get: { TableName: 'test-sessions', Key: { pk: 'SESSION#' + digest('synthetic-other-family') } } },
            ] : []),
            { Get: { TableName: 'test-locations', Key: { ...roomKey, sk: 'RIDER#' + digest('synthetic-peer') } } },
            ...(current.sharing?.includes('peer') ? [
              { Get: { TableName: 'test-sessions', Key: { pk: 'SESSION#' + digest(current.peerDeviceFamily ?? 'synthetic-peer-family') } } },
              { Get: { TableName: 'test-sessions', Key: { pk: 'USER#' + digest('synthetic-peer') } } },
            ] : []),
          ] });
        }, reply: { Responses: [
          { Item: atomic ? { room: atomic } : undefined },
          { Item: current.missingFamily ? undefined : { ...session, ...current.family } },
          { Item: current.missingUser ? undefined : { ...user, ...current.user } }, {},
          ...(current.sharing?.includes('viewer') && current.otherDevice ? [{
            Item: current.missingOtherFamily ? undefined : { ...session, ...current.otherFamily },
          }] : []), {},
          ...(current.sharing?.includes('peer') ? [
            { Item: current.missingPeerFamily ? undefined : { ...session, subject: 'synthetic-peer', ...current.peerFamily,
              ...(current.peerFamily?.expiresAt === 'relative-deadline' ? { expiresAt: at + 1000 } : {}) } },
            { Item: current.missingPeerUser ? undefined : { ...user, subject: 'synthetic-peer', ...current.peerUser,
              ...(current.peerUser?.pilotExpiresAt === 'relative-deadline' ? { pilotExpiresAt: at + 1000 } : {}) } },
          ] : []),
        ] }, ...(current.advance !== undefined ? { advance: current.advance } : {}),
        ...(current.readError ? { error: failure(current.readError) } : {}) });
      }
    }
    const commandId = '12345678-1234-4234-8234-123456789abc';
    const profile = { title: 'Synthetic ride', displayName: 'Synthetic rider', motorcycleType: 'adventure',
      routeSnapshotId: null, durationMs: scenario.metadata?.durationMs ?? 43200000 };
    if (scenario.metadata) {
      const step = scenario.metadata;
      const id = digest(subject + '\\0' + commandId);
      const createdAt = time;
      const room = { id, revision: 1, ...profile, ownerId: subject, state: 'lobby', createdAt,
        expiresAt: createdAt + profile.durationMs,
        members: [{ userId: subject, displayName: profile.displayName, motorcycleType: profile.motorcycleType,
          joinedAt: createdAt, sharing: false, deviceEpoch: null, deviceFamily: null, deviceStartedAt: null }],
        invite: null, commands: [], creationFingerprint: digest(JSON.stringify(profile)) };
      queue.push({ kind: 'document', name: 'TransactWriteCommand', check: (input) => {
        const retention = room.expiresAt + 86400000;
        assert.deepEqual(input, { TransactItems: [
          { Put: { TableName: 'test-rooms', Item: { pk: 'ROOM#' + id, room, revision: 1,
            cleanupBucket: 'ROOMS', purgeAt: retention - 60000, ttl: Math.ceil(retention / 1000) },
            ConditionExpression: 'attribute_not_exists(pk)' } },
          { ConditionCheck: { TableName: 'test-sessions', Key: { pk: keys.family },
            ConditionExpression: '#state = :active AND subject = :subject AND expiresAt > :now',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: { ':active': 'active', ':subject': subject, ':now': createdAt } } },
          { ConditionCheck: { TableName: 'test-sessions', Key: { pk: keys.user },
            ConditionExpression: '#state = :active AND subject = :subject AND pilotExpiresAt > :now AND attribute_not_exists(lifecycleHold)',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: { ':active': 'active', ':subject': subject, ':now': createdAt } } },
        ] });
        for (const forbidden of [jwt, family, 'latitude', 'longitude', 'accessToken', 'refreshToken'])
          assert.equal(JSON.stringify(input).includes(forbidden), false);
      }, ...(step.error ? { error: step.error === 'conditional'
        ? Object.assign(failure('TransactionCanceledException'), { CancellationReasons: [
          { Code: step.conflictIndex === undefined ? 'ConditionalCheckFailed' : 'None' }, { Code: step.conflictIndex === 1 ? 'ConditionalCheckFailed' : 'None' },
          { Code: step.conflictIndex === 2 ? 'ConditionalCheckFailed' : 'None' },
        ] }) : failure(step.error) } : {}) });
      if (step.error === 'conditional') {
        queue.push(read('family', { ...session, ...step.family }), read('user', { ...user, ...step.user }));
        if (step.readBack) queue.push({ kind: 'document', name: 'GetCommand', check: (input) =>
          assert.deepEqual(input, { TableName: 'test-rooms', Key: { pk: 'ROOM#' + id }, ConsistentRead: true }),
          reply: { Item: step.readBack === 'missing' ? undefined : { room: {
            ...room, ...(step.readBack === 'mismatch' ? { creationFingerprint: 'different' } : {}),
          } } } });
      }
    }
    const event = { rawPath: isSession ? '/v1/session' : scenario.snapshot ? '/v1/rooms/' + 'b'.repeat(64) : '/v1/rooms',
      requestContext: { http: { method: scenario.snapshot ? 'GET' : scenario.revoke ? 'DELETE' : scenario.bootstrap || !isSession ? 'POST' : 'GET', sourceIp: '192.0.2.1' } },
      headers: { authorization: 'Bearer ' + jwt },
      body: scenario.snapshot ? '' : scenario.bootstrap ? JSON.stringify({ logoutSecret: 'a'.repeat(64) }) : isSession ? '' : scenario.metadata ? JSON.stringify({ command: { id: commandId, createdAt: at }, ...profile }) : scenario.roomCreate ? '{}' : '{' };
    const response = await handler(event);
    if (queue.length) violations.push('unconsumed SDK expectations: ' + queue.length);
    outcomes.push({ response, calls });
  }
  process.stdout.write = write;
  process.stdout.write(JSON.stringify({ outcomes, violations, lines, connections, rawSends, verifiers, at }));
`;
const env = {
  AWS_REGION: 'eu-west-2', AWS_EC2_METADATA_DISABLED: 'true',
  SESSION_TABLE_NAME: 'test-sessions', ROOM_TABLE_NAME: 'test-rooms',
  GROUP_LOBBY_ONLY: 'false', LOCATION_TABLE_NAME: 'test-locations', ROOM_BUDGET_TABLE_NAME: 'test-room-budget',
  ACCOUNT_BUDGET_TABLE_NAME: 'test-account-budget', LOGOUT_BUDGET_TABLE_NAME: 'test-logout-budget',
  COGNITO_USER_POOL_ID: 'eu-west-2_SyntheticPool', COGNITO_CLIENT_ID: 'synthetic-client',
};
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const userDenials = [
  { name: 'missing admission', missingUser: true },
  { name: 'blocked admission', user: { state: 'blocked' } },
  { name: 'expired admission', user: { pilotExpiresAt: 0 } },
  { name: 'lifecycle hold', user: { lifecycleHold: 'synthetic-hold' } },
  { name: 'mismatched admission subject', user: { subject: 'another-synthetic-user' } },
];
const sessionDenials = [
  ...userDenials,
  { name: 'missing family', missingFamily: true },
  { name: 'revoked family', family: { state: 'revoked' } },
  { name: 'expired family', family: { expiresAt: 0 } },
  { name: 'mismatched family subject', family: { subject: 'another-synthetic-user' } },
  { name: 'registry read outage', readFailure: 'user' },
];
const signatureDenials = [
  { name: 'signed wrong client', patch: { client_id: 'another-client' } },
  { name: 'signed missing group scope', patch: { scope: 'openid' } },
  { name: 'tampered signed subject', tamper: true },
].map((scenario) => ({ ...scenario, noIo: true }));
async function verify(t, entry, scenarios) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', child,
    new URL(`../src/${entry}.mjs`, import.meta.url).href, JSON.stringify(scenarios), sentinel], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.lines, []);
  assert.equal(report.connections, 0);
  assert.equal(report.rawSends, 0);
  assert.equal(report.verifiers, 1, 'one real cached verifier per warm handler');
  assert.equal(JSON.stringify(report).includes(sentinel), false);
  assert.equal(report.outcomes.length, scenarios.length);
  for (let i = 0; i < scenarios.length; i++) await t.test(scenarios[i].name, () => {
    const scenario = scenarios[i], outcome = report.outcomes[i];
    const statusCode = scenario.statusCode ?? 401;
    const body = scenario.revoked ? { revoked: true } : scenario.success ? { userId: 'synthetic-user', expiresAt: report.at + (scenario.tokenLifetime ?? 300000), serverTime: report.at + (scenario.responseAdvance ?? 0) }
      : { error: scenario.error ?? 'UNAUTHORIZED' };
    if (scenario.created) {
      const id = createHash('sha256').update('synthetic-user\0' + '12345678-1234-4234-8234-123456789abc').digest('hex');
      Object.assign(body, { room: { version: 1, id, revision: 1, title: 'Synthetic ride', state: 'lobby',
        expiresAt: report.at + (scenario.metadata.durationMs ?? 43200000), routeSnapshotId: null,
        members: [{ userId: 'synthetic-user', displayName: 'Synthetic rider', motorcycleType: 'adventure',
          role: 'owner', sharing: false, fix: null }] } });
      delete body.error;
    }
    if (scenario.snapshotOk) {
      delete body.error;
      const final = { ...scenario.snapshot, ...scenario.snapshot.reads?.at(-1) };
      body.room = { version: 1, id: 'b'.repeat(64), revision: final.revision ?? 1, title: 'Synthetic ride', state: final.sharing ? 'riding' : 'lobby',
        expiresAt: report.at + 43200000, routeSnapshotId: null,
        members: ['synthetic-user', 'synthetic-peer'].map((userId, index) => ({ userId,
          displayName: index ? 'Synthetic peer' : 'Synthetic rider', motorcycleType: 'adventure',
          role: index ? 'member' : 'owner',
          sharing: Boolean(final.sharing?.includes(index ? 'peer' : 'viewer')), fix: null })) };
    }
    if (scenario.snapshot) for (const forbidden of ['synthetic-private-invite', 'synthetic-private-command',
      'deviceFamily', 'deviceEpoch', 'deviceStartedAt', 'synthetic-private-epoch',
      'synthetic-family', 'synthetic-other-family', 'synthetic-peer-family', 'synthetic-rotated-family', 'familyHash', 'latitude', 'longitude', 'accessToken', 'refreshToken'])
      assert.equal(outcome.response.body.includes(forbidden), false);
    const expectedHeaders = scenario.retryAfter ? { ...headers, 'Retry-After': String(Math.ceil(((Math.floor(report.at / 60000) + 1) * 60000 - report.at) / 1000)) } : headers;
    assert.deepEqual(outcome.response, { statusCode, headers: expectedHeaders, body: JSON.stringify(body) });
    const expected = scenario.noIo ? [] : scenario.stopAfterBudget ? ['document:TransactWriteCommand'] : scenario.revoke ? ['document:TransactWriteCommand',
      ...(!scenario.budgetError && scenario.budgetAdvance === undefined ? ['document:UpdateCommand'] : [])] : [
      ...(entry === 'sessionLambda' ? ['document:TransactWriteCommand'] : []),
      ...(!scenario.bootstrap ? ['document:GetCommand'] : []), 'document:GetCommand',
      ...(scenario.roomCreate ? ['document:TransactWriteCommand',
        ...(!scenario.roomCreate.stop ? ['document:GetCommand', 'document:GetCommand'] : [])] : []),
      ...(scenario.snapshot ? ['document:TransactWriteCommand', ...(!scenario.snapshot.stop
        ? (scenario.snapshot.reads ?? Array.from({ length: scenario.snapshot.revisions ? 6 : 1 }, () => ({})))
          .flatMap((readStep) => ['document:GetCommand',
            ...(!(readStep.discoveryStop ?? scenario.snapshot.discoveryStop) ? ['document:TransactGetCommand'] : [])]) : [])] : []),
      ...(scenario.metadata ? ['document:TransactWriteCommand',
        ...(scenario.metadata.error === 'conditional' ? ['document:GetCommand', 'document:GetCommand',
          ...(scenario.metadata.readBack ? ['document:GetCommand'] : [])] : [])] : []),
      ...(scenario.provider ? ['provider:GetUserCommand'] : []),
      ...(scenario.registration ?? []).flatMap((attempt) => [
        'document:GetCommand', 'document:GetCommand', 'document:GetCommand',
        ...(attempt.write ? ['document:TransactWriteCommand'] : []),
      ]),
    ];
    assert.deepEqual(outcome.calls, expected, 'exact gate and registration work; no unexpected writes or budget work');
  });
}

test('sessionLambda: signed bootstrap admission and provider rejection gates compose without registration', async (t) => {
  await verify(t, 'sessionLambda', [
    ...userDenials.map((scenario) => ({ ...scenario, bootstrap: true })),
    { name: 'admission read outage', bootstrap: true, readFailure: 'user', statusCode: 503, error: 'ACCOUNT_SERVICE_UNAVAILABLE' },
    ...['NotAuthorizedException', 'UserNotFoundException', 'PasswordResetRequiredException', 'mismatch', 'SyntheticProviderOutage'].map((provider) => ({
      name: 'provider ' + provider, bootstrap: true, provider,
      ...(provider === 'SyntheticProviderOutage' ? { statusCode: 503, error: 'ACCOUNT_SERVICE_UNAVAILABLE' } : {}),
    })),
    ...signatureDenials.map((scenario) => ({ ...scenario, bootstrap: true })),
    { name: 'warm admission denial after provider failures', bootstrap: true, missingUser: true },
  ]);
});

test('sessionLambda: real signed DELETE isolates logout budget and requests conditional family revocation', async (t) => {
  const success = { statusCode: 200, revoked: true };
  const unavailable = { statusCode: 503, error: 'ACCOUNT_SERVICE_UNAVAILABLE' };
  await verify(t, 'sessionLambda', [
    // No scripted reads: unknown, active or previously revoked families all use
    // the same conditional update. This checks composition, not persisted state.
    { name: 'signed logout requests unknown-family tombstone', ...success },
    { name: 'repeated signed logout requests the same conditional update', ...success },
    ...['global', 'account'].map((budgetError) => ({ name: budgetError + ' logout pool exhausted',
      budgetError, statusCode: 429, error: 'ACCOUNT_RATE_LIMITED', retryAfter: true })),
    { name: 'budget outage prevents family update', budgetError: 'outage', ...unavailable },
    { name: 'permit expires before revocation starts', budgetAdvance: 60000, ...unavailable },
    ...['ConditionalCheckFailedException', 'AccessDeniedException', 'SyntheticWriteOutage'].map((updateError) => ({
      name: 'family update ' + updateError, updateError, ...unavailable })),
    ...signatureDenials,
    ...[
      ['wrong issuer', { iss: 'https://example.invalid' }],
      ['wrong token purpose', { token_use: 'id' }],
      ['expired signed token', { exp: 1 }],
      ['missing session family', { origin_jti: null }],
    ].map(([name, patch]) => ({ name, patch, noIo: true })),
    { name: 'completed revocation succeeds after token expiry during update', updateAdvance: 300000, ...success },
    { name: 'warm revocation recovers after storage and signature failures', ...success },
    { name: 'warm recovery never bypasses next request budget', budgetError: 'account', statusCode: 429,
      error: 'ACCOUNT_RATE_LIMITED', retryAfter: true },
  ].map((scenario) => ({ ...scenario, revoke: true })));
});
test('sessionLambda: signed status enforces post-read deadlines and fresh status permits', async (t) => {
  const success = { statusCode: 200, success: true };
  const unavailable = { statusCode: 503, error: 'ACCOUNT_SERVICE_UNAVAILABLE' };
  await verify(t, 'sessionLambda', [
    ...['token', 'family', 'pilot'].flatMap((gate) => ['family', 'user'].flatMap((key) =>
      [999, 1000, 1001].map((elapsed) => ({
        name: gate + ' deadline after ' + key + ' read at ' + elapsed,
        [gate + 'Lifetime']: 1000, advanceRead: { key, elapsed },
        ...(elapsed === 999 ? { ...success, responseAdvance: elapsed } : {}),
      })))),
    ...['global', 'account'].map((budgetError) => ({ name: budgetError + ' status quota prevents reads',
      budgetError, stopAfterBudget: true, statusCode: 429, error: 'ACCOUNT_RATE_LIMITED', retryAfter: true })),
    { name: 'status budget outage prevents reads', budgetError: 'outage', stopAfterBudget: true, ...unavailable },
    { name: 'stale status permit prevents reads', budgetAdvance: 60000, stopAfterBudget: true, ...unavailable },
    ...['family', 'user'].map((key) => ({ name: 'held admission returned with delayed ' + key + ' read',
      user: { lifecycleHold: 'synthetic-hold' }, advanceRead: { key, elapsed: 999 } })),
    { name: 'family read outage is sanitized', readFailure: 'family', ...unavailable },
    { name: 'warm status recovers after deadline and storage denials', ...success },
    { name: 'warm recovered status still checks newly returned hold', user: { lifecycleHold: 'synthetic-hold' } },
  ].map((scenario) => ({ ...scenario, statusTiming: true })));
});

test('sessionLambda: real signed status rechecks admission and revocation on every warm request', async (t) => {
  const control = { name: 'active signed status control', statusCode: 200, success: true };
  await verify(t, 'sessionLambda', [control,
    ...sessionDenials.map((scenario) => ({ ...scenario,
      ...(scenario.readFailure ? { statusCode: 503, error: 'ACCOUNT_SERVICE_UNAVAILABLE' } : {}) })),
    ...signatureDenials, { ...control, name: 'active status recovers after denials' },
    { name: 'revoked again after successful status', family: { state: 'revoked' } },
  ]);
});
test('roomLambda: real signed live-session gates precede body validation and all room work', async (t) => {
  const control = { name: 'active signed gate reaches malformed body', statusCode: 400, error: 'INVALID_BODY' };
  await verify(t, 'roomLambda', [control, ...sessionDenials, ...signatureDenials,
    { ...control, name: 'active gate recovers after denials' },
    { name: 'revoked again after active control', family: { state: 'revoked' } },
  ]);
});

test('roomLambda: signed post-read deadlines prevent body validation and room work', async (t) => {
  const control = { statusCode: 400, error: 'INVALID_BODY' };
  await verify(t, 'roomLambda', [
    // Both reads start together. Advance each completion independently to prove
    // the composed handler checks all deadlines after registry I/O, before it
    // parses the deliberately malformed room body or spends a room permit.
    ...['token', 'family', 'pilot'].flatMap((gate) => ['family', 'user'].flatMap((key) =>
      [999, 1000, 1001].map((elapsed) => ({
        name: gate + ' deadline after ' + key + ' read at ' + elapsed,
        [gate + 'Lifetime']: 1000, advanceRead: { key, elapsed },
        ...(elapsed === 999 ? control : {}),
      })))),
    ...['family', 'user'].map((key) => ({ name: 'returned hold with delayed ' + key + ' read',
      user: { lifecycleHold: 'synthetic-hold' }, advanceRead: { key, elapsed: 999 } })),
    ...['family', 'user'].map((key) => ({ name: key + ' read outage is sanitized as unauthorized', readFailure: key })),
    { name: 'warm room gate recovers after deadline and read failures', ...control },
    { name: 'warm recovered gate still checks newly returned hold', user: { lifecycleHold: 'synthetic-hold' } },
    { name: 'warm gate recovers again without cached denial', ...control },
  ]);
});


test('roomLambda: signed create budget and renewed session gates precede room storage', async (t) => {
  const control = { statusCode: 400, error: 'INVALID_ROOM' };
  const unavailable = { statusCode: 503, error: 'GROUP_SERVICE_UNAVAILABLE' };
  await verify(t, 'roomLambda', [
    { name: 'empty JSON spends create permit and rechecks session before room validation', roomCreate: {}, ...control },
    ...['global', 'account'].map((error) => ({ name: error + ' create quota stops renewed reads',
      roomCreate: { error, stop: true }, statusCode: 429, error: 'ROOM_RATE_LIMITED', retryAfter: true })),
    { name: 'create budget outage is sanitized before renewed reads', roomCreate: { error: 'outage', stop: true }, ...unavailable },
    { name: 'stale create permit stops renewed reads', roomCreate: { advance: 60000, stop: true }, ...unavailable },
    ...['token', 'family', 'pilot'].flatMap((gate) => [999, 1000, 1001].map((elapsed) => ({
      name: gate + ' deadline during create budget at ' + elapsed,
      [gate + 'Lifetime']: 1000,
      roomCreate: { advance: elapsed, ...(gate === 'token' && elapsed >= 1000 ? { stop: true } : {}) },
      ...(elapsed === 999 ? control : {}),
    }))),
    ...['token', 'family', 'pilot'].flatMap((gate) => ['family', 'user'].flatMap((key) =>
      [999, 1000, 1001].map((elapsed) => ({
        name: gate + ' deadline during renewed ' + key + ' read at ' + elapsed,
        [gate + 'Lifetime']: 1000, roomCreate: { advanceRead: { key, elapsed } },
        ...(elapsed === 999 ? control : {}),
      })))),
    { name: 'new family revocation after create budget denies room validation', roomCreate: { family: { state: 'revoked' } } },
    { name: 'new lifecycle hold after create budget denies room validation', roomCreate: { user: { lifecycleHold: 'synthetic-hold' } } },
    ...['family', 'user'].map((key) => ({ name: 'renewed ' + key + ' outage is sanitized',
      roomCreate: { readFailure: key }, ...unavailable })),
    { name: 'warm create recovers after budget and renewed-session denials', roomCreate: {}, ...control },
    { name: 'warm create still enforces next account quota', roomCreate: { error: 'account', stop: true },
      statusCode: 429, error: 'ROOM_RATE_LIMITED', retryAfter: true },
    { name: 'warm create still checks next lifecycle hold', roomCreate: { user: { lifecycleHold: 'synthetic-hold' } } },
    { name: 'warm create recovers again without cached denial', roomCreate: {}, ...control },
  ]);
});

test('sessionLambda: signed bootstrap composes registration, conflicts, revocation and post-I/O expiry', async (t) => {
  const bootstrap = (name, registration, extra = {}) => ({ name, bootstrap: true,
    provider: 'matching', registration, ...extra });
  const success = { statusCode: 200, success: true };
  const unavailable = { statusCode: 503, error: 'ACCOUNT_SERVICE_UNAVAILABLE' };
  const create = { write: true };
  const existing = { existing: true, capability: {}, write: true };
  await verify(t, 'sessionLambda', [
    bootstrap('new family and hashed logout binding', [create], success),
    bootstrap('existing binding retains family deadline', [existing], success),
    bootstrap('revoked capability cannot bootstrap', [{ capability: { state: 'revoked' } }]),
    bootstrap('capability belongs to another family', [{ capability: { familyKey: 'SESSION#another' } }]),
    bootstrap('revoked family cannot bootstrap', [{ existing: true, family: { state: 'revoked' } }]),
    bootstrap('another logout binding cannot be replaced', [{ existing: true, family: { logoutKey: 'LOGOUT#another' } }]),
    bootstrap('hold added after provider acceptance', [{ user: { lifecycleHold: 'synthetic-hold' } }]),
    bootstrap('conditional conflict then existing binding', [{ ...create, conflict: 'ConditionalCheckFailed' }, existing], success),
    bootstrap('transaction conflict then new binding', [{ ...create, conflict: 'TransactionConflict' }, create], success),
    bootstrap('logout wins conditional conflict', [{ ...create, conflict: 'ConditionalCheckFailed' }, { capability: { state: 'revoked' } }]),
    bootstrap('bounded conflict exhaustion', Array.from({ length: 6 }, () => ({ ...create, conflict: 'TransactionConflict' })), unavailable),
    bootstrap('registration read outage', [{ readError: true }], unavailable),
    bootstrap('registration write outage', [{ ...create, writeError: true }], unavailable),
    bootstrap('nonretryable transaction cancellation', [{ ...create, conflict: 'ProvisionedThroughputExceeded' }], unavailable),
    bootstrap('token expires during registration reads', [{ advanceRead: 300000 }]),
    bootstrap('admission expires during registration reads', [{ advanceRead: 60000 }]),
    bootstrap('token expires after registration write', [{ ...create, advanceWrite: 300000 }]),
    bootstrap('admission expires after registration write', [{ ...create, advanceWrite: 60000 }]),
    bootstrap('token expires on conflict before retry', [{ ...create, conflict: 'TransactionConflict', advanceWrite: 300000 }, {}]),
    bootstrap('live post-write response control', [{ ...create, advanceWrite: 59999 }], { ...success, responseAdvance: 59999 }),
    bootstrap('warm bootstrap recovers after failures', [create], success),
    bootstrap('warm recovery does not cache capability approval', [{ capability: { state: 'revoked' } }]),
  ]);
});


test('roomLambda: signed valid free-ride creation binds metadata writes to live account conditions', async (t) => {
  const created = { statusCode: 201, created: true };
  const unavailable = { statusCode: 503, error: 'GROUP_SERVICE_UNAVAILABLE' };
  await verify(t, 'roomLambda', [
    { name: 'default twelve-hour room requests exact metadata and security transaction', metadata: {}, ...created },
    { name: 'minimum duration retains explicit cleanup schedule', metadata: { durationMs: 60000 }, ...created },
    ...['AccessDeniedException', 'SyntheticWriteOutage', 'TransactionCanceledException'].map((error) => ({
      name: 'metadata write failure sanitized: ' + error, metadata: { error }, ...unavailable,
    })),
    { name: 'family condition cancellation rechecks and denies revoked family',
      metadata: { error: 'conditional', conflictIndex: 1, family: { state: 'revoked' } } },
    { name: 'admission condition cancellation rechecks and denies lifecycle hold',
      metadata: { error: 'conditional', conflictIndex: 2, user: { lifecycleHold: 'synthetic-hold' } } },
    { name: 'conditional collision acknowledges matching existing creation',
      metadata: { error: 'conditional', readBack: 'matching' }, ...created },
    { name: 'conditional collision with missing room does not acknowledge creation',
      metadata: { error: 'conditional', readBack: 'missing' }, statusCode: 404, error: 'ROOM_UNAVAILABLE' },
    { name: 'conditional collision with different creation rejects command reuse',
      metadata: { error: 'conditional', readBack: 'mismatch' }, statusCode: 409, error: 'COMMAND_CONFLICT' },
    { name: 'warm creation recovers after write failures and collisions', metadata: {}, ...created },
    { name: 'warm recovery still denies next metadata write outage', metadata: { error: 'SyntheticWriteOutage' }, ...unavailable },
    { name: 'warm creation recovers again', metadata: {}, ...created },
  ].map((scenario) => ({ ...scenario, roomCreate: {} })));
});


test('roomLambda: signed metadata-only snapshots compose budget, atomic viewer grants and membership', async (t) => {
  const ok = { statusCode: 200, snapshotOk: true };
  const unavailable = { statusCode: 503, error: 'GROUP_SERVICE_UNAVAILABLE' };
  const hidden = { statusCode: 404, error: 'ROOM_UNAVAILABLE' };
  await verify(t, 'roomLambda', [
    { name: 'authorized roster uses snapshot budget and exact atomic keys', snapshot: {}, ...ok },
    ...['global', 'account'].map((budgetError) => ({ name: budgetError + ' quota prevents room discovery',
      snapshot: { budgetError, stop: true }, statusCode: 429, error: 'ROOM_RATE_LIMITED', retryAfter: true })),
    { name: 'budget outage is sanitized before discovery', snapshot: { budgetError: 'outage', stop: true }, ...unavailable },
    { name: 'stale snapshot permit prevents discovery', snapshot: { budgetAdvance: 60000, stop: true }, ...unavailable },
    ...[
      { name: 'missing discovery', discoveryMissing: true },
      { name: 'ended discovery', discoveryRoom: { state: 'ended' } },
      { name: 'expired discovery', discoveryRoom: { expiresAt: 0 } },
      { name: 'viewer absent from discovery', discoveryRemoved: true },
    ].map(({ name, ...snapshot }) => ({ name, snapshot: { ...snapshot, discoveryStop: true }, ...hidden })),
    { name: 'discovery read outage is sanitized', snapshot: { discoveryError: true, discoveryStop: true }, ...unavailable },
    ...sessionDenials.filter((s) => !s.readFailure).map(({ name, ...snapshot }) => ({
      name: 'atomic viewer: ' + name, snapshot,
    })),
    ...['token', 'family', 'pilot'].flatMap((gate) => [999, 1000, 1001].map((advance) => ({
      name: gate + ' deadline during atomic snapshot at ' + advance,
      [gate + 'Lifetime']: 1000, snapshot: { advance }, ...(advance === 999 ? ok : {}),
    }))),
    ...[
      { name: 'room removed atomically', roomMissing: true },
      { name: 'room ended atomically', room: { state: 'ended' } },
      { name: 'room expired atomically', room: { expiresAt: 0 } },
      { name: 'viewer removed atomically', removed: true },
    ].map(({ name, ...snapshot }) => ({ name, snapshot, ...hidden })),
    ...['AccessDeniedException', 'SyntheticReadOutage', 'TransactionCanceledException'].map((readError) => ({
      name: 'atomic read sanitized: ' + readError, snapshot: { readError }, ...unavailable,
    })),
    { name: 'revision churn retries exact reads six times then returns busy', snapshot: { revisions: true }, statusCode: 409, error: 'ROOM_BUSY' },
    { name: 'warm snapshot recovers after denial and failures', snapshot: {}, ...ok },
    { name: 'warm recovery still checks next lifecycle hold', snapshot: { user: { lifecycleHold: 'synthetic-hold' } } },
    { name: 'warm snapshot recovers again', snapshot: {}, ...ok },
  ]);
});


test('roomLambda: signed sharing rosters deduplicate viewer grants and isolate source grants without points', async (t) => {
  const ok = { statusCode: 200, snapshotOk: true };
  await verify(t, 'roomLambda', [
    ...[['viewer'], ['peer'], ['viewer', 'peer']].map((sharing) => ({
      name: 'missing points with exact source keys for ' + sharing.join(' and '), snapshot: { sharing }, ...ok,
    })),
    { name: 'another viewer device adds family but reuses viewer admission',
      snapshot: { sharing: ['viewer', 'peer'], otherDevice: true }, ...ok },
    ...[
      { name: 'missing source family', missingPeerFamily: true },
      { name: 'revoked source family', peerFamily: { state: 'revoked' } },
      { name: 'expired source family', peerFamily: { expiresAt: 0 } },
      { name: 'wrong source family subject', peerFamily: { subject: 'another-synthetic-user' } },
      { name: 'missing source admission', missingPeerUser: true },
      { name: 'blocked source admission', peerUser: { state: 'blocked' } },
      { name: 'expired source admission', peerUser: { pilotExpiresAt: 0 } },
      { name: 'source lifecycle hold', peerUser: { lifecycleHold: 'synthetic-hold' } },
      { name: 'wrong source admission subject', peerUser: { subject: 'another-synthetic-user' } },
      { name: 'missing alternate viewer source family', otherDevice: true, missingOtherFamily: true },
      { name: 'revoked alternate viewer source family', otherDevice: true, otherFamily: { state: 'revoked' } },
    ].map(({ name, ...snapshot }) => ({ name, snapshot: { sharing: ['viewer', 'peer'], ...snapshot }, ...ok })),
    ...['family', 'pilot'].flatMap((gate) => [999, 1000, 1001].map((advance) => ({
      name: 'source ' + gate + ' deadline at ' + advance,
      snapshot: { sharing: ['viewer', 'peer'], advance,
        ...(gate === 'family' ? { peerFamily: { expiresAt: 'relative-deadline' } }
          : { peerUser: { pilotExpiresAt: 'relative-deadline' } }) }, ...ok,
    }))),
    { name: 'deduplicated viewer/source family revocation still denies viewer',
      snapshot: { sharing: ['viewer', 'peer'], family: { state: 'revoked' } } },
    { name: 'alternate source cannot override current viewer lifecycle hold',
      snapshot: { sharing: ['viewer', 'peer'], otherDevice: true, user: { lifecycleHold: 'synthetic-hold' } } },
    { name: 'sharing source read outage is sanitized', snapshot: { sharing: ['viewer', 'peer'], readError: 'SyntheticReadOutage' },
      statusCode: 503, error: 'GROUP_SERVICE_UNAVAILABLE' },
    { name: 'warm sharing roster recovers with fresh grants', snapshot: { sharing: ['viewer', 'peer'] }, ...ok },
  ]);
});


test('roomLambda: signed snapshot rediscovery rebuilds sharing grants and rechecks viewer gates', async (t) => {
  const ok = { statusCode: 200, snapshotOk: true };
  const first = { revision: 1, room: { revision: 2 } };
  const second = { revision: 2, room: {} };
  // The first atomic room already has the next roster, but its grant keys
  // were discovered from the old roster. That result must be discarded.
  const race = (before, after) => ({ reads: [
    { ...first, ...before, atomicRoster: after }, { ...second, ...after },
  ] });
  await verify(t, 'roomLambda', [
    { name: 'retry adds newly sharing peer family and admission keys',
      snapshot: race({ sharing: ['viewer'] }, { sharing: ['viewer', 'peer'] }), ...ok },
    { name: 'retry drops stopped peer source grants',
      snapshot: race({ sharing: ['viewer', 'peer'] }, { sharing: ['viewer'] }), ...ok },
    { name: 'retry adds alternate viewer family without duplicating admission',
      snapshot: race({ sharing: ['viewer', 'peer'] }, { sharing: ['viewer', 'peer'], otherDevice: true }), ...ok },
    { name: 'retry drops alternate viewer family when current device resumes',
      snapshot: race({ sharing: ['viewer', 'peer'], otherDevice: true }, { sharing: ['viewer', 'peer'] }), ...ok },
    { name: 'retry replaces peer family key after source device switch',
      snapshot: race({ sharing: ['peer'] }, { sharing: ['peer'], peerDeviceFamily: 'synthetic-rotated-family' }), ...ok },
    ...sessionDenials.filter((entry) => !entry.readFailure).map(({ name, ...denial }) => ({
      name: 'fresh retry viewer gate: ' + name,
      snapshot: race({ sharing: ['peer'] }, { sharing: ['viewer', 'peer'], otherDevice: true, ...denial }),
    })),
    { name: 'viewer removed at rediscovery prevents a second atomic read',
      snapshot: race({ sharing: ['peer'] }, { discoveryRemoved: true, discoveryStop: true }),
      statusCode: 404, error: 'ROOM_UNAVAILABLE' },
    { name: 'retry atomic outage is sanitized after changed keys',
      snapshot: race({ sharing: ['viewer'] }, { sharing: ['peer'], readError: 'SyntheticRetryOutage' }),
      statusCode: 503, error: 'GROUP_SERVICE_UNAVAILABLE' },
    ...['token', 'family', 'pilot'].map((gate) => ({
      name: gate + ' deadline expires on retry', [gate + 'Lifetime']: 1000,
      snapshot: race({ sharing: ['peer'], advance: 999 }, { sharing: ['viewer', 'peer'], advance: 1000 }),
    })),
    { name: 'warm handler recovers with a fresh single-discovery roster', snapshot: { sharing: ['peer'] }, ...ok },
  ]);
});
