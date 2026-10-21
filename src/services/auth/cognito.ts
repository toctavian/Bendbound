import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';
import { authConfig } from './config';
import { nativeAppleClient } from './nativeApple';
import { revokeCognitoRefreshToken } from './providerRevocation';
import { groupSessionApi } from './groupSessions';
import { createSessionManager, SessionExpiredError } from './sessionManager';
import type { Account, SessionGrant } from './sessionManager';

const KEY = 'bendbound.account.refresh.v1';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainService: 'com.octavian.bendbound.accounts',
  // Active ride uploads need access after first unlock, including screen lock.
  // Device-only avoids restoring a refresh credential onto a different device.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
export const accountPreviewEnabled = process.env.EXPO_PUBLIC_ACCOUNTS_PREVIEW === 'true';
export const accountsAvailable = accountPreviewEnabled && authConfig !== null && groupSessionApi !== null && Platform.OS === 'ios';
const binding = authConfig ? `${authConfig.issuer}|${authConfig.clientId}|${groupSessionApi?.baseUrl ?? 'unconfigured'}` : 'unconfigured';
const discovery = authConfig ? {
  tokenEndpoint: `${authConfig.domain}/oauth2/token`,
  revocationEndpoint: `${authConfig.domain}/oauth2/revoke`,
} : null;
async function requireSecureStore() {
  if (!await SecureStore.isAvailableAsync()) throw new Error('Protected account storage is unavailable on this device.');
}
function requireConfig() {
  if (!accountsAvailable || !authConfig || !discovery) throw new Error('Accounts are not available in this build.');
  return { config: authConfig, endpoints: discovery };
}
async function grantFromResponse(response: AuthSession.TokenResponse, previousRefreshToken?: string, cachedAccount?: Account, appleName?: string): Promise<SessionGrant> {
  const { config } = requireConfig();
  const refreshToken = response.refreshToken ?? previousRefreshToken;
  if (!response.accessToken || !refreshToken || !response.expiresIn || response.expiresIn <= 0) throw new SessionExpiredError();
  if (cachedAccount) {
    // Refresh grants retain their account identity. Reuse display metadata so a
    // userInfo outage cannot discard the newly rotated credential. This cache
    // never authorises group access; server JWT/session checks are mandatory.
    return { accessToken: response.accessToken, refreshToken,
      expiresAt: (response.issuedAt + response.expiresIn) * 1000, account: cachedAccount };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // API-issued Cognito tokens use GetUser (userInfo requires OAuth scopes).
    // Display identity is provider-checked; the group backend verifies it again.
    const result = await fetch(new URL(config.issuer).origin, {
      method: 'POST', headers: { 'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.GetUser' },
      body: JSON.stringify({ AccessToken: response.accessToken }),
      redirect: 'error', signal: controller.signal,
    });
    if (result.status === 401 || result.status === 403) throw new SessionExpiredError();
    if (!result.ok) throw new Error('Account details could not be loaded.');
    const info: unknown = await result.json();
    if (!info || typeof info !== 'object' || !('UserAttributes' in info) || !Array.isArray(info.UserAttributes)) throw new SessionExpiredError();
    const attributes: unknown[] = info.UserAttributes;
    const attribute = (key: string): string => {
      const value = attributes.find((item: unknown) => item && typeof item === 'object' && 'Name' in item && item.Name === key);
      return value && typeof value === 'object' && 'Value' in value && typeof value.Value === 'string' ? value.Value : '';
    };
    const subject = attribute('sub');
    if (!subject) throw new SessionExpiredError();
    const name = attribute('name').trim().slice(0, 80);
    let savedName = '';
    try {
      const saved = JSON.parse(await SecureStore.getItemAsync('bendbound.account.display.v1', secureOptions) ?? 'null');
      if (saved?.subject === subject && typeof saved.name === 'string') savedName = saved.name.trim().slice(0, 80);
    } catch { /* Display cache never grants access. */ }
    return { accessToken: response.accessToken, refreshToken,
      expiresAt: (response.issuedAt + response.expiresIn) * 1000,
      account: { id: subject, displayName: savedName || appleName || name || 'Rider' } };
  } finally { clearTimeout(timer); }
}
export const accountSession = createSessionManager({
  binding,
  async createLogoutSecret() {
    const bytes = await Crypto.getRandomBytesAsync(32);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  },
  storage: {
    async read() {
      if (!accountsAvailable) return null;
      await requireSecureStore();
      const raw = await SecureStore.getItemAsync(KEY, secureOptions);
      if (raw === null) return null;
      try { return JSON.parse(raw) as unknown; } catch { return { version: -1 }; }
    },
    async write(value) {
      requireConfig(); await requireSecureStore();
      await SecureStore.setItemAsync(KEY, JSON.stringify(value), secureOptions);
    },
    async clear() {
      if (!accountsAvailable) return;
      await requireSecureStore(); await SecureStore.deleteItemAsync(KEY, secureOptions);
    },
  },
  async refresh(refreshToken, account) {
    const { config, endpoints } = requireConfig();
    try {
      const response = await AuthSession.refreshAsync({ clientId: config.clientId, refreshToken }, endpoints);
      return await grantFromResponse(response, refreshToken, account);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'invalid_grant') throw new SessionExpiredError();
      throw error;
    }
  },
  async activate(token, account, logoutSecret) {
    if (!groupSessionApi) throw new Error('The account service is not configured.');
    if (!logoutSecret) throw new Error('Protected sign-out is unavailable.');
    await groupSessionApi.register(token, account, logoutSecret);
  },
  async revoke(token, accessToken, logoutSecret) {
    const { config, endpoints } = requireConfig();
    const attempts = await Promise.allSettled([
      logoutSecret && groupSessionApi ? groupSessionApi.revokeWithSecret(logoutSecret)
        : accessToken && groupSessionApi ? groupSessionApi.revoke(accessToken) : Promise.reject(new Error('No sign-out proof is available.')),
      revokeCognitoRefreshToken(endpoints.revocationEndpoint, config.clientId, token),
    ]);
    if (attempts.some((attempt) => attempt.status === 'rejected')) throw new Error('Remote sign-out could not be confirmed.');
  },
});
export async function updateAccountDisplayName(name: string) {
  await accountSession.updateDisplayName(name);
  const account = accountSession.state().account;
  if (account) await SecureStore.setItemAsync('bendbound.account.display.v1', JSON.stringify({ subject: account.id, name: account.displayName }), secureOptions);
}
let signInRunning = false;
export async function signInWithApple(): Promise<boolean> {
  requireConfig();
  if (signInRunning) throw new Error('A sign-in is already open.');
  await accountSession.prepareSignIn();
  if (signInRunning) throw new Error('A sign-in is already open.');
  signInRunning = true;
  const attempt = accountSession.beginSignIn();
  try {
    await requireSecureStore();
    if (!nativeAppleClient || !await AppleAuthentication.isAvailableAsync()) {
      throw new Error('Native Apple sign-in is not configured in this build.');
    }
    const challenge = await nativeAppleClient.begin();
    let credential: AppleAuthentication.AppleAuthenticationCredential;
    try {
      credential = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
        nonce: challenge.nonce, state: challenge.challengeId,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_REQUEST_CANCELED') return false;
      throw new Error('Apple sign-in could not be completed.');
    }
    // The backend validates Apple and returns a Cognito grant. Raw Apple tokens
    // cannot activate a group session. No browser fallback is used.
    // Apple supplies a name only when first authorising. Retain display-only
    // metadata through pending pilot approval; it never identifies/authorises a user.
    const nameKey = 'bendbound.apple.display.v1';
    let appleName = credential.fullName ? AppleAuthentication.formatFullName(credential.fullName).trim().slice(0, 80) : '';
    if (appleName && credential.user) {
      await SecureStore.setItemAsync(nameKey, JSON.stringify({ user: credential.user, name: appleName }), secureOptions);
    } else if (credential.user) {
      try {
        const saved = JSON.parse(await SecureStore.getItemAsync(nameKey, secureOptions) ?? 'null');
        if (saved?.user === credential.user && typeof saved.name === 'string') appleName = saved.name.trim().slice(0, 80);
      } catch { /* Missing display metadata must not block verified login. */ }
    }
    const tokens = await nativeAppleClient.complete(challenge, credential);
    const response = new AuthSession.TokenResponse({ ...tokens, tokenType: 'bearer' });
    await accountSession.acceptSignIn(await grantFromResponse(response, undefined, undefined, appleName), attempt);
    return true;
  } finally { signInRunning = false; }
}

export async function restoreAccountSession() {
  if (!signInRunning) await accountSession.restore();
}

/** Root lifecycle retries pending revocation only; it never signs an account in. */
export async function retryPendingAccountSignOut() {
  if (accountsAvailable && !signInRunning) await accountSession.retrySignOut();
}
