import { AppleExchangeRejectedError } from './nativeApple.mjs';
/** No provider call until signing, encryption and durable intent are ready. */
export function createJournalledAppleExchange({ provider, encryption, journal }) {
  if (!provider?.prepare || !encryption?.prepare || !journal?.begin) throw new Error('Journalled provider exchange must be configured.');
  return async (input, mapping) => {
    const prepared = await Promise.allSettled([provider.prepare(), encryption.prepare(mapping.subject)]);
    if (prepared.some((r) => r.status === 'rejected')) {
      if (prepared[1].status === 'fulfilled') prepared[1].value.dispose();
      throw new Error('Provider exchange preparation failed.');
    }
    const transport = prepared[0].value, cipher = prepared[1].value;
    let attempt, token, envelope;
    try {
      attempt = await journal.begin(mapping);
      try {
        const result = await transport.exchange({ ...input, capture: async (received) => {
          token = received;
          envelope = cipher.encrypt(received);
          await journal.capture(attempt, envelope);
        } });
        if (!token || result.subject === undefined) throw new Error('Provider did not capture credentials.');
        await journal.validate(attempt);
        // Provider refresh material never reaches the HTTP API/session issuer.
        return { provider: result.provider, subject: result.subject };
      } catch (error) {
        if (token) {
          try { await transport.revoke(token); await journal.closed(attempt); }
          catch {
            if (envelope) { try { await journal.capture(attempt, envelope); } catch { /* Existing intent remains unresolved. */ } }
            try { await journal.uncertain(attempt); } catch { /* Never erase durable initial intent. */ }
          }
        } else {
          try { if (error instanceof AppleExchangeRejectedError) await journal.closed(attempt); else await journal.uncertain(attempt); }
          catch { /* The pre-existing attempt still prevents false cleanup success. */ }
        }
        throw new Error('Apple sign-in could not be completed.');
      }
    } finally { cipher.dispose(); }
  };
}
