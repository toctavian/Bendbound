import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCleanupHandler } from './cleanupWorker.mjs';
import { createDynamoRoomCleanupStore } from './roomCleanupStore.mjs';
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION, maxAttempts: 2 }));
const store = createDynamoRoomCleanupStore({ client, tableName: process.env.ROOM_TABLE_NAME });
export const handler = createCleanupHandler({ store, entity: 'Rooms', functionName: process.env.AWS_LAMBDA_FUNCTION_NAME });
