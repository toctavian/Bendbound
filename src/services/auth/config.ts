export type AuthConfig = { domain: string; clientId: string; issuer: string; redirectUri: string };
export function parseAuthConfig(domain?: string, clientId?: string, userPoolId?: string): AuthConfig | null {
  if (!domain?.trim() || !clientId?.trim() || !userPoolId?.trim()) return null;
  try {
    const url = new URL(domain.trim());
    const pool = userPoolId.trim();
    const region = pool.split('_')[0];
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')
      || !/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/.test(pool)
      || !/^[A-Za-z0-9]+$/.test(clientId.trim())) return null;
    // A custom Cognito domain is allowed; it must be explicitly configured by us.
    return { domain: url.origin, clientId: clientId.trim(), issuer: `https://cognito-idp.${region}.amazonaws.com/${pool}`, redirectUri: 'bendbound://auth/callback' };
  } catch { return null; }
}
export const authConfig = parseAuthConfig(
  process.env.EXPO_PUBLIC_AUTH_DOMAIN,
  process.env.EXPO_PUBLIC_AUTH_CLIENT_ID,
  process.env.EXPO_PUBLIC_AUTH_USER_POOL_ID,
);
