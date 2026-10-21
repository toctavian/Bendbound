import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { createAccountTokenVerifier } from './authorizer.mjs';
import { createDynamoSessionRegistry } from './sessionRegistry.mjs';
import { createProviderProbe } from './providerProbe.mjs';
import { createAccountBudget } from './accountBudget.mjs';
import { createLogoutBudget } from './logoutBudget.mjs';
import { createSessionApi } from './sessionApi.mjs';
// Do not provide static AWS credentials; the runtime role supplies least-privilege access.
const region = process.env.AWS_REGION;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 2 }));
const registry = createDynamoSessionRegistry({
  client,
  tableName: process.env.SESSION_TABLE_NAME,
});
export const handler = createSessionApi({
  verifyToken: createAccountTokenVerifier({ userPoolId: process.env.COGNITO_USER_POOL_ID, clientId: process.env.COGNITO_CLIENT_ID }),
  consumeLogoutBudget: createLogoutBudget({ client, tableName: process.env.LOGOUT_BUDGET_TABLE_NAME }),
  consumeAccountBudget: createAccountBudget({ client, tableName: process.env.ACCOUNT_BUDGET_TABLE_NAME }),
  registry, probeProvider: createProviderProbe(new CognitoIdentityProviderClient({ region, maxAttempts: 2 })),
});
