import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCleanupHandler } from './cleanupWorker.mjs';
import { createDynamoSessionRegistry } from './sessionRegistry.mjs';
import { createDynamoLocationStore } from './locationStore.mjs';
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION, maxAttempts: 2 }));
const registry = createDynamoSessionRegistry({ client, tableName: process.env.SESSION_TABLE_NAME });
const store = createDynamoLocationStore({ client, registry, tableName: process.env.LOCATION_TABLE_NAME,
  roomTableName: process.env.ROOM_TABLE_NAME, sessionTableName: process.env.SESSION_TABLE_NAME });
// No account/room reads or writes are performed by the worker; those names
// only enforce distinct-table configuration in the shared adapter.
export const handler = createCleanupHandler({ store, functionName: process.env.AWS_LAMBDA_FUNCTION_NAME });
