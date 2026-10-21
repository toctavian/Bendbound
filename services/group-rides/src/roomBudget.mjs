import { createHash } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const WINDOW_MS = 60_000;
const LIMITS = Object.freeze({ create: { global: 60, account: 6 }, redeem: { global: 120, account: 12 }, fix: { global: 600, account: 60 }, snapshot: { global: 600, account: 60 }, invite: { global: 60, account: 6 }, control: { global: 120, account: 12 } });
export class RoomRateLimitedError extends Error {
  constructor(retryAfter) { super('ROOM_RATE_LIMITED'); this.retryAfter = retryAfter; }
}
/** Call only with a server-verified subject, never request body/session/device IDs.
 * Atomic global + account permits bound both effects and new counter allocation.
 * Separate pools isolate reads, invite issuance, controls, guesses and uploads.
 */
export function createRoomBudget({ client, tableName, now = Date.now, limits = LIMITS }) {
  if (!client?.send || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName ?? '')
    || !limits || Object.keys(limits).length !== Object.keys(LIMITS).length
    || Object.keys(LIMITS).some((operation) => !Number.isSafeInteger(limits[operation]?.global)
      || limits[operation].global < 1 || limits[operation].global > 1000
      || !Number.isSafeInteger(limits[operation].account) || limits[operation].account < 1
      || limits[operation].account > limits[operation].global))
    throw new Error('Room budget must be configured.');
  const configured = Object.fromEntries(Object.keys(LIMITS).map((key) => [key, { ...limits[key] }]));
  return async function consume(operation, subject) {
    if (typeof operation !== 'string' || !Object.hasOwn(configured, operation) || typeof subject !== 'string' || !subject || subject.length > 256)
      throw new Error('Verified room budget context unavailable.');
    const { global: globalLimit, account: accountLimit } = configured[operation];
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 2 * WINDOW_MS)
      throw new Error('Room budget clock unavailable.');
    const window = Math.floor(at / WINDOW_MS), end = (window + 1) * WINDOW_MS;
    const account = createHash('sha256').update(JSON.stringify([window, operation, subject])).digest('hex');
    const update = (suffix, limit) => ({ Update: {
      TableName: tableName, Key: { pk: `ROOM_RATE#${operation}#${window}#${suffix}` },
      UpdateExpression: 'SET #ttl = :ttl ADD #count :one',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':ttl': Math.ceil((end + WINDOW_MS) / 1000), ':one': 1, ':limit': limit },
    } });
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [update('GLOBAL', globalLimit), update(account, accountLimit)] }));
    } catch (error) {
      if (error?.name === 'TransactionCanceledException'
        && error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) {
        const rejectedAt = now();
        if (!Number.isSafeInteger(rejectedAt) || rejectedAt < at) throw new Error('Room budget clock unavailable.');
        throw new RoomRateLimitedError(Math.max(1, Math.min(60, Math.ceil((end - rejectedAt) / 1000))));
      }
      throw error;
    }
    const completedAt = now();
    if (!Number.isSafeInteger(completedAt) || completedAt >= end || completedAt < at)
      throw new Error('Room budget expired.');
  };
}
