import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const WINDOW_MS = 60_000;
export class LogoutRateLimitedError extends Error {
  constructor(retryAfter) { super('LOGOUT_RATE_LIMITED'); this.retryAfter = retryAfter; }
}
/** Shared across Lambda instances and both API gateways. No credential-based keys.
 * Atomic admission bounds source-row cardinality as well as tombstone allocation.
 * SDK ambiguity/outages deny access; no local fallback or compensating decrement.
 */
export function createLogoutBudget({ client, tableName, now = Date.now, globalLimit = 60, sourceLimit = 6 }) {
  if (!client?.send || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName ?? '')
    || !Number.isSafeInteger(globalLimit) || globalLimit < 1 || globalLimit > 1000
    || !Number.isSafeInteger(sourceLimit) || sourceLimit < 1 || sourceLimit > globalLimit)
    throw new Error('Logout budget must be configured.');
  return async function consume(sourceIp) {
    // API Gateway v2 context is authoritative; callers must not pass X-Forwarded-For.
    if (typeof sourceIp !== 'string' || !isIP(sourceIp)) throw new Error('Logout source unavailable.');
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 2 * WINDOW_MS)
      throw new Error('Logout clock unavailable.');
    const window = Math.floor(at / WINDOW_MS), end = (window + 1) * WINDOW_MS;
    const source = createHash('sha256').update(`${window}\0${sourceIp}`).digest('hex');
    const update = (suffix, limit) => ({ Update: {
      TableName: tableName, Key: { pk: `LOGOUT_RATE#${window}#${suffix}` },
      UpdateExpression: 'SET #ttl = :ttl ADD #count :one',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':ttl': Math.ceil((end + WINDOW_MS) / 1000), ':one': 1, ':limit': limit },
    } });
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [update('GLOBAL', globalLimit), update(source, sourceLimit)] }));
    } catch (error) {
      if (error?.name === 'TransactionCanceledException'
        && error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) {
        const rejectedAt = now();
        if (!Number.isSafeInteger(rejectedAt) || rejectedAt < at) throw new Error('Logout clock unavailable.');
        throw new LogoutRateLimitedError(Math.max(1, Math.min(60, Math.ceil((end - rejectedAt) / 1000))));
      }
      throw error;
    }
    // Do not spend an old window's permit after a slow request crosses its boundary.
    const completedAt = now();
    if (!Number.isSafeInteger(completedAt) || completedAt >= end || completedAt < at)
      throw new Error('Logout budget expired.');
  };
}
