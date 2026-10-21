import { GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { UnauthorizedError } from './authorizer.mjs';
/** Check provider revocation before admitting a previously unknown session family. */
export function createProviderProbe(client) {
  if (!client?.send) throw new Error('Provider verification must be configured.');
  return async function probe(accessToken, subject) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await client.send(new GetUserCommand({ AccessToken: accessToken }), { abortSignal: controller.signal });
      const providerSubject = response.UserAttributes?.find((attribute) => attribute.Name === 'sub')?.Value;
      if (providerSubject !== subject) throw new UnauthorizedError();
    } catch (error) {
      if (error instanceof UnauthorizedError || ['NotAuthorizedException', 'UserNotFoundException', 'PasswordResetRequiredException'].includes(error?.name)) throw new UnauthorizedError();
      // Outages/rate limits are service failures, never successful verification.
      throw new Error('Account provider is temporarily unavailable.');
    } finally { clearTimeout(timer); }
  };
}
