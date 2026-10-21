import { createHash, randomBytes } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { userKey } from './sessionRegistry.mjs';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const envelopeHash = (e) => hash(JSON.stringify([e?.version, e?.context?.purpose, e?.context?.subject, e?.wrappedKey, e?.iv, e?.ciphertext, e?.tag]));
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256;
const states = ['exchanging', 'uncertain', 'captured', 'validated', 'closed'];
export const appleGrantPartition = (subject) => `APPLE#${hash(subject)}`;
export function createAppleGrantJournal({ client, tableName, sessionTableName, now = Date.now }) {
  if (!client?.send || !tableName || !sessionTableName || tableName === sessionTableName) throw new Error('Provider journal must be configured.');
  function clock() { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw new Error('Provider clock unavailable.'); return at; }
  function key(attempt) {
    if (!id(attempt?.subject) || !/^[a-f0-9]{64}$/.test(attempt?.attemptId ?? '')) throw new Error('Invalid provider attempt.');
    return { pk: appleGrantPartition(attempt.subject), sk: attempt.attemptId };
  }
  function valid(row, subject) {
    if (!row || row.pk !== appleGrantPartition(subject) || row.subject !== subject || !/^[a-f0-9]{64}$/.test(row.sk ?? '')
      || row.version !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1 || !states.includes(row.state)
      || !/^NATIVEAPPLE#[a-f0-9]{64}$/.test(row.providerKey ?? '')
      || (['captured', 'validated'].includes(row.state) && (!row.envelope || row.envelopeDigest !== envelopeHash(row.envelope)))) throw new Error('Invalid provider journal record.');
    return row;
  }
  async function load(attempt) {
    const row = (await client.send(new GetCommand({ TableName: tableName, Key: key(attempt), ConsistentRead: true }))).Item;
    return valid(row, attempt.subject);
  }
  async function transition(attempt, transform) {
    for (let i = 0; i < 6; i++) {
      const previous = await load(attempt), next = transform(previous);
      if (!next) return previous;
      next.revision = previous.revision + 1;
      const fields = Object.keys(next).filter((k) => !['pk', 'sk'].includes(k));
      const names = {}, values = { ':previous': previous.revision };
      fields.forEach((field, i) => { names[`#n${i}`] = field; values[`:v${i}`] = next[field]; });
      names['#revision'] = 'revision';
      const removed = Object.keys(previous).filter((field) => !(field in next));
      removed.forEach((field, i) => { names[`#r${i}`] = field; });
      try {
        await client.send(new UpdateCommand({ TableName: tableName, Key: key(attempt),
          UpdateExpression: 'SET ' + fields.map((_, i) => `#n${i} = :v${i}`).join(', ') + (removed.length ? ' REMOVE ' + removed.map((_, i) => `#r${i}`).join(', ') : ''),
          ConditionExpression: '#revision = :previous', ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
        return next;
      } catch (error) { if (error?.name !== 'ConditionalCheckFailedException') throw error; }
    }
    throw new Error('Provider journal conflict.');
  }
  return {
    async begin(mapping) {
      if (!id(mapping?.subject) || !/^NATIVEAPPLE#[a-f0-9]{64}$/.test(mapping?.providerKey ?? '')) throw new Error('Invalid provider mapping.');
      const at = clock(), attemptId = randomBytes(32).toString('hex');
      const row = { pk: appleGrantPartition(mapping.subject), sk: attemptId, subject: mapping.subject, providerKey: mapping.providerKey,
        version: 1, revision: 1, state: 'exchanging', createdAt: at };
      await client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: sessionTableName, Key: userKey(mapping.subject),
          ConditionExpression: '#state = :active AND subject = :subject AND pilotExpiresAt > :now AND attribute_not_exists(lifecycleHold)',
          ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':active': 'active', ':subject': mapping.subject, ':now': at } } },
        { Put: { TableName: tableName, Item: row, ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }));
      return { subject: mapping.subject, attemptId };
    },
    capture: (attempt, envelope) => transition(attempt, (row) => {
      if (envelope?.version !== 1) throw new Error('Provider envelope unavailable.');
      const digest = envelopeHash(envelope);
      if (['captured', 'validated'].includes(row.state) && row.envelopeDigest === digest) return null;
      if (!['exchanging', 'uncertain'].includes(row.state)) throw new Error('Provider attempt fenced.');
      return { ...row, state: 'captured', envelope, envelopeDigest: digest };
    }),
    validate: (attempt) => transition(attempt, (row) => {
      if (row.state === 'validated') return null;
      if (row.state !== 'captured') throw new Error('Provider token was not captured.');
      return { ...row, state: 'validated' };
    }),
    uncertain: (attempt) => transition(attempt, (row) => row.state === 'exchanging' ? { ...row, state: 'uncertain' } : null),
    closed: (attempt) => transition(attempt, (row) => {
      if (row.state === 'closed') return null;
      const { envelope, envelopeDigest, ...metadata } = row;
      return { ...metadata, state: 'closed', closedAt: clock(), ttl: Math.ceil((clock() + 7 * 86400_000) / 1000) };
    }),
    async page(subject, cursor = undefined) {
      if (!id(subject) || cursor && (cursor.pk !== appleGrantPartition(subject) || !/^[a-f0-9]{64}$/.test(cursor.sk ?? ''))) throw new Error('Invalid provider cleanup cursor.');
      const result = await client.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': appleGrantPartition(subject) }, ConsistentRead: true, Limit: 3,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      return { records: (result.Items ?? []).map((row) => valid(row, subject)), cursor: result.LastEvaluatedKey ?? null };
    },
    async removeUnderHold(row, hold) {
      valid(row, row.subject);
      if (!['captured', 'validated', 'closed'].includes(row.state)) throw new Error('Unresolved provider attempt cannot be removed.');
      await client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: sessionTableName, Key: userKey(row.subject),
          ConditionExpression: '#state = :blocked AND subject = :subject AND lifecycleHold = :hold AND attribute_not_exists(#ttl) AND attribute_not_exists(expiresAt) AND attribute_not_exists(pilotExpiresAt)',
          ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':blocked': 'blocked', ':subject': row.subject, ':hold': hold } } },
        { Delete: { TableName: tableName, Key: { pk: row.pk, sk: row.sk }, ConditionExpression: '#revision = :revision',
          ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': row.revision } } },
      ] }));
    },
    async empty(subject) {
      const result = await client.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': appleGrantPartition(subject) }, ConsistentRead: true, Limit: 1, Select: 'COUNT' }));
      return result.Count === 0;
    },
  };
}
