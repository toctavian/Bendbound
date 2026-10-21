export const CLEANUP_METRIC_NAMESPACE = 'Bendbound/GroupRides';
/** Only aggregate fields reach CloudWatch. Never log events or raw SDK errors. */
export function createCleanupHandler({ store, functionName, now = Date.now, entity = 'Points', emit = (line) => process.stdout.write(`${line}\n`) }) {
  if (!['Points', 'Rooms'].includes(entity) || !store?.cleanup || !/^[A-Za-z0-9_-]{1,64}$/.test(functionName ?? '') || typeof emit !== 'function') throw new Error('Cleanup monitoring must be configured.');
  const metrics = (values) => emit(JSON.stringify({
    _aws: { Timestamp: now(), CloudWatchMetrics: [{ Namespace: CLEANUP_METRIC_NAMESPACE,
      Dimensions: [['FunctionName']], Metrics: Object.keys(values).map((Name) => ({ Name, Unit: Name === 'OldestObservedOverdueMs' ? 'Milliseconds' : 'Count' })),
    }] }, FunctionName: functionName, ...values,
  }));
  return async (_event, context) => {
    try {
      const outcome = await store.cleanup(now(), {
        // Leave time for metrics and a clean return instead of hard timeout. An
        // early stop restarts from the oldest index entries on the next tick.
        shouldContinue: () => !context?.getRemainingTimeInMillis || context.getRemainingTimeInMillis() > 5000,
      });
      for (const key of ['deleted', 'examined', 'oldestOverdueMs']) if (!Number.isFinite(outcome[key]) || outcome[key] < 0) throw new Error('Invalid cleanup result.');
      metrics({ CleanupSucceeded: 1, CleanupFailed: 0, CleanupBacklog: outcome.more ? 1 : 0,
        [`${entity}Deleted`]: outcome.deleted, [`${entity}Examined`]: outcome.examined, OldestObservedOverdueMs: outcome.oldestOverdueMs });
      return { deleted: outcome.deleted, examined: outcome.examined, more: !!outcome.more, oldestOverdueMs: outcome.oldestOverdueMs };
    } catch {
      try { metrics({ CleanupSucceeded: 0, CleanupFailed: 1 }); }
      catch { /* Monitoring failures must not escape the same redaction boundary. */ }
      // Do not attach cause: SDK failures can contain request identifiers/data.
      throw new Error(entity === 'Rooms' ? 'GROUP_ROOM_CLEANUP_FAILED' : 'GROUP_LOCATION_CLEANUP_FAILED');
    }
  };
}
