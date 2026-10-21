import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createNativeAppleStore } from './nativeAppleStore.mjs';
import { createDynamoSessionRegistry } from './sessionRegistry.mjs';
import { createNativeAppleTriggers } from './nativeAppleTriggers.mjs';
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION, maxAttempts: 1 }));
const store = createNativeAppleStore({ client, tableName: process.env.NATIVE_AUTH_TABLE_NAME, bundleId: process.env.APPLE_BUNDLE_ID });
const registry = createDynamoSessionRegistry({ client, tableName: process.env.SESSION_TABLE_NAME });
export const handler = createNativeAppleTriggers({ poolId: process.env.COGNITO_USER_POOL_ID,
  clientId: process.env.COGNITO_CLIENT_ID, store, admitted: registry.admitted });
