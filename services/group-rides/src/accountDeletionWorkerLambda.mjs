import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { KMSClient } from '@aws-sdk/client-kms';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createAccountDeletionStore } from './accountDeletionStore.mjs';
import { createAccountDeletionWorker } from './accountDeletionWorker.mjs';
import { createLifecycleRoomCoordinator } from './lifecycleRoomCoordinator.mjs';
import { createLifecycleHoldStore } from './lifecycleHoldStore.mjs';
import { createAppleGrantJournal } from './appleGrantJournal.mjs';
import { createAppleTokenDecryption } from './nativeAppleVault.mjs';
import { createNativeAppleRevoker } from './nativeApple.mjs';
import { createAppleProviderCleanup } from './appleProviderCleanup.mjs';
const e = process.env, config = { region: e.AWS_REGION, maxAttempts: 1 }, client = DynamoDBDocumentClient.from(new DynamoDBClient(config));
const secrets = new SecretsManagerClient(config);
const run = createAccountDeletionWorker({ client, cognito: new CognitoIdentityProviderClient(config), poolId: e.COGNITO_USER_POOL_ID,
  jobs: createAccountDeletionStore({ client, tableName: e.DELETION_TABLE_NAME, sessionTableName: e.SESSION_TABLE_NAME }),
  sessionTableName: e.SESSION_TABLE_NAME, authTableName: e.NATIVE_AUTH_TABLE_NAME,
  runRooms: createLifecycleRoomCoordinator({ client, progressTableName: e.LIFECYCLE_PROGRESS_TABLE_NAME, sessionTableName: e.SESSION_TABLE_NAME, roomTableName: e.ROOM_TABLE_NAME, locationTableName: e.LOCATION_TABLE_NAME }),
  cleanupProvider: createAppleProviderCleanup({ holds: createLifecycleHoldStore({ client, tableName: e.SESSION_TABLE_NAME }),
    journal: createAppleGrantJournal({ client, tableName: e.APPLE_GRANT_TABLE_NAME, sessionTableName: e.SESSION_TABLE_NAME }),
    decrypt: createAppleTokenDecryption({ kms: new KMSClient(config), keyId: e.APPLE_VAULT_KEY_ARN }),
    revoke: createNativeAppleRevoker({ bundleId: e.APPLE_BUNDLE_ID, teamId: e.APPLE_TEAM_ID, keyId: e.APPLE_KEY_ID,
      async readSigningKey() { const r = await secrets.send(new GetSecretValueCommand({ SecretId: e.APPLE_SIGNING_SECRET_ARN })); return JSON.parse(r.SecretString).private_key; } }),
  }),
});
export async function handler() {
  try {
    const result = await run();
    if (result.needsOperator) console.error(JSON.stringify({ event: 'ACCOUNT_DELETION_NEEDS_OPERATOR' }));
    return result;
  } catch { throw new Error('Account deletion worker requires retry.'); }
}
