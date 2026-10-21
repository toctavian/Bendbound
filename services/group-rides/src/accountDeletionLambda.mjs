import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { createAccountTokenVerifier, UnauthorizedError } from './authorizer.mjs';
import { createLogoutBudget } from './logoutBudget.mjs';
import { createAccountDeletionStore } from './accountDeletionStore.mjs';
import { createAccountDeletionApi } from './accountDeletionApi.mjs';
const config = { region: process.env.AWS_REGION, maxAttempts: 1 };
const client = DynamoDBDocumentClient.from(new DynamoDBClient(config)), cognito = new CognitoIdentityProviderClient(config);
export const handler = createAccountDeletionApi({
  verifyToken: createAccountTokenVerifier({ userPoolId: process.env.COGNITO_USER_POOL_ID, clientId: process.env.COGNITO_CLIENT_ID }),
  consumeBudget: createLogoutBudget({ client, tableName: process.env.DELETION_BUDGET_TABLE_NAME, globalLimit: 60, sourceLimit: 12 }),
  jobs: createAccountDeletionStore({ client, tableName: process.env.DELETION_TABLE_NAME, sessionTableName: process.env.SESSION_TABLE_NAME }),
  async verifyProvider(accessToken, subject) {
    try {
      const r = await cognito.send(new GetUserCommand({ AccessToken: accessToken }));
      if (!r.Username || r.UserAttributes?.find((v) => v.Name === 'sub')?.Value !== subject) throw new UnauthorizedError();
      return r.Username;
    } catch (error) { if (['NotAuthorizedException', 'UserNotFoundException'].includes(error?.name)) throw new UnauthorizedError(); throw error; }
  },
});
