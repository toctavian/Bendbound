/** Platform-independent session lifecycle. Tokens are never exposed in UI state. */
export type Account = { id: string; displayName: string };
export type SessionGrant = { accessToken: string; refreshToken: string; expiresAt: number; account: Account };
export type StoredSession = { version: 1; binding: string; refreshToken: string; account: Account; logoutSecret?: string };
export type PendingLogout = { version: 2; kind: 'logout'; binding: string; refreshToken: string; logoutSecret?: string };
export type SessionStatus = { account: Account | null; needsSignIn: boolean; logoutPending: boolean };
export class SessionExpiredError extends Error {
  constructor() { super('Your session has ended. Please sign in again.'); }
}
export type SessionDependencies = {
  binding: string;
  now?: () => number;
  storage: { read: () => Promise<unknown>; write: (session: StoredSession | PendingLogout) => Promise<void>; clear: () => Promise<void> };
  refresh: (refreshToken: string, account: Account) => Promise<SessionGrant>;
  createLogoutSecret?: () => Promise<string>;
  activate?: (accessToken: string, account: Account, logoutSecret?: string) => Promise<void>;
  revoke: (refreshToken: string, accessToken?: string, logoutSecret?: string) => Promise<void>;
};
export function createSessionManager(deps: SessionDependencies) {
  const now = deps.now ?? Date.now;
  let session: SessionGrant | null = null;
  let activating: SessionGrant | null = null;
  let epoch = 0;
  let logoutPending = false;
  let sessionSecret: string | undefined;
  let signingOut: Promise<{ providerRevoked: boolean }> | null = null;
  let refreshing: Promise<string> | null = null;
  let storageOperations: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(state: SessionStatus) => void>();
  const state = (): SessionStatus => ({ account: session?.account ?? null, needsSignIn: session === null, logoutPending });
  function publish() { for (const listener of listeners) { try { listener(state()); } catch { /* UI failure cannot undo session persistence. */ } } }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = storageOperations.then(operation, operation);
    storageOperations = result.catch(() => undefined);
    return result;
  }
  function validate(grant: SessionGrant) {
    if (!grant.accessToken || !grant.refreshToken || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now()
      || !grant.account?.id || typeof grant.account.displayName !== 'string') throw new SessionExpiredError();
  }
  async function install(grant: SessionGrant, expectedEpoch: number, newSignIn = false) {
    validate(grant);
    await serial(async () => {
      if (expectedEpoch !== epoch) throw new SessionExpiredError();
      const saved = await deps.storage.read() as (StoredSession | PendingLogout) | null;
      if (saved?.version === 2 && saved.kind === 'logout') throw new Error('Finish signing out before signing in.');
      const logoutSecret = (!newSignIn && saved?.binding === deps.binding && saved.version === 1 && saved.account.id === grant.account.id ? saved.logoutSecret : undefined)
        ?? await deps.createLogoutSecret?.();
      if (deps.createLogoutSecret && !/^[a-f0-9]{64}$/.test(logoutSecret ?? '')) throw new Error('Protected sign-out could not be prepared.');
      if (!newSignIn && saved?.version === 1 && saved.binding === deps.binding && saved.account.id === grant.account.id) {
        // A concurrent display edit must survive a refresh begun with older metadata.
        grant = { ...grant, account: saved.account };
      }
      // Persist a rotated refresh token before making it available to callers.
      await deps.storage.write({ version: 1, binding: deps.binding, refreshToken: grant.refreshToken, account: grant.account, ...(logoutSecret ? { logoutSecret } : {}) });
      if (expectedEpoch !== epoch) throw new SessionExpiredError();
      // Preserve rotated material even if backend activation is temporarily down.
      // The old access token remains the only active one until activation succeeds.
      if (session?.account.id === grant.account.id) session = { ...session, refreshToken: grant.refreshToken };
      else if (session) { session = null; publish(); }
      activating = grant;
      try {
        await deps.activate?.(grant.accessToken, grant.account, logoutSecret);
        if (expectedEpoch !== epoch) throw new SessionExpiredError();
        session = grant; sessionSecret = logoutSecret;
        publish();
      } finally { if (activating === grant) activating = null; }
    });
    return grant.accessToken;
  }
  async function discard(expectedEpoch: number) {
    await serial(async () => {
      if (epoch !== expectedEpoch) return;
      session = null;
      publish();
      await deps.storage.clear();
    });
  }
  async function renew(refreshToken: string, account: Account, expectedEpoch: number) {
    const oldSecret = sessionSecret;
    try {
      const grant = await deps.refresh(refreshToken, account);
      if (expectedEpoch !== epoch && oldSecret) {
        await serial(async () => {
          const saved = await deps.storage.read() as (StoredSession | PendingLogout) | null;
          // A late rotation remains revoke-only. Never overwrite a new account.
          if (!saved || saved.version === 2 && saved.kind === 'logout' && saved.logoutSecret === oldSecret) {
            await deps.storage.write({ version: 2, kind: 'logout', binding: deps.binding, refreshToken: grant.refreshToken, logoutSecret: oldSecret });
            session = null; logoutPending = true; publish();
          }
        });
        throw new SessionExpiredError();
      }
      return await install(grant, expectedEpoch);
    } catch (error) {
      // A network failure must not erase credentials. Definitive rejection must.
      if (error instanceof SessionExpiredError) await discard(expectedEpoch);
      throw error;
    }
  }
  async function finishSignOut(accessToken?: string): Promise<{ providerRevoked: boolean }> {
    if (signingOut) return signingOut;
    const operation = (async () => {
      const saved = await serial(deps.storage.read) as Partial<PendingLogout> | null;
      if (saved?.version !== 2 || saved.kind !== 'logout') return { providerRevoked: !logoutPending };
      logoutPending = true; session = null; publish();
      if (saved.binding !== deps.binding || typeof saved.refreshToken !== 'string' || !saved.refreshToken) throw new Error('Sign-out requires the original account configuration.');
      try { await deps.revoke(saved.refreshToken, accessToken, saved.logoutSecret); }
      catch { return { providerRevoked: false }; }
      const cleared = await serial(async () => {
        const current = await deps.storage.read() as Partial<PendingLogout> | null;
        if (current?.version !== 2 || current.kind !== 'logout' || current.refreshToken !== saved.refreshToken || current.logoutSecret !== saved.logoutSecret) return false;
        await deps.storage.clear(); return true;
      });
      if (!cleared) return { providerRevoked: false };
      logoutPending = false; sessionSecret = undefined; publish();
      return { providerRevoked: true };
    })();
    signingOut = operation;
    try { return await operation; } finally { if (signingOut === operation) signingOut = null; }
  }
  return {
    state,
    retrySignOut: () => finishSignOut(),
    async prepareSignIn() {
      const saved = await serial(deps.storage.read) as Partial<PendingLogout> | null;
      if (refreshing && !session || logoutPending || saved?.version === 2 && saved.kind === 'logout') {
        logoutPending = true; publish(); throw new Error('Finish signing out before signing in.');
      }
    },
    subscribe(listener: (value: SessionStatus) => void) {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    async restore() {
      const expectedEpoch = epoch;
      const value = await serial(deps.storage.read);
      if (epoch !== expectedEpoch || value === null || value === undefined) return;
      if ((value as Partial<PendingLogout>).version === 2 && (value as Partial<PendingLogout>).kind === 'logout') {
        logoutPending = true; session = null; publish(); await finishSignOut(); return;
      }
      if (logoutPending) return;
      const saved = value as Partial<StoredSession>;
      if (saved.version !== 1 || saved.binding !== deps.binding || typeof saved.refreshToken !== 'string' || !saved.refreshToken
        || !saved.account || typeof saved.account.id !== 'string' || !saved.account.id || typeof saved.account.displayName !== 'string') {
        await discard(expectedEpoch); return;
      }
      if (refreshing) { await refreshing; return; }
      const operation = renew(saved.refreshToken, saved.account, expectedEpoch);
      refreshing = operation;
      try { await operation; } finally { if (refreshing === operation) refreshing = null; }
    },
    // Capture before the browser opens; a later logout invalidates its result.
    beginSignIn() { if (logoutPending || refreshing && !session) throw new Error('Finish signing out before signing in.'); return ++epoch; },
    async acceptSignIn(grant: SessionGrant, attempt: number) {
      try { await install(grant, attempt, true); }
      catch (error) {
        if (error instanceof SessionExpiredError) await discard(attempt);
        throw error;
      }
    },
    async updateDisplayName(value: string) {
      const displayName = value.trim();
      if (!displayName || displayName.length > 80 || /[\x00-\x1f]/.test(displayName)) throw new Error('Enter a name of 1–80 characters.');
      const expectedEpoch = epoch, accountId = session?.account.id;
      await serial(async () => {
        const saved = await deps.storage.read() as StoredSession | PendingLogout | null;
        if (!accountId || epoch !== expectedEpoch || !session || session.account.id !== accountId || logoutPending
          || saved?.version !== 1 || saved.binding !== deps.binding || saved.account.id !== accountId) throw new SessionExpiredError();
        await deps.storage.write({ ...saved, account: { ...saved.account, displayName } });
        if (epoch !== expectedEpoch || !session || session.account.id !== accountId) throw new SessionExpiredError();
        session = { ...session, account: { ...session.account, displayName } };
        publish();
      });
    },
    async accessToken() {
      if (refreshing) return refreshing;
      if (!session) throw new SessionExpiredError();
      if (session.expiresAt > now() + 60_000) return session.accessToken;
      const operation = renew(session.refreshToken, session.account, epoch);
      refreshing = operation;
      try { return await operation; } finally { if (refreshing === operation) refreshing = null; }
    },
    async signOut(): Promise<{ providerRevoked: boolean }> {
      if (signingOut) return signingOut;
      ++epoch; // Prevent an in-flight refresh/sign-in from restoring the account.
      const token = activating?.refreshToken ?? session?.refreshToken;
      const accessToken = activating?.accessToken ?? session?.accessToken;
      const secret = sessionSecret;
      session = null; logoutPending = true; publish();
      await serial(async () => {
        const value = await deps.storage.read() as (StoredSession | PendingLogout) | null;
        if (value?.version === 2 && value.kind === 'logout') return;
        const refreshToken = value?.binding === deps.binding ? value.refreshToken : token;
        if (!refreshToken) { await deps.storage.clear(); logoutPending = false; publish(); return; }
        // One protected-key replacement persists intent before any network work.
        // Pending material can only revoke; restore must never refresh/activate it.
        const logoutSecret = value?.binding === deps.binding ? value.logoutSecret : secret;
        await deps.storage.write({ version: 2, kind: 'logout', binding: deps.binding, refreshToken,
          ...(logoutSecret ? { logoutSecret } : {}) });
      });
      return finishSignOut(accessToken);
    },
  };
}
