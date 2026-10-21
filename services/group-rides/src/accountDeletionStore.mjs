import { randomBytes } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hash } from './locationKeys.mjs';
import { userKey } from './sessionRegistry.mjs';
import { createLifecycleHoldStore } from './lifecycleHoldStore.mjs';
const secret = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256;
export const deletionKey = (receiptSecret) => ({ pk: `DELETE#${hash(receiptSecret)}` });
export class DeletionConflictError extends Error {}
/** Durable outbox + permanent hold commit atomically. Secrets are never persisted.
 * Receipt grants status only; it cannot start, cancel, approve or release anything. */
export function createAccountDeletionStore({ client, tableName, sessionTableName, now = Date.now }) {
  if (!client?.send || !tableName || !sessionTableName || tableName === sessionTableName) throw new Error('Deletion storage required.');
  const clock = () => { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw new Error('Deletion clock unavailable.'); return at; };
  const get = async (Key) => (await client.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))).Item;
  async function pinned(row) {
    if (!row || row.version !== 1 || !id(row.subject) || !id(row.eventId) || !id(row.username)
      || !Number.isSafeInteger(row.holdStartedAt) || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid deletion job.');
    const held = await createLifecycleHoldStore({ client, tableName: sessionTableName, expectedStartedAt: row.holdStartedAt }).read(row.subject, row.eventId);
    if (!held) throw new Error('Deletion hold missing.');
    return held.lifecycleHold;
  }
  async function write(previous, next, token) {
    const hold = await pinned(previous), at = clock();
    if (token && (previous.lease?.token !== token || previous.lease.until <= at)) throw new Error('Deletion lease expired.');
    next.revision = previous.revision + 1;
    await client.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: sessionTableName, Key: userKey(previous.subject), ConditionExpression: '#state = :blocked AND lifecycleHold = :hold AND subject = :subject AND attribute_not_exists(#ttl)', ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' }, ExpressionAttributeValues: { ':blocked': 'blocked', ':hold': hold, ':subject': previous.subject } } },
      { Put: { TableName: tableName, Item: next, ConditionExpression: '#revision = :revision', ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': previous.revision } } },
    ] }));
    return next;
  }
  return {
    async start({ subject, username }, receiptSecret) {
      if (!id(subject) || !id(username) || !secret(receiptSecret)) throw new Error('Invalid deletion request.');
      const key = deletionKey(receiptSecret), previous = await get(key);
      if (previous) {
        if (previous.subject !== subject || previous.username !== username) throw new DeletionConflictError();
        await pinned(previous); return previous;
      }
      const at = clock(), eventId = randomBytes(32).toString('hex');
      const hold = { version: 1, binding: hash(JSON.stringify([subject, eventId, sessionTableName])), startedAt: at };
      const row = { ...key, version: 1, subject, username, eventId, holdStartedAt: at, revision: 1,
        phase: 'rooms', cursor: null, provider: 'pending', failures: 0, lease: null, queue: 'PENDING', dueAt: at, createdAt: at };
      try {
        await client.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: sessionTableName, Item: { ...userKey(subject), subject, state: 'blocked', lifecycleHold: hold }, ConditionExpression: 'attribute_not_exists(lifecycleHold) AND subject = :subject', ExpressionAttributeValues: { ':subject': subject } } },
          { Put: { TableName: tableName, Item: row, ConditionExpression: 'attribute_not_exists(pk)' } },
        ] }));
      } catch (error) {
        const saved = await get(key);
        if (saved?.subject === subject && saved.username === username) { await pinned(saved); return saved; }
        if (error?.name === 'TransactionCanceledException' && error.CancellationReasons?.some((v) => v.Code === 'ConditionalCheckFailed')) throw new DeletionConflictError();
        throw error;
      }
      return row;
    },
    async status(receiptSecret) {
      if (!secret(receiptSecret)) throw new Error('Invalid deletion receipt.');
      const row = await get(deletionKey(receiptSecret));
      if (!row) return undefined;
      await pinned(row);
      return { appDataDeleted: row.phase === 'app_deleted', provider: row.provider,
        delayed: row.queue === undefined && row.phase !== 'app_deleted',
        complete: row.phase === 'app_deleted' && row.provider === 'drained' };
    },
    async next() {
      const r = await client.send(new QueryCommand({ TableName: tableName, IndexName: 'DueIndex', KeyConditionExpression: '#queue = :pending AND dueAt <= :now', ExpressionAttributeNames: { '#queue': 'queue' }, ExpressionAttributeValues: { ':pending': 'PENDING', ':now': clock() }, Limit: 1 }));
      if (!r.Items?.length) return undefined;
      const row = await get({ pk: r.Items[0].pk });
      if (row?.queue !== 'PENDING' || row.dueAt > clock()) return undefined;
      await pinned(row); return row;
    },
    async claim(row) {
      const at = clock();
      if (row.lease && row.lease.until > at) return undefined;
      const token = randomBytes(32).toString('hex');
      return write(row, { ...row, lease: { token, until: at + 55_000 }, dueAt: at + 60_000 }, undefined);
    },
    async save(row, changes) {
      const next = { ...row, ...changes, lease: null };
      if (next.phase === 'app_deleted' && ['drained', 'manual'].includes(next.provider)) {
        delete next.queue; delete next.dueAt;
        if (next.provider === 'drained') next.ttl = Math.ceil((clock() + 7 * 86400_000) / 1000);
      }
      if (next.failures >= 8) { delete next.queue; delete next.dueAt; }
      return write(row, next, row.lease?.token);
    },
    async failed(row) {
      const failures = row.failures + 1, next = { ...row, failures, lease: null, dueAt: clock() + Math.min(3600_000, 60_000 * 2 ** Math.min(failures, 6)) };
      if (failures >= 8) { delete next.queue; delete next.dueAt; }
      return write(row, next, row.lease?.token);
    },
  };
}
