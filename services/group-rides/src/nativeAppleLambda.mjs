import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { KMSClient } from '@aws-sdk/client-kms';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createNativeAppleVerifier, createNativeAppleCodeExchange } from './nativeApple.mjs';
import { createNativeAppleStore } from './nativeAppleStore.mjs';
import { createAppleTokenEncryption } from './nativeAppleVault.mjs';
import { createAppleGrantJournal } from './appleGrantJournal.mjs';
import { createJournalledAppleExchange } from './journalledAppleExchange.mjs';
import { createNativeAppleApi } from './nativeAppleApi.mjs';
import { createNativeCognitoIssuer } from './nativeAppleIssuer.mjs';
import { createAccountTokenVerifier } from './authorizer.mjs';
import { createDynamoSessionRegistry } from './sessionRegistry.mjs';
import { createLogoutBudget } from './logoutBudget.mjs';
const config = { region: process.env.AWS_REGION, maxAttempts: 2 };
const db = DynamoDBDocumentClient.from(new DynamoDBClient(config));
const bundleId = process.env.APPLE_BUNDLE_ID;
const poolId = process.env.COGNITO_USER_POOL_ID, clientId = process.env.COGNITO_CLIENT_ID;
const store = createNativeAppleStore({ client: db, tableName: process.env.NATIVE_AUTH_TABLE_NAME, bundleId });
const registry = createDynamoSessionRegistry({ client: db, tableName: process.env.SESSION_TABLE_NAME });
const verifyIdentity = createNativeAppleVerifier({ bundleId });
const secrets = new SecretsManagerClient(config);
const exchangeCode = createNativeAppleCodeExchange({ bundleId, teamId: process.env.APPLE_TEAM_ID, keyId: process.env.APPLE_KEY_ID, verifyIdentity,
  async readSigningKey() {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.APPLE_SIGNING_SECRET_ARN }));
    const value = JSON.parse(response.SecretString ?? '{}');
    if (typeof value.private_key !== 'string') throw new Error('Apple signing material unavailable.');
    return value.private_key;
  },
});
export const handler = createNativeAppleApi({ apiId: process.env.NATIVE_AUTH_API_ID, store,
  // Dedicated table; both public routes share this global/per-source quota.
  consumeBudget: createLogoutBudget({ client: db, tableName: process.env.NATIVE_AUTH_BUDGET_TABLE_NAME }),
  verifyIdentity, admitted: registry.admitted,
  exchangeCode: createJournalledAppleExchange({
    provider: exchangeCode,
    encryption: createAppleTokenEncryption({ kms: new KMSClient(config), keyId: process.env.APPLE_VAULT_KEY_ARN }),
    journal: createAppleGrantJournal({ client: db, tableName: process.env.APPLE_GRANT_TABLE_NAME, sessionTableName: process.env.SESSION_TABLE_NAME }),
  }),
  issueSession: createNativeCognitoIssuer({ client: new CognitoIdentityProviderClient(config), poolId, clientId, store,
    verifyToken: createAccountTokenVerifier({ userPoolId: poolId, clientId }) }),
});
