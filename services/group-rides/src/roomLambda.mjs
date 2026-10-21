import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAccountAuthorizer } from './authorizer.mjs';
import { createDynamoSessionRegistry } from './sessionRegistry.mjs';
import { createDynamoRoomStore } from './roomStore.mjs';
import { createRoomService } from './rooms.mjs';
import { createDynamoLocationStore } from './locationStore.mjs';
import { createLocationService } from './locations.mjs';
import { createRoomBudget } from './roomBudget.mjs';
import { createRoomApi } from './roomApi.mjs';
// Prototype entry point; no deployed routes or room table exist yet. This handler
// requires a separate metadata table and read-only account-registry permission.
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION, maxAttempts: 2 }));
const registry = createDynamoSessionRegistry({ client, tableName: process.env.SESSION_TABLE_NAME });
const store = createDynamoRoomStore({ client, registry, tableName: process.env.ROOM_TABLE_NAME, sessionTableName: process.env.SESSION_TABLE_NAME, locationTableName: process.env.LOCATION_TABLE_NAME });
const rooms = createRoomService({ store, sessionActive: registry.active });
const lobbyOnly = process.env.GROUP_LOBBY_ONLY !== 'false';
const locations = !lobbyOnly && process.env.LOCATION_TABLE_NAME ? createLocationService({ rooms, store: createDynamoLocationStore({
  client, registry, tableName: process.env.LOCATION_TABLE_NAME,
  roomTableName: process.env.ROOM_TABLE_NAME, sessionTableName: process.env.SESSION_TABLE_NAME,
}) }) : undefined;
export const handler = createRoomApi({ rooms, locations, lobbyOnly, consumeRoomBudget: createRoomBudget({ client, tableName: process.env.ROOM_BUDGET_TABLE_NAME }), authorize: createAccountAuthorizer({
  userPoolId: process.env.COGNITO_USER_POOL_ID, clientId: process.env.COGNITO_CLIENT_ID, sessionActive: registry.active,
}) });
