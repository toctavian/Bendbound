import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hash } from './locationKeys.mjs';
import { userKey } from './sessionRegistry.mjs';
import { UnauthorizedError } from './authorizer.mjs';
import { createLifecycleHoldStore } from './lifecycleHoldStore.mjs';

const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const fail = () => { throw new Error('Invalid or conflicting lifecycle progress.'); };

/** Internal page ledger only. No deletion worker, lifecycle lock or completion API. */
export function createLifecycleProgressStore({ client, tableName, sessionTableName, roomTableName, locationTableName, now = Date.now, holdStartedAt }) {
  const tables = [tableName, sessionTableName, roomTableName, locationTableName];
  if (!client?.send || new Set(tables).size !== 4 || tables.some((t) => !/^[A-Za-z0-9_.-]{3,255}$/.test(t ?? '')))
    throw new Error('Separate lifecycle progress storage must be configured.');
  const holds = createLifecycleHoldStore({ client, tableName: sessionTableName, expectedStartedAt: holdStartedAt });
  async function held(subject, c) {
    const row = await holds.read(subject, c.eventId);
    if (!row) throw new UnauthorizedError();
    return row.lifecycleHold;
  }
  const incarnation = holdStartedAt === undefined ? [] : [holdStartedAt];
  function context(subject, eventId) {
    if (!id(subject) || !id(eventId)) fail();
    return { eventId, pk: `LIFECYCLE#${hash(JSON.stringify([subject, eventId]))}`,
      binding: hash(JSON.stringify([subject, eventId, ...tables, ...incarnation])),
      discovery: hash(JSON.stringify([subject, eventId, roomTableName, sessionTableName, locationTableName, ...incarnation])) };
  }
  function cursor(value, c) {
    if (value === null) return true;
    if (!exact(value, ['version', 'binding', 'phase', 'key']) || value.version !== 1 || value.binding !== c.discovery
      || !['rooms', 'points'].includes(value.phase)) return false;
    if (value.key === null) return value.phase === 'points';
    return exact(value.key, value.phase === 'rooms' ? ['pk'] : ['pk', 'sk'])
      && /^ROOM#[a-f0-9]{64}$/.test(value.key.pk)
      && (value.phase === 'rooms' || /^RIDER#[a-f0-9]{64}$/.test(value.key.sk));
  }
  function page(value, c) {
    return exact(value, ['roomIds', 'next']) && Array.isArray(value.roomIds) && value.roomIds.length <= 100
      && Array.from(value.roomIds).every(digest) && new Set(value.roomIds).size === value.roomIds.length && cursor(value.next, c);
  }
  function follows(next, current) {
    if (next !== null && current !== null && next.phase === current.phase
      && next.key?.pk === current.key?.pk && next.key?.sk === current.key?.sk) return false;
    return current?.phase === 'points' ? next === null || (next.phase === 'points' && next.key !== null)
      : next !== null && (next.phase === 'rooms' || next.key === null);
  }
  function validate(row, c) {
    if (!exact(row, ['pk', 'version', 'binding', 'revision', 'cursor', 'pendingPage', 'traversalEnded', 'lease'])
      || row.pk !== c.pk || row.version !== 1 || row.binding !== c.binding || !integer(row.revision) || row.revision < 1
      || !cursor(row.cursor, c) || typeof row.traversalEnded !== 'boolean'
      || (row.pendingPage !== null && (!page(row.pendingPage, c) || !follows(row.pendingPage.next, row.cursor)))
      || (row.traversalEnded && (row.pendingPage !== null || row.cursor !== null))
      || (row.lease !== null && (!exact(row.lease, ['token', 'until']) || !digest(row.lease.token) || !integer(row.lease.until)))) fail();
  }
  function clock() { const at = now(); if (!integer(at) || at > Number.MAX_SAFE_INTEGER - 60_000) fail(); return at; }
  async function load(c) {
    const row = (await client.send(new GetCommand({ TableName: tableName, Key: { pk: c.pk }, ConsistentRead: true }))).Item;
    if (row !== undefined) validate(row, c);
    return row;
  }
  async function write(subject, c, previous, row) {
    validate(row, c);
    const hold = await held(subject, c);
    // Hold I/O may consume the remaining lease, including a newly claimed one.
    // Refuse an already-expired write before sending; revision/hold conditions
    // still fence concurrent owners at DynamoDB commit time.
    if (row.lease && row.lease.until <= clock()) fail();
    await client.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: sessionTableName, Key: userKey(subject),
        ConditionExpression: '#state = :blocked AND subject = :subject AND lifecycleHold = :hold AND attribute_not_exists(#ttl) AND attribute_not_exists(expiresAt) AND attribute_not_exists(pilotExpiresAt)',
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':blocked': 'blocked', ':subject': subject, ':hold': hold } } },
      { Put: { TableName: tableName, Item: row,
        ConditionExpression: previous ? '#revision = :revision AND #binding = :binding' : 'attribute_not_exists(pk)',
        ...(previous ? { ExpressionAttributeNames: { '#revision': 'revision', '#binding': 'binding' },
          ExpressionAttributeValues: { ':revision': previous.revision, ':binding': c.binding } } : {}) } },
    ] }));
    return structuredClone(row);
  }
  async function change(subject, eventId, receipt, transform, leased = true) {
    // Snapshot caller inputs before the first await.
    const expected = structuredClone(receipt), c = context(subject, eventId);
    if (!exact(expected, ['revision', 'token']) || !integer(expected.revision) || !digest(expected.token)) fail();
    const row = await load(c), at = clock();
    if (!row || row.revision !== expected.revision || row.revision >= Number.MAX_SAFE_INTEGER || row.traversalEnded) fail();
    if (leased && (row.lease?.token !== expected.token || row.lease.until <= at)) fail();
    const next = structuredClone(row); transform(next, at, expected.token, c); next.revision++;
    return write(subject, c, row, next);
  }
  return {
    async read(subject, eventId) {
      const c = context(subject, eventId);
      const before = await held(subject, c), row = await load(c), after = await held(subject, c);
      if (before.startedAt !== after.startedAt) throw new UnauthorizedError();
      return structuredClone(row);
    },
    async initialize(subject, eventId) {
      const c = context(subject, eventId);
      return write(subject, c, null, { pk: c.pk, version: 1, binding: c.binding, revision: 1,
        cursor: null, pendingPage: null, traversalEnded: false, lease: null });
    },
    async claim(subject, eventId, receipt, leaseMs = 30_000) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60_000) fail();
      return change(subject, eventId, receipt, (row, at, token) => {
        if (row.lease && (row.lease.until > at || row.lease.token === token)) fail();
        row.lease = { token, until: at + leaseMs };
      }, false);
    },
    async release(subject, eventId, receipt) {
      return change(subject, eventId, receipt, (row) => { row.lease = null; });
    },
    async stagePage(subject, eventId, receipt, value) {
      const saved = structuredClone(value);
      return change(subject, eventId, receipt, (row, _at, _token, c) => {
        if (row.pendingPage !== null || !page(saved, c) || !follows(saved.next, row.cursor)) fail();
        row.pendingPage = saved;
      });
    },
    async acknowledge(subject, eventId, receipt, roomId) {
      if (!digest(roomId)) fail();
      return change(subject, eventId, receipt, (row) => {
        if (row.pendingPage?.roomIds[0] !== roomId) fail();
        row.pendingPage.roomIds.shift();
      });
    },
    async advance(subject, eventId, receipt) {
      return change(subject, eventId, receipt, (row) => {
        if (!row.pendingPage || row.pendingPage.roomIds.length) fail();
        row.cursor = row.pendingPage.next; row.traversalEnded = row.cursor === null; row.pendingPage = null;
      });
    },
  };
}
