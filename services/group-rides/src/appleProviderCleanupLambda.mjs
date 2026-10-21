import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createLifecycleHoldStore } from './lifecycleHoldStore.mjs';
import { createAppleGrantJournal } from './appleGrantJournal.mjs';
import { createAppleTokenDecryption } from './nativeAppleVault.mjs';
import { createNativeAppleRevoker } from './nativeApple.mjs';
import { createAppleProviderCleanup } from './appleProviderCleanup.mjs';
const config = { region: process.env.AWS_REGION, maxAttempts: 1 };
const client = DynamoDBDocumentClient.from(new DynamoDBClient(config));
const secrets = new SecretsManagerClient(config);
const cleanup = createAppleProviderCleanup({
  holds: createLifecycleHoldStore({ client, tableName: process.env.SESSION_TABLE_NAME }),
  journal: createAppleGrantJournal({ client, tableName: process.env.APPLE_GRANT_TABLE_NAME, sessionTableName: process.env.SESSION_TABLE_NAME }),
  decrypt: createAppleTokenDecryption({ kms: new KMSClient(config), keyId: process.env.APPLE_VAULT_KEY_ARN }),
  revoke: createNativeAppleRevoker({ bundleId: process.env.APPLE_BUNDLE_ID, teamId: process.env.APPLE_TEAM_ID, keyId: process.env.APPLE_KEY_ID,
    async readSigningKey() {
      const response = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.APPLE_SIGNING_SECRET_ARN }));
      const value = JSON.parse(response.SecretString ?? '{}');
      if (typeof value.private_key !== 'string') throw new Error('Apple signing material unavailable.');
      return value.private_key;
    },
  }),
});
/** IAM-only internal primitive. It never begins/releases holds or deletes accounts. */
export async function handler(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || Object.keys(event).some((k) => !['subject', 'eventId', 'holdStartedAt', 'cursor'].includes(k))
    || !Number.isSafeInteger(event.holdStartedAt) || event.holdStartedAt < 0
    || !['subject', 'eventId'].every((k) => typeof event[k] === 'string' && event[k].length > 0 && event[k].length <= 256)) {
    return { status: 'not_processed', reason: 'INVALID_REQUEST' };
  }
  try { return { status: 'provider_cleanup_checked', ...await cleanup(event) }; }
  catch { return { status: 'unconfirmed', reason: 'PROVIDER_CLEANUP_PENDING' }; }
}
