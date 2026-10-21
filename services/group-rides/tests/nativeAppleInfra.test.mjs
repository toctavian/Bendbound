import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const template = JSON.parse(readFileSync(new URL('../infra/native-apple.template.json', import.meta.url)));
const identity = JSON.parse(readFileSync(new URL('../infra/identity.template.json', import.meta.url)));
const statements = (role) => template.Resources[role].Properties.Policies[0].PolicyDocument.Statement;
test('bridge cannot grant admission, modify mappings, decrypt grants or expose provider secrets to triggers', () => {
  const bridge = statements('BridgeRole'), triggers = statements('TriggerRole');
  for (const statement of [...bridge, ...triggers].filter((s) => s.Action.some((action) => /dynamodb:(PutItem|UpdateItem|DeleteItem)/.test(action)))) {
    assert.equal(statement.Condition.Null['dynamodb:LeadingKeys'], 'false');
    const prefixes = statement.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
    assert.ok(prefixes.every((p) => !/^(USER|NATIVEAPPLE|NATIVEUSER)#/.test(p)));
  }
  assert.equal(bridge.some((s) => s.Action.includes('kms:Decrypt')), false);
  assert.equal(triggers.some((s) => s.Action.some((a) => /kms:|secretsmanager:/.test(a))), false);
  assert.deepEqual(bridge.find((s) => s.Action.includes('kms:GenerateDataKey')).Condition,
    { StringEquals: { 'kms:EncryptionContext:purpose': 'bendbound-native-apple' } });
  assert.equal(template.Resources.VaultKey.Properties.EnableKeyRotation, true);
  assert.equal(template.Resources.AuthTable.DeletionPolicy, 'Retain');
  assert.equal('AccessLogSettings' in template.Resources.Stage.Properties, false);
});
test('native auth is opt-in and Cognito keeps revocation/rotation with no password alternative', () => {
  assert.equal(identity.Parameters.NativeAppleTriggerArn.Default, '');
  const client = identity.Resources.PublicClient.Properties;
  assert.deepEqual(client.ExplicitAuthFlows['Fn::If'][1], ['ALLOW_CUSTOM_AUTH']);
  assert.equal(client.EnableTokenRevocation, true); assert.equal(client.RefreshTokenRotation.Feature, 'ENABLED');
  const enabled = identity.Resources.UserPool.Properties.LambdaConfig['Fn::If'][1];
  assert.equal(enabled.PreTokenGenerationConfig.LambdaVersion, 'V2_0');
  assert.deepEqual(template.Resources.TriggerPermission.Properties.SourceArn,
    { 'Fn::Sub': 'arn:${AWS::Partition}:cognito-idp:${AWS::Region}:${AWS::AccountId}:userpool/${CognitoUserPoolId}' });
});
test('privileged enrollment function is IAM-only, with no public route or runtime invocation grant', () => {
  const operator = template.Resources.OperatorFunction;
  assert.equal(operator.Properties.Runtime, 'python3.13');
  assert.equal(operator.Properties.ReservedConcurrentExecutions, 1);
  const serialized = JSON.stringify(template.Resources);
  assert.equal(serialized.includes('AWS::Lambda::Url'), false);
  for (const resource of Object.values(template.Resources)) {
    if (['AWS::Lambda::Permission', 'AWS::ApiGatewayV2::Integration'].includes(resource.Type)) {
      assert.equal(JSON.stringify(resource).includes('OperatorFunction'), false);
    }
  }
  for (const role of ['BridgeRole', 'TriggerRole']) {
    assert.equal(statements(role).some((s) => s.Action.includes('lambda:InvokeFunction') || s.Action.includes('cognito-idp:AdminCreateUser')), false);
  }
});
test('provider cleanup is IAM-only and cannot create/release holds, approve accounts or delete Cognito users', () => {
  assert.equal(template.Resources.AppleGrantTable.Properties.KeySchema.length, 2);
  assert.equal(template.Resources.AppleGrantTable.DeletionPolicy, 'Retain');
  for (const resource of Object.values(template.Resources)) {
    if (['AWS::Lambda::Permission', 'AWS::ApiGatewayV2::Integration'].includes(resource.Type)) {
      assert.equal(JSON.stringify(resource).includes('ProviderCleanupFunction'), false);
    }
  }
  const cleanup = statements('ProviderCleanupRole');
  assert.equal(cleanup.some((s) => s.Action.includes('cognito-idp:AdminDeleteUser') || s.Action.includes('dynamodb:PutItem') || s.Action.includes('dynamodb:UpdateItem')), false);
  assert.equal(cleanup.some((s) => s.Action.includes('kms:GenerateDataKey')), false);
  assert.equal(cleanup.some((s) => s.Action.includes('kms:Decrypt')), true);
  assert.equal(statements('BridgeRole').some((s) => s.Action.includes('kms:Decrypt')), false);
  assert.equal(JSON.stringify(statements('BridgeRole')).includes('VAULT#'), false);
});
