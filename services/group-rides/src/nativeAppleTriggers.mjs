import { randomBytes } from 'node:crypto';
import { AppleAuthenticationError } from './nativeApple.mjs';
const marker = 'BEND_NATIVE_APPLE_V1';
/** Attach only to the intended pool/client. No authority from client metadata. */
export function createNativeAppleTriggers({ poolId, clientId, store, admitted }) {
  if (!poolId || !clientId || !store?.consumeProof || typeof admitted !== 'function') throw new Error('Native Cognito triggers must be configured.');
  return async function handler(event) {
    if (event.userPoolId !== poolId || event.callerContext?.clientId !== clientId || event.request?.userNotFound === true) throw new AppleAuthenticationError();
    const mapping = await store.findUsername(event.userName);
    if (event.request?.userAttributes?.sub !== mapping.subject || !await admitted(mapping.subject)) throw new AppleAuthenticationError();
    const source = event.triggerSource;
    if (source === 'DefineAuthChallenge_Authentication') {
      const session = event.request.session;
      const success = Array.isArray(session) && session.length === 1 && session[0].challengeName === 'CUSTOM_CHALLENGE'
        && session[0].challengeResult === true && session[0].challengeMetadata === marker;
      event.response = { issueTokens: success, failAuthentication: !success && (!Array.isArray(session) || session.length !== 0),
        ...(!success && Array.isArray(session) && session.length === 0 ? { challengeName: 'CUSTOM_CHALLENGE' } : {}) };
    } else if (source === 'CreateAuthChallenge_Authentication') {
      if (event.request.challengeName !== 'CUSTOM_CHALLENGE' || !Array.isArray(event.request.session) || event.request.session.length !== 0) throw new AppleAuthenticationError();
      const nonce = randomBytes(32).toString('hex');
      event.response = { publicChallengeParameters: { nonce }, privateChallengeParameters: { nonce }, challengeMetadata: marker };
    } else if (source === 'VerifyAuthChallengeResponse_Authentication') {
      event.response = { answerCorrect: false };
      try {
        await store.consumeProof({ proof: event.request.challengeAnswer, username: event.userName,
          subject: mapping.subject, challengeNonce: event.request.privateChallengeParameters?.nonce });
        event.response.answerCorrect = true;
      } catch (error) { if (!(error instanceof AppleAuthenticationError)) throw error; }
    } else if (['TokenGeneration_Authentication', 'TokenGeneration_RefreshTokens'].includes(source)) {
      if (event.version !== '2') throw new AppleAuthenticationError();
      event.response = { claimsAndScopeOverrideDetails: { accessTokenGeneration: {
        scopesToAdd: ['bendbound/groups', 'aws.cognito.signin.user.admin'],
      } } };
    } else throw new AppleAuthenticationError();
    return event;
  };
}
