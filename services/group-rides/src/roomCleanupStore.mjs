import { QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { conditionalConflict } from './locationKeys.mjs';
/** Metadata-only expiry index. No account, room payload or point reads. */
export function createDynamoRoomCleanupStore({ client, tableName }) {
  if (!client?.send || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName ?? '')) throw new Error('Room cleanup storage must be configured.');
  return {
    async cleanup(at, { maxPages = 10, shouldContinue = () => true } = {}) {
      if (typeof shouldContinue !== 'function' || !Number.isFinite(at) || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid cleanup parameters.');
      let cursor, deleted = 0, examined = 0, oldestOverdueMs = 0;
      for (let page = 0; page < maxPages; page++) {
        if (!shouldContinue()) return { deleted, examined, more: true, oldestOverdueMs };
        // The index projects only keys/version, never membership/profile/invite data. Its eventual
        // consistency cannot delete an updated room: the delete is conditional.
        const response = await client.send(new QueryCommand({ TableName: tableName, IndexName: 'ExpiryIndex',
          KeyConditionExpression: 'cleanupBucket = :bucket AND purgeAt <= :now',
          ExpressionAttributeValues: { ':bucket': 'ROOMS', ':now': at }, Limit: 100,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
        const items = response.Items ?? [];
        // Bounded parallel erasure keeps a large pilot backlog within the worker
        // budget. Always inspect/await every outcome before returning or failing.
        for (let offset = 0; offset < items.length;) {
          const batch = [];
          while (offset < items.length && batch.length < 8 && shouldContinue()) batch.push(items[offset++]);
          if (!batch.length) return { deleted, examined, more: true, oldestOverdueMs };
          const outcomes = await Promise.allSettled(batch.map(async (item) => {
            examined++;
            if (Number.isFinite(item.purgeAt)) oldestOverdueMs = Math.max(oldestOverdueMs, at - item.purgeAt);
            await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk },
              ConditionExpression: '#version = :version AND purgeAt = :purgeAt AND purgeAt <= :now',
              ExpressionAttributeNames: { '#version': 'revision' }, ExpressionAttributeValues: { ':version': item.revision, ':purgeAt': item.purgeAt, ':now': at } }));
          }));
          let failure;
          for (const outcome of outcomes) {
            if (outcome.status === 'fulfilled') deleted++;
            else if (!conditionalConflict(outcome.reason)) failure ??= outcome.reason;
          }
          if (failure) throw failure;
        }
        cursor = response.LastEvaluatedKey;
        if (!cursor) break;
      }
      return { deleted, examined, more: !!cursor, oldestOverdueMs };
    }
  };
}
