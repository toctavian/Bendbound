/** Private provider-only cleanup. Does not delete Cognito/users/rooms or release
 * any lifecycle hold, and never claims that an account was deleted. */
export function createAppleProviderCleanup({ holds, journal, decrypt, revoke }) {
  if (![holds?.read, journal?.page, journal?.removeUnderHold, journal?.empty, decrypt, revoke].every((v) => typeof v === 'function')) throw new Error('Provider cleanup must be configured.');
  return async ({ subject, eventId, holdStartedAt, cursor }) => {
    const first = await holds.read(subject, eventId);
    if (!first || !Number.isSafeInteger(holdStartedAt) || first.lifecycleHold.startedAt !== holdStartedAt) throw new Error('A lifecycle hold is required.');
    const hold = first.lifecycleHold;
    async function pin() {
      const current = await holds.read(subject, eventId);
      if (!current || current.lifecycleHold.version !== hold.version || current.lifecycleHold.binding !== hold.binding || current.lifecycleHold.startedAt !== hold.startedAt) throw new Error('Provider lifecycle hold changed.');
    }
    const page = await journal.page(subject, cursor);
    let removed = 0, uncertain = 0, failed = 0;
    for (const row of page.records) {
      await pin();
      if (['exchanging', 'uncertain'].includes(row.state)) { uncertain++; continue; }
      try {
        if (row.state !== 'closed') {
          const token = await decrypt(subject, row.envelope);
          await pin();
          await revoke(token);
        }
        await journal.removeUnderHold(row, hold);
        removed++;
      } catch { failed++; }
    }
    // Cursor cannot skip unresolved work and manufacture a completion result.
    await pin();
    const providerTokensDrained = await journal.empty(subject);
    await pin();
    return { providerTokensDrained, removed, uncertain, failed, nextCursor: page.cursor,
      ...(uncertain ? { manualProviderActionMayBeRequired: true } : {}) };
  };
}
