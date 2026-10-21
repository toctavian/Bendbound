/** Cognito's RFC 7009 endpoint: no client secret or access-token persistence. */
export async function revokeCognitoRefreshToken(endpoint: string, clientId: string, token: string, request: typeof fetch = fetch) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid revocation endpoint.');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      request(url.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, token, token_type_hint: 'refresh_token' }).toString(), signal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Revocation timed out.')); }, 10_000); }),
    ]);
    if (response.status !== 200) throw new Error('Revocation not confirmed.');
  } catch { throw new Error('Provider sign-out could not be confirmed.'); }
  finally { clearTimeout(timer); }
}
