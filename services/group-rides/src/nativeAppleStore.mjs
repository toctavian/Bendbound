import { createHash, randomBytes } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AppleAuthenticationError } from './nativeApple.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
export class NativeEnrollmentRequired extends AppleAuthenticationError {}
export const enrollmentKey = (requestId) => `ENROLL#${hash(requestId)}`;
export const enrollmentIdentityKey = (providerKey) => `ENROLLIDENTITY#${providerKey.slice('NATIVEAPPLE#'.length)}`;
export const nativeProviderKey = (bundleId, subject) => `NATIVEAPPLE#${hash(JSON.stringify([bundleId, subject]))}`;
export const nativeUserKey = (username) => `NATIVEUSER#${hash(username)}`;
/** Separate auth table. Runtime cannot write operator-owned mapping rows. */
export function createNativeAppleStore({ client, tableName, bundleId, now = Date.now }) {
  if (!client?.send || !tableName || !bundleId) throw new Error('Native account storage is not configured.');
  function clock() { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw new Error('Account clock unavailable.'); return at; }
  async function put(Item) {
    await client.send(new PutCommand({ TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(pk)' }));
  }
  async function get(pk) { return (await client.send(new GetCommand({ TableName: tableName, Key: { pk }, ConsistentRead: true }))).Item; }
  async function consume(pk, extra = {}, deadline = undefined) {
    const at = clock();
    try {
      const conditions = ['expiresAt > :now'];
      const values = { ':now': at };
      for (const [key, value] of Object.entries(extra)) { conditions.push(`${key} = :${key}`); values[`:${key}`] = value; }
      const response = await client.send(new DeleteCommand({ TableName: tableName, Key: { pk },
        ConditionExpression: conditions.join(' AND '), ExpressionAttributeValues: values, ReturnValues: 'ALL_OLD' }));
      const row = response.Attributes;
      const completedAt = clock();
      if (!row || completedAt < at || row.expiresAt <= completedAt || deadline !== undefined && deadline <= completedAt) throw new AppleAuthenticationError();
      return row;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') throw new AppleAuthenticationError();
      throw error;
    }
  }
  async function mapping(row, username) {
    if (!row || row.state !== 'active' || !id(row.username) || !id(row.subject)
      || !/^NATIVEAPPLE#[a-f0-9]{64}$/.test(row.providerKey ?? '') || username && row.username !== username) throw new AppleAuthenticationError();
    const other = await get(row.pk.startsWith('NATIVEAPPLE#') ? nativeUserKey(row.username) : row.providerKey);
    if (!other || other.state !== 'active' || other.username !== row.username || other.subject !== row.subject || other.providerKey !== row.providerKey) throw new AppleAuthenticationError();
    return { username: row.username, subject: row.subject, providerKey: row.providerKey };
  }
  return {
    async begin() {
      const at = clock(), challengeId = randomBytes(32).toString('hex'), nonce = randomBytes(32).toString('hex');
      await put({ pk: `CHALLENGE#${hash(challengeId)}`, nonce, expiresAt: at + 300_000, ttl: Math.ceil((at + 300_000) / 1000) });
      if (clock() >= at + 300_000) throw new AppleAuthenticationError();
      return { challengeId, nonce };
    },
    async consumeChallenge(challengeId) {
      if (!hex(challengeId)) throw new AppleAuthenticationError();
      const row = await consume(`CHALLENGE#${hash(challengeId)}`);
      if (!hex(row.nonce)) throw new AppleAuthenticationError();
      return { nonce: row.nonce };
    },
    async findIdentity(providerSubject) {
      if (!id(providerSubject)) throw new AppleAuthenticationError();
      const key = nativeProviderKey(bundleId, providerSubject);
      const row = await get(key);
      if (!row) throw new NativeEnrollmentRequired();
      if (row.providerKey !== key) throw new AppleAuthenticationError();
      return mapping(row);
    },
    async requestEnrollment(providerSubject) {
      if (!id(providerSubject)) throw new AppleAuthenticationError();
      const providerKey = nativeProviderKey(bundleId, providerSubject), indexKey = enrollmentIdentityKey(providerKey);
      for (let attempt = 0; attempt < 6; attempt++) {
        // An existing blocked/malformed mapping must never become a new request.
        if (await get(providerKey)) throw new AppleAuthenticationError();
        const at = clock(), previous = await get(indexKey);
        if (previous && previous.expiresAt > at) {
          if (previous.state !== 'pending' || !hex(previous.requestId) || previous.providerKey !== providerKey) throw new AppleAuthenticationError();
          const request = await get(enrollmentKey(previous.requestId));
          if (!request || request.state !== 'pending' || request.providerKey !== providerKey || request.requestId !== previous.requestId
            || request.expiresAt !== previous.expiresAt || clock() >= request.expiresAt) throw new AppleAuthenticationError();
          return { requestId: previous.requestId };
        }
        const requestId = randomBytes(32).toString('hex'), expiresAt = at + 24 * 60 * 60_000;
        const data = { version: 1, requestId, providerKey, state: 'pending', createdAt: at, expiresAt, ttl: Math.ceil(expiresAt / 1000) };
        try {
          await client.send(new TransactWriteCommand({ TransactItems: [
            { ConditionCheck: { TableName: tableName, Key: { pk: providerKey }, ConditionExpression: 'attribute_not_exists(pk)' } },
            { Put: { TableName: tableName, Item: { pk: indexKey, ...data },
              ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now', ExpressionAttributeValues: { ':now': at } } },
            { Put: { TableName: tableName, Item: { pk: enrollmentKey(requestId), ...data }, ConditionExpression: 'attribute_not_exists(pk)' } },
          ] }));
          if (clock() >= expiresAt) throw new AppleAuthenticationError();
          return { requestId };
        } catch (error) {
          if (error?.name !== 'TransactionCanceledException' || !error.CancellationReasons?.some((r) => ['ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code))) throw error;
        }
      }
      throw new AppleAuthenticationError();
    },
    async findUsername(username) {
      if (!id(username)) throw new AppleAuthenticationError();
      return mapping(await get(nativeUserKey(username)), username);
    },
    async createProof({ username, subject, challengeNonce }) {
      if (!id(username) || !id(subject) || !hex(challengeNonce)) throw new AppleAuthenticationError();
      const proof = randomBytes(32).toString('hex'), at = clock();
      await put({ pk: `PROOF#${hash(proof)}`, username, subject, challengeNonce,
        expiresAt: at + 30_000, ttl: Math.ceil((at + 30_000) / 1000) });
      return proof;
    },
    async consumeProof({ proof, username, subject, challengeNonce }) {
      if (!hex(proof) || !id(username) || !id(subject) || !hex(challengeNonce)) throw new AppleAuthenticationError();
      await consume(`PROOF#${hash(proof)}`, { username, subject, challengeNonce });
    },
  };
}
