import { createHash } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const WINDOW_MS = 60_000;
const OPERATIONS = new Set(['bootstrap', 'logout', 'status']);
export class AccountRateLimitedError extends Error {
  constructor(retryAfter) { super('ACCOUNT_RATE_LIMITED'); this.retryAfter = retryAfter; }
}
/** Call only with a server-verified subject, never request body/session/device IDs.
 * Atomic global + account permits bound both effects and new counter allocation.
 * Separate operation pools keep bootstrap traffic from consuming logout capacity.
 */
export function createAccountBudget({ client, tableName, now = Date.now, globalLimit = 60, accountLimit = 6, statusGlobalLimit = 600, statusAccountLimit = 60 }) {
  if (!client?.send || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName ?? '')
    || !Number.isSafeInteger(globalLimit) || globalLimit < 1 || globalLimit > 1000
    || !Number.isSafeInteger(accountLimit) || accountLimit < 1 || accountLimit > globalLimit
    || !Number.isSafeInteger(statusGlobalLimit) || statusGlobalLimit < 1 || statusGlobalLimit > 1000
    || !Number.isSafeInteger(statusAccountLimit) || statusAccountLimit < 1 || statusAccountLimit > statusGlobalLimit)
    throw new Error('Account budget must be configured.');
  return async function consume(operation, subject) {
    if (!OPERATIONS.has(operation) || typeof subject !== 'string' || !subject || subject.length > 256)
      throw new Error('Verified account budget context unavailable.');
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 2 * WINDOW_MS)
      throw new Error('Account budget clock unavailable.');
    const window = Math.floor(at / WINDOW_MS), end = (window + 1) * WINDOW_MS;
    const account = createHash('sha256').update(JSON.stringify([window, operation, subject])).digest('hex');
    const update = (suffix, limit) => ({ Update: {
      TableName: tableName, Key: { pk: `ACCOUNT_RATE#${operation}#${window}#${suffix}` },
      UpdateExpression: 'SET #ttl = :ttl ADD #count :one',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':ttl': Math.ceil((end + WINDOW_MS) / 1000), ':one': 1, ':limit': limit },
    } });
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [update('GLOBAL', operation === 'status' ? statusGlobalLimit : globalLimit), update(account, operation === 'status' ? statusAccountLimit : accountLimit)] }));
    } catch (error) {
      if (error?.name === 'TransactionCanceledException'
        && error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) {
        const rejectedAt = now();
        if (!Number.isSafeInteger(rejectedAt) || rejectedAt < at) throw new Error('Account budget clock unavailable.');
        throw new AccountRateLimitedError(Math.max(1, Math.min(60, Math.ceil((end - rejectedAt) / 1000))));
      }
      throw error;
    }
    const completedAt = now();
    if (!Number.isSafeInteger(completedAt) || completedAt >= end || completedAt < at)
      throw new Error('Account budget expired.');
  };
}
