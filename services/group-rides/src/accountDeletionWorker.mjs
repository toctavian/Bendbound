import { ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AdminGetUserCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { userKey } from './sessionRegistry.mjs';
import { createLifecycleHoldStore } from './lifecycleHoldStore.mjs';
/** One bounded durable phase per call; Apple failures never block own-data erasure. */
export function createAccountDeletionWorker({ client, cognito, poolId, jobs, sessionTableName, authTableName,
  runRooms, cleanupProvider, now = Date.now }) {
  async function pin(job) {
    const row = await createLifecycleHoldStore({ client, tableName: sessionTableName, expectedStartedAt: job.holdStartedAt }).read(job.subject, job.eventId);
    if (!row) throw new Error('Deletion hold missing.');
    return row.lifecycleHold;
  }
  async function purgePage(job, tableName, verify = false) {
    const hold = await pin(job);
    const page = await client.send(new ScanCommand({ TableName: tableName, ConsistentRead: true, Limit: 20,
      FilterExpression: 'subject = :subject', ExpressionAttributeValues: { ':subject': job.subject },
      ...(job.cursor ? { ExclusiveStartKey: job.cursor } : {}) }));
    for (const row of page.Items ?? []) {
      if (tableName === sessionTableName && row.pk === userKey(job.subject).pk) continue;
      const allowed = tableName === sessionTableName ? /^(SESSION|LOGOUT)#[a-f0-9]{64}$/ : /^(NATIVEAPPLE|NATIVEUSER|ENROLL|ENROLLIDENTITY|PROOF)#[a-f0-9]{64}$/;
      if (!allowed.test(row.pk)) throw new Error('Unrecognized account data needs reconciliation.');
      if (verify) throw new Error('Account records remain after purge.');
      await client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: sessionTableName, Key: userKey(job.subject), ConditionExpression: 'lifecycleHold = :hold AND #state = :blocked AND subject = :subject', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':hold': hold, ':blocked': 'blocked', ':subject': job.subject } } },
        { Delete: { TableName: tableName, Key: { pk: row.pk }, ConditionExpression: 'subject = :subject', ExpressionAttributeValues: { ':subject': job.subject } } },
      ] }));
    }
    await pin(job);
    return page.LastEvaluatedKey ?? null;
  }
  async function removeCognito(job) {
    async function current() {
      try { return await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: job.subject })); }
      catch (error) { if (error?.name === 'UserNotFoundException') return undefined; throw error; }
    }
    const original = await current();
    if (original && original.UserAttributes?.find((v) => v.Name === 'sub')?.Value === job.subject) {
      await pin(job);
      try { await cognito.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: job.subject })); }
      catch (error) { if (error?.name !== 'UserNotFoundException') throw error; }
    }
    await pin(job);
    const after = await current();
    if (after?.UserAttributes?.find((v) => v.Name === 'sub')?.Value === job.subject) throw new Error('Cognito account remains.');
    // Immutable local-user sub avoids deleting a later account with the same username.
  }
  return async () => {
    const candidate = await jobs.next();
    if (!candidate) return { worked: false };
    let job = await jobs.claim(candidate);
    if (!job) return { worked: false };
    const context = { subject: job.subject, eventId: job.eventId, holdStartedAt: job.holdStartedAt };
    try {
      await pin(job);
      let change = { dueAt: now() + 60_000 };
      const phase = job.phase;
      if (phase === 'rooms') {
        const r = await runRooms(context);
        if (r.status === 'traversal_ended') change = { ...change, phase: 'sessions', cursor: null };
        else if (r.status !== 'pending') throw new Error('Room purge unconfirmed.');
      } else if (['sessions', 'native', 'sessions_final', 'native_final', 'verify_sessions', 'verify_native'].includes(phase)) {
        const session = phase.includes('sessions');
        const cursor = await purgePage(job, session ? sessionTableName : authTableName, phase.startsWith('verify_'));
        const next = { sessions: 'native', native: 'cognito', sessions_final: 'native_final', native_final: 'verify_sessions', verify_sessions: 'verify_native', verify_native: 'app_deleted' }[phase];
        change = { ...change, cursor, ...(cursor === null ? { phase: next } : {}) };
      } else if (phase === 'cognito') {
        await removeCognito(job);
        // Access tokens live at most five minutes. Six minutes also covers a
        // pre-hold auth/session Lambda still finishing its bounded request.
        change = { ...change, phase: 'settle', settledAt: now() + 360_000, dueAt: now() + 360_000 };
      } else if (phase === 'settle') {
        if (now() >= job.settledAt) change = { ...change, phase: 'sessions_final', cursor: null };
        else change.dueAt = job.settledAt;
      } else if (phase === 'app_deleted') {
        // Own-data progress is independent of inaccessible/missing Apple tokens.
        const r = await cleanupProvider({ ...context, ...(job.providerCursor ? { cursor: job.providerCursor } : {}) });
        const uncertain = job.providerUncertain === true || r.manualProviderActionMayBeRequired === true;
        const failed = job.providerPassFailed === true || r.failed > 0;
        const nextCursor = r.nextCursor ?? null;
        change = { ...change, failures: job.failures, providerCursor: nextCursor, providerUncertain: nextCursor ? uncertain : false,
          providerPassFailed: nextCursor ? failed : false };
        if (r.providerTokensDrained) { change.provider = 'drained'; change.failures = 0; }
        else if (nextCursor) change.provider = 'pending';
        else if (!failed && uncertain) { change.provider = 'manual'; change.failures = 0; }
        else {
          // Restart from the partition beginning on the next pass, so failures on
          // earlier pages are retried rather than stranded behind a final cursor.
          change.provider = 'pending';
          change.failures = job.failures + 1;
          change.dueAt = now() + Math.min(3600_000, 60_000 * 2 ** Math.min(change.failures, 6));
        }
      } else throw new Error('Unknown deletion phase.');
      await pin(job);
      job = await jobs.save(job, { failures: 0, ...change });
      return { worked: true, appDataDeleted: job.phase === 'app_deleted', provider: job.provider, ...(job.failures >= 8 ? { needsOperator: true } : {}) };
    } catch {
      try { job = await jobs.failed(job); } catch { /* Unknown outcome retains job/hold; retry only from durable read. */ }
      return { worked: true, pending: true, needsOperator: job.failures >= 8 };
    }
  };
}
