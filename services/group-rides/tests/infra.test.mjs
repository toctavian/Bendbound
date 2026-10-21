import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const template = JSON.parse(readFileSync(new URL('../infra/rooms.template.json', import.meta.url)));
const resources = template.Resources;
const statements = (role) => resources[role].Properties.Policies.flatMap((p) => p.PolicyDocument.Statement);
test('coordinate storage has no retention/backups/streams or coordinate index projection', () => {
  const table = resources.LocationTable;
  assert.equal(table.DeletionPolicy, 'Delete'); assert.equal(table.UpdateReplacePolicy, 'Delete');
  assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, false);
  assert.equal(table.Properties.StreamSpecification, undefined);
  assert.deepEqual(table.Properties.GlobalSecondaryIndexes[0].Projection, { ProjectionType: 'INCLUDE', NonKeyAttributes: ['pointVersion'] });
  assert.deepEqual(table.Properties.TimeToLiveSpecification, { AttributeName: 'ttl', Enabled: true });
  assert.equal(table.Properties.SSESpecification.SSEEnabled, true);
});
test('cleanup IAM can query expiry index and delete points, without reading coordinates or altering accounts/rooms', () => {
  const storage = statements('CleanupRole').filter((s) => s.Action.some((a) => a.startsWith('dynamodb:')));
  assert.equal(storage.length, 2);
  assert.deepEqual(storage[0].Action, ['dynamodb:Query']); assert.equal(storage[0].Resource['Fn::Sub'], '${LocationTable.Arn}/index/ExpiryIndex');
  assert.deepEqual(storage[1].Action, ['dynamodb:DeleteItem']); assert.deepEqual(storage[1].Resource, { 'Fn::GetAtt': ['LocationTable', 'Arn'] });
});
test('API role is read-only for session grants, with no scanning or administrative permissions', () => {
  const policy = statements('RoomRole');
  const account = policy.find((s) => JSON.stringify(s.Resource).includes('${SessionTableName}'));
  assert.deepEqual(account.Action.sort(), ['dynamodb:ConditionCheckItem', 'dynamodb:GetItem']);
  assert.equal(policy.some((s) => s.Action.some((a) => a === '*' || /Scan|Backup|Export|iam:|cognito/.test(a))), false);
  assert.equal(policy.some((s) => s.Resource === '*'), false);
});
test('cleanup is scheduled each minute, capped to one invocation, with bounded async retries', () => {
  assert.equal(resources.CleanupSchedule.Properties.ScheduleExpression, 'rate(1 minute)');
  assert.equal(resources.CleanupFunction.Properties.ReservedConcurrentExecutions, 1);
  assert.ok(resources.CleanupFunction.Properties.Timeout < 60);
  assert.equal(resources.CleanupAsyncConfig.Properties.MaximumEventAgeInSeconds, 60);
  assert.equal(resources.CleanupAsyncConfig.Properties.MaximumRetryAttempts, 0);
});
test('operational alarms include stalled schedule, backlog, errors, retention and dropped invocations', () => {
  for (const name of ['CleanupHeartbeatAlarm','CleanupBacklogAlarm','CleanupFailureAlarm','CleanupRetentionAlarm','CleanupDroppedEventAlarm','CleanupDeliveryAlarm']) assert.equal(resources[name].Type, 'AWS::CloudWatch::Alarm');
  assert.equal(resources.CleanupHeartbeatAlarm.Properties.TreatMissingData, 'breaching');
  assert.equal(resources.CleanupRetentionAlarm.Properties.Threshold, 60000);
  assert.equal(resources.GroupStage.Properties.AccessLogSettings, undefined);
  assert.equal(resources.RoomFunction.Properties.TracingConfig, undefined);
});
test('both APIs expose only a scoped, throttled POST revocation-capability route', () => {
  const sessions = JSON.parse(readFileSync(new URL('../infra/sessions.template.json', import.meta.url)));
  for (const [stack, stage] of [[template, 'GroupStage'], [sessions, 'SessionStage']]) {
    const route = stack.Resources.SessionLogoutRoute.Properties;
    assert.equal(route.RouteKey, 'POST /v1/session/logout');
    const permission = Object.values(stack.Resources).find((r) => r.Type === 'AWS::Lambda::Permission' && r.Properties.SourceArn?.['Fn::Sub']?.endsWith('/POST/v1/session/logout'));
    assert.ok(permission);
    assert.equal(stack.Resources[stage].Properties.RouteSettings[route.RouteKey].ThrottlingRateLimit, 1);
    const dependencies = stack.Resources[stage].DependsOn;
    assert.ok((Array.isArray(dependencies) ? dependencies : [dependencies]).includes('SessionLogoutRoute'),
      'Stage must wait for the logout route before applying its route-specific throttle');
  }
});
test('session runtime cannot grant pilot approval or modify USER records', () => {
  const sessions = JSON.parse(readFileSync(new URL('../infra/sessions.template.json', import.meta.url)));
  const policy = sessions.Resources.SessionRole.Properties.Policies.flatMap((p) => p.PolicyDocument.Statement);
  const writes = policy.filter((s) => JSON.stringify(s.Resource).includes('SessionTable') && s.Action.some((a) => /^dynamodb:(Put|Update|Delete|BatchWrite)/.test(a)));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'], ['SESSION#*', 'LOGOUT#*']);
  assert.equal(writes[0].Condition.Null['dynamodb:LeadingKeys'], 'false');
});
test('room metadata cleaner has its own index, least-privilege role, schedule and alarms', () => {
  const index = resources.RoomTable.Properties.GlobalSecondaryIndexes[0];
  assert.equal(index.IndexName, 'ExpiryIndex');
  assert.deepEqual(index.Projection, { ProjectionType: 'INCLUDE', NonKeyAttributes: ['revision'] });
  assert.deepEqual(index.KeySchema, [{ AttributeName: 'cleanupBucket', KeyType: 'HASH' }, { AttributeName: 'purgeAt', KeyType: 'RANGE' }]);
  const storage = statements('RoomCleanupRole').filter((s) => s.Action.some((a) => a.startsWith('dynamodb:')));
  assert.deepEqual(storage, [
    { Effect: 'Allow', Action: ['dynamodb:Query'], Resource: { 'Fn::Sub': '${RoomTable.Arn}/index/ExpiryIndex' } },
    { Effect: 'Allow', Action: ['dynamodb:DeleteItem'], Resource: { 'Fn::GetAtt': ['RoomTable', 'Arn'] } },
  ]);
  assert.equal(resources.RoomCleanupSchedule.Properties.ScheduleExpression, 'rate(1 minute)');
  assert.equal(resources.RoomCleanupFunction.Properties.ReservedConcurrentExecutions, 1);
  assert.deepEqual(resources.RoomCleanupFunction.Properties.Environment.Variables, { ROOM_TABLE_NAME: { Ref: 'RoomTable' } });
  for (const name of ['Heartbeat', 'Backlog', 'Failure', 'Retention', 'DroppedEvent', 'Delivery', 'RuntimeError', 'Throttle'])
    assert.equal(resources[`RoomCleanup${name}Alarm`].Type, 'AWS::CloudWatch::Alarm');
  assert.equal(resources.RoomCleanupAsyncConfig.Properties.MaximumRetryAttempts, 0);
});

test('logout budget storage is isolated, encrypted and update-only with no backups or source payloads', () => {
  const { Resources: r } = JSON.parse(readFileSync(new URL('../infra/sessions.template.json', import.meta.url)));
  assert.equal(r.LogoutBudgetTable.DeletionPolicy, 'Delete');
  assert.equal(r.LogoutBudgetTable.UpdateReplacePolicy, 'Delete');
  assert.equal(r.LogoutBudgetTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, false);
  assert.equal(r.LogoutBudgetTable.Properties.StreamSpecification, undefined);
  assert.equal(r.LogoutBudgetTable.Properties.SSESpecification.SSEEnabled, true);
  assert.deepEqual(r.LogoutBudgetTable.Properties.TimeToLiveSpecification, { AttributeName: 'ttl', Enabled: true });
  const grants = r.SessionRole.Properties.Policies.flatMap((p) => p.PolicyDocument.Statement)
    .filter((s) => JSON.stringify(s.Resource).includes('LogoutBudgetTable'));
  assert.equal(grants.length, 1); assert.deepEqual(grants[0].Action, ['dynamodb:UpdateItem']);
  assert.deepEqual(grants[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'], ['LOGOUT_RATE#*']);
  assert.deepEqual(r.SessionFunction.Properties.Environment.Variables.LOGOUT_BUDGET_TABLE_NAME, { Ref: 'LogoutBudgetTable' });
});

test('verified-account budget has isolated update-only storage and mandatory environment binding', () => {
  const { Resources: r } = JSON.parse(readFileSync(new URL('../infra/sessions.template.json', import.meta.url)));
  const table = r.AccountBudgetTable;
  assert.equal(table.DeletionPolicy, 'Delete'); assert.equal(table.UpdateReplacePolicy, 'Delete');
  assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, false);
  assert.equal(table.Properties.StreamSpecification, undefined); assert.equal(table.Properties.SSESpecification.SSEEnabled, true);
  assert.deepEqual(table.Properties.TimeToLiveSpecification, { AttributeName: 'ttl', Enabled: true });
  const grants = r.SessionRole.Properties.Policies.flatMap((p) => p.PolicyDocument.Statement)
    .filter((s) => JSON.stringify(s.Resource).includes('AccountBudgetTable'));
  assert.equal(grants.length, 1); assert.deepEqual(grants[0].Action, ['dynamodb:UpdateItem']);
  assert.deepEqual(grants[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'], ['ACCOUNT_RATE#bootstrap#*', 'ACCOUNT_RATE#logout#*', 'ACCOUNT_RATE#status#*']);
  assert.equal(grants[0].Condition.Null['dynamodb:LeadingKeys'], 'false');
  assert.deepEqual(r.SessionFunction.Properties.Environment.Variables.ACCOUNT_BUDGET_TABLE_NAME, { Ref: 'AccountBudgetTable' });
  assert.equal(JSON.stringify(template).includes('AccountBudgetTable'), false);
});

test('room operation counters are isolated, encrypted, update-only and unavailable to cleanup/session roles', () => {
  const table = resources.RoomBudgetTable;
  assert.equal(table.DeletionPolicy, 'Delete'); assert.equal(table.UpdateReplacePolicy, 'Delete');
  assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, false);
  assert.equal(table.Properties.StreamSpecification, undefined); assert.equal(table.Properties.SSESpecification.SSEEnabled, true);
  assert.deepEqual(table.Properties.TimeToLiveSpecification, { AttributeName: 'ttl', Enabled: true });
  const grants = statements('RoomRole').filter((s) => JSON.stringify(s.Resource).includes('RoomBudgetTable'));
  assert.equal(grants.length, 1); assert.deepEqual(grants[0].Action, ['dynamodb:UpdateItem']);
  assert.deepEqual(grants[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'], ['ROOM_RATE#create#*', 'ROOM_RATE#redeem#*', 'ROOM_RATE#fix#*', 'ROOM_RATE#snapshot#*', 'ROOM_RATE#invite#*', 'ROOM_RATE#control#*']);
  assert.equal(grants[0].Condition.Null['dynamodb:LeadingKeys'], 'false');
  assert.deepEqual(resources.RoomFunction.Properties.Environment.Variables.ROOM_BUDGET_TABLE_NAME, { Ref: 'RoomBudgetTable' });
  for (const role of ['CleanupRole', 'RoomCleanupRole']) assert.equal(JSON.stringify(statements(role)).includes('RoomBudgetTable'), false);
  const sessions = JSON.parse(readFileSync(new URL('../infra/sessions.template.json', import.meta.url)));
  assert.equal(JSON.stringify(sessions).includes('RoomBudgetTable'), false);
});
