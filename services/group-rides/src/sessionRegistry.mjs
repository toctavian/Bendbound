import { createHash } from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { UnauthorizedError } from './authorizer.mjs';
export const DEFAULT_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const digest = (text) => createHash('sha256').update(text).digest('hex');
export const familyKey = (familyId) => ({ pk: `SESSION#${digest(familyId)}` });
export const userKey = (subject) => ({ pk: `USER#${digest(subject)}` });
export const validLogoutSecret = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const logoutKey = (secret) => ({ pk: `LOGOUT#${digest(secret)}` });
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
/** Durable adapter: expiry is checked logically; DynamoDB TTL is only cleanup. */
export function createDynamoSessionRegistry({ client, tableName, now = Date.now, maxSessionMs = DEFAULT_SESSION_LIFETIME_MS }) {
  if (!client?.send || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName ?? '')
    || !Number.isFinite(maxSessionMs) || maxSessionMs <= 0 || maxSessionMs > DEFAULT_SESSION_LIFETIME_MS) throw new Error('Session storage must be configured.');
  function validate(subject, familyId) { if (!validId(subject) || !validId(familyId)) throw new UnauthorizedError(); }
  async function get(Key) {
    return (await client.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))).Item;
  }
  // Admission is server-owned. Missing/legacy rows never imply approval.
  function allowsUser(user, subject, at) {
    return Number.isFinite(at) && user?.subject === subject && user.state === 'active' && !Object.hasOwn(user, 'lifecycleHold')
      && Number.isFinite(user.pilotExpiresAt) && user.pilotExpiresAt > at;
  }
  async function admitted(subject) {
    if (!validId(subject)) throw new UnauthorizedError();
    return allowsUser(await get(userKey(subject)), subject, now());
  }
  function userCheck(subject, at) {
    return { ConditionCheck: { TableName: tableName, Key: userKey(subject),
      ConditionExpression: '#state = :active AND subject = :subject AND pilotExpiresAt > :now AND attribute_not_exists(lifecycleHold)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':active': 'active', ':subject': subject, ':now': at } } };
  }
  async function active({ subject, familyId, expiresAt }) {
    validate(subject, familyId);
    const startedAt = now();
    if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt) || expiresAt <= startedAt) return false;
    const [family, user] = await Promise.all([get(familyKey(familyId)), get(userKey(subject))]);
    // Storage I/O can outlast a short-lived token. Use one final clock sample
    // for all three deadlines rather than admitting an expired credential.
    const at = now();
    return Number.isFinite(at) && expiresAt > at
      && family?.subject === subject && family?.state === 'active'
      && Number.isFinite(family.expiresAt) && family.expiresAt > at
      && allowsUser(user, subject, at);
  }
  async function register({ subject, familyId, expiresAt, authenticatedAt }) {
    validate(subject, familyId);
    // No awaited work precedes this send. Use one finite sample for validation
    // and transaction fields; retain active()'s post-I/O deadline checks below.
    const at = now();
    if (!Number.isFinite(at) || !Number.isFinite(expiresAt) || expiresAt <= at) throw new UnauthorizedError();
    // Bind lifetime to provider authentication time, not repeated registration.
    // Even after TTL deletes an expired family, its old token cannot create a new
    // 30-day lease. Configure Cognito refresh lifetime <= maxSessionMs.
    if (!Number.isFinite(authenticatedAt) || authenticatedAt < 0 || authenticatedAt > at + 1000) throw new UnauthorizedError();
    const deadline = authenticatedAt + maxSessionMs;
    if (!Number.isFinite(deadline) || deadline <= at) throw new UnauthorizedError();
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [
        userCheck(subject, at),
        { Put: { TableName: tableName, Item: { ...familyKey(familyId), subject, state: 'active',
          createdAt: at, expiresAt: deadline, ttl: Math.ceil(deadline / 1000) },
          ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }));
    } catch (error) {
      // An existing family is never overwritten, extended or resurrected.
      // Only a confirmed conditional conflict can become an idempotent read.
      const conditional = error?.name === 'TransactionCanceledException'
        && error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed');
      if (!conditional) throw error;
    }
    if (!await active({ subject, familyId, expiresAt })) throw new UnauthorizedError();
  }
  async function registerWithLogout(session, secret) {
    if (!validLogoutSecret(secret)) throw new UnauthorizedError();
    const { subject, familyId, expiresAt, authenticatedAt } = session;
    validate(subject, familyId);
    const authenticationDeadline = authenticatedAt + maxSessionMs;
    function checkTime(at, deadline = authenticationDeadline) {
      if (!Number.isFinite(at) || !Number.isFinite(expiresAt) || expiresAt <= at
        || !Number.isFinite(authenticatedAt) || authenticatedAt < 0 || authenticatedAt > at + 1000
        || !Number.isFinite(authenticationDeadline) || authenticationDeadline <= at
        || !Number.isFinite(deadline) || deadline <= at) throw new UnauthorizedError();
    }
    checkTime(now());
    const capKey = logoutKey(secret), family = familyKey(familyId);
    for (let attempt = 0; attempt < 6; attempt++) {
      const [previous, capability, user] = await Promise.all([get(family), get(capKey), get(userKey(subject))]);
      // Reads and transaction retries may outlast the token or original family.
      // Sample once after I/O and use it for every deadline and write condition.
      const at = now();
      const deadline = previous?.expiresAt ?? authenticationDeadline;
      checkTime(at, deadline);
      if (!allowsUser(user, subject, at)) throw new UnauthorizedError();
      if (previous && (previous.subject !== subject || previous.state !== 'active'
        || !Number.isFinite(previous.expiresAt) || previous.expiresAt <= at
        || (previous.logoutKey && previous.logoutKey !== capKey.pk))) throw new UnauthorizedError();
      if (capability && (capability.state !== 'active' || capability.subject !== subject || capability.familyKey !== family.pk
        || !Number.isFinite(capability.expiresAt) || capability.expiresAt <= at)) throw new UnauthorizedError();
      const familyWrite = previous ? { Update: { TableName: tableName, Key: family,
        UpdateExpression: 'SET logoutKey = :key',
        ConditionExpression: '#state = :active AND subject = :subject AND expiresAt = :deadline AND (attribute_not_exists(logoutKey) OR logoutKey = :key)',
        ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':key': capKey.pk, ':active': 'active', ':subject': subject, ':deadline': deadline },
      } } : { Put: { TableName: tableName, Item: { ...family, subject, state: 'active', logoutKey: capKey.pk,
        createdAt: at, expiresAt: deadline, ttl: Math.ceil(deadline / 1000) }, ConditionExpression: 'attribute_not_exists(pk)' } };
      try {
        await client.send(new TransactWriteCommand({ TransactItems: [
          userCheck(subject, at),
          familyWrite,
          { Put: { TableName: tableName, Item: { ...capKey, subject, familyKey: family.pk, state: 'active', expiresAt: deadline, ttl: Math.ceil(deadline / 1000) },
            ConditionExpression: 'attribute_not_exists(pk) OR (#state = :active AND subject = :subject AND familyKey = :family AND expiresAt = :deadline)',
            ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':active': 'active', ':subject': subject, ':family': family.pk, ':deadline': deadline } } },
        ] }));
        // A write may have committed even if its response arrives too late.
        // Deny stale success without undoing the durable logout capability.
        const completedAt = now();
        checkTime(completedAt, deadline);
        if (!allowsUser(user, subject, completedAt)) throw new UnauthorizedError();
        return;
      } catch (error) {
        if (error?.name !== 'TransactionCanceledException' || !error.CancellationReasons?.some((r) => ['ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code))) throw error;
      }
    }
    throw new Error('Session registration busy.');
  }
  async function revokeWithLogout(secret) {
    if (!validLogoutSecret(secret)) throw new UnauthorizedError();
    const key = logoutKey(secret);
    for (let attempt = 0; attempt < 6; attempt++) {
      const capability = await get(key);
      if (capability?.state === 'revoked') return;
      // Each retry can outlast its read. Use one finite post-read sample for
      // the live-family decision and every timestamp in this transaction.
      const at = now();
      const deadline = at + maxSessionMs + 1000; // Includes accepted auth_time clock tolerance.
      if (!Number.isFinite(at) || !Number.isFinite(deadline) || deadline <= at
        || (capability && !Number.isFinite(capability.expiresAt))) throw new UnauthorizedError();
      // Unknown secrets get a tombstone too: logout before/during registration
      // cannot be followed by a delayed activation of that same capability.
      const tombstone = { Put: { TableName: tableName, Item: { ...key, state: 'revoked', expiresAt: capability?.expiresAt ?? deadline,
        ttl: Math.ceil((capability?.expiresAt ?? deadline) / 1000) },
        ConditionExpression: capability ? '#state = :active AND familyKey = :family AND subject = :subject' : 'attribute_not_exists(pk)',
        ...(capability ? { ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':active': 'active', ':family': capability.familyKey, ':subject': capability.subject } } : {}) } };
      const writes = [tombstone];
      if (capability && capability.expiresAt > at) writes.push({ Update: { TableName: tableName, Key: { pk: capability.familyKey },
        ConditionExpression: 'subject = :subject AND logoutKey = :key',
        UpdateExpression: 'SET #state = :revoked, revokedAt = :now, expiresAt = :deadline, #ttl = :ttl',
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':subject': capability.subject, ':key': key.pk, ':revoked': 'revoked', ':now': at, ':deadline': deadline, ':ttl': Math.ceil(deadline / 1000) } } });
      try { await client.send(new TransactWriteCommand({ TransactItems: writes })); return; }
      catch (error) {
        if (error?.name !== 'TransactionCanceledException' || !error.CancellationReasons?.some((r) => ['ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code))) throw error;
      }
    }
    throw new Error('Session revocation busy.');
  }
  async function revoke({ subject, familyId }) {
    validate(subject, familyId);
    const at = now(), deadline = at + maxSessionMs;
    if (!Number.isFinite(at) || !Number.isFinite(deadline) || deadline <= at) throw new UnauthorizedError();
    // Unknown families also get a tombstone, preventing later registration.
    await client.send(new UpdateCommand({ TableName: tableName, Key: familyKey(familyId),
      ConditionExpression: 'attribute_not_exists(pk) OR subject = :subject',
      UpdateExpression: 'SET subject = :subject, #state = :revoked, revokedAt = :now, expiresAt = :deadline, #ttl = :ttl',
      ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':subject': subject, ':revoked': 'revoked', ':now': at, ':deadline': deadline, ':ttl': Math.ceil(deadline / 1000) } }));
  }
  async function blockUser(subject) {
    if (!validId(subject)) throw new UnauthorizedError();
    const at = now(), deadline = at + maxSessionMs;
    if (!Number.isFinite(at) || !Number.isFinite(deadline) || deadline <= at) throw new UnauthorizedError();
    // Temporary operator/provider block only; durable deletion uses lifecycleHoldStore.
    // Never shorten a durable hold or replace a mismatched subject.
    await client.send(new PutCommand({ TableName: tableName, Item: { ...userKey(subject), subject,
      state: 'blocked', expiresAt: deadline, ttl: Math.ceil(deadline / 1000) },
      ConditionExpression: 'attribute_not_exists(lifecycleHold) AND (attribute_not_exists(pk) OR subject = :subject)',
      ExpressionAttributeValues: { ':subject': subject } }));
  }
  function transactionChecks({ subject, familyId, expiresAt }, at) {
    validate(subject, familyId);
    if (!Number.isFinite(at) || !Number.isFinite(expiresAt) || expiresAt <= at) throw new UnauthorizedError();
    return [
      { ConditionCheck: { TableName: tableName, Key: familyKey(familyId),
        ConditionExpression: '#state = :active AND subject = :subject AND expiresAt > :now',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: { ':active': 'active', ':subject': subject, ':now': at } } },
      userCheck(subject, at),
    ];
  }
  return { register, registerWithLogout, admitted, allowsUser, active, revoke, revokeWithLogout, blockUser, transactionChecks };
}
