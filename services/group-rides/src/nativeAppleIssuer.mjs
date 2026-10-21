import { AdminInitiateAuthCommand, AdminRespondToAuthChallengeCommand, GetUserCommand, RevokeTokenCommand } from '@aws-sdk/client-cognito-identity-provider';
import { AppleAuthenticationError } from './nativeApple.mjs';
/** The one-time proof never leaves the server. It is bound to Cognito's challenge. */
export function createNativeCognitoIssuer({ client, poolId, clientId, store, verifyToken }) {
  if (!client?.send || !poolId || !clientId || !store?.createProof || typeof verifyToken !== 'function') throw new Error('Native issuer not configured.');
  return async function issue(mapping) {
    const challenge = await client.send(new AdminInitiateAuthCommand({ UserPoolId: poolId, ClientId: clientId,
      AuthFlow: 'CUSTOM_AUTH', AuthParameters: { USERNAME: mapping.username } }));
    if (challenge.ChallengeName !== 'CUSTOM_CHALLENGE' || !challenge.Session
      || !/^[a-f0-9]{64}$/.test(challenge.ChallengeParameters?.nonce ?? '')) throw new AppleAuthenticationError();
    const proof = await store.createProof({ ...mapping, challengeNonce: challenge.ChallengeParameters.nonce });
    const response = await client.send(new AdminRespondToAuthChallengeCommand({ UserPoolId: poolId, ClientId: clientId,
      ChallengeName: 'CUSTOM_CHALLENGE', Session: challenge.Session,
      ChallengeResponses: { USERNAME: mapping.username, ANSWER: proof } }));
    const tokens = response.AuthenticationResult;
    try {
      if (!tokens?.AccessToken || !tokens.RefreshToken || !Number.isSafeInteger(tokens.ExpiresIn)
        || tokens.ExpiresIn < 1 || tokens.ExpiresIn > 300) throw new AppleAuthenticationError();
      const principal = await verifyToken(`Bearer ${tokens.AccessToken}`);
      if (principal.userId !== mapping.subject) throw new AppleAuthenticationError();
      const user = await client.send(new GetUserCommand({ AccessToken: tokens.AccessToken }));
      if (user.UserAttributes?.find((a) => a.Name === 'sub')?.Value !== mapping.subject) throw new AppleAuthenticationError();
      return { accessToken: tokens.AccessToken, refreshToken: tokens.RefreshToken, expiresIn: tokens.ExpiresIn };
    } catch (error) {
      // Provider vault is already durable. Keep it for lifecycle revocation even
      // if issuance fails; never delete it as compensation for a network failure.
      if (tokens?.RefreshToken) await client.send(new RevokeTokenCommand({ ClientId: clientId, Token: tokens.RefreshToken }));
      throw error;
    }
  };
}
