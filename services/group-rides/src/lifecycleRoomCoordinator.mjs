import { randomBytes } from 'node:crypto';
import { createLifecycleHoldStore } from './lifecycleHoldStore.mjs';
import { createLifecycleProgressStore } from './lifecycleProgressStore.mjs';
import { createLifecycleDiscoveryStore } from './blockedAccountDiscoveryStore.mjs';
import { createLifecycleRoomStore } from './blockedAccountRoomStore.mjs';
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256;
const receipt = (row) => ({ revision: row.revision, token: row.lease.token });
/** Private, bounded room/point erasure stage. The caller must persist and retry its
 * original hold context. Traversal is never an account-deletion acknowledgement.
 * No account creation, hold creation/release, provider or Cognito side effects. */
export function createLifecycleRoomCoordinator({ client, progressTableName, roomTableName, sessionTableName,
  locationTableName, now = Date.now, maxSteps = 12, maxRunMs = 20_000, pageLimit = 10 }) {
  if (!client?.send || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100
    || !Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 20_000
    || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) throw new Error('Lifecycle worker must be configured.');
  const clock = () => { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw new Error('Lifecycle clock unavailable.'); return at; };
  return async function run(input) {
    // Copy/validate trusted context before any awaited I/O. No caller cursors or leases.
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 3 || !['subject', 'eventId', 'holdStartedAt'].every((k) => Object.hasOwn(input, k))
      || !id(input.subject) || !id(input.eventId) || !Number.isSafeInteger(input.holdStartedAt) || input.holdStartedAt < 0) throw new Error('Invalid lifecycle worker context.');
    const { subject, eventId, holdStartedAt } = input, started = clock();
    const holds = createLifecycleHoldStore({ client, tableName: sessionTableName, expectedStartedAt: holdStartedAt });
    const pin = async () => { if (!await holds.read(subject, eventId)) throw new Error('Lifecycle hold required.'); };
    const ledger = createLifecycleProgressStore({ client, tableName: progressTableName, sessionTableName, roomTableName, locationTableName, now, holdStartedAt });
    const config = { client, tableName: roomTableName, sessionTableName, locationTableName, now, holdStartedAt };
    const discovery = createLifecycleDiscoveryStore(config), purge = createLifecycleRoomStore(config);
    await pin();
    let row = await ledger.read(subject, eventId);
    if (!row) row = await ledger.initialize(subject, eventId);
    if (row.traversalEnded) { await pin(); return { status: 'traversal_ended', roomsProcessed: 0 }; }
    const at = clock();
    if (row.lease && row.lease.until > at) {
      await pin();
      return { status: 'pending', roomsProcessed: 0, retryAfterMs: row.lease.until - at };
    }
    row = await ledger.claim(subject, eventId, { revision: row.revision, token: randomBytes(32).toString('hex') });
    let processed = 0;
    for (let step = 0; step < maxSteps; step++) {
      const at = clock();
      if (at < started) throw new Error('Lifecycle clock moved backwards.');
      // Stop before lease expiry; a later invocation reclaims only after expiry.
      if (at - started >= maxRunMs || row.lease.until <= at + 1000) break;
      await pin();
      if (!row.pendingPage) {
        const page = await discovery.readPage(subject, eventId, { cursor: row.cursor, limit: pageLimit });
        // A failed/lost stage response stops this invocation before any purge.
        row = await ledger.stagePage(subject, eventId, receipt(row), page);
      } else if (row.pendingPage.roomIds.length) {
        const roomId = row.pendingPage.roomIds[0];
        await purge.purgeRoom(subject, eventId, roomId);
        // A purge response failure leaves this item staged for idempotent retry.
        row = await ledger.acknowledge(subject, eventId, receipt(row), roomId);
        processed++;
      } else {
        row = await ledger.advance(subject, eventId, receipt(row));
        if (row.traversalEnded) { await pin(); return { status: 'traversal_ended', roomsProcessed: processed }; }
      }
    }
    // Cooperative yield enables immediate continuation without exposing lease tokens.
    row = await ledger.release(subject, eventId, receipt(row));
    await pin();
    return { status: 'pending', roomsProcessed: processed, retryAfterMs: 0 };
  };
}
