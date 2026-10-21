import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const read=(n)=>JSON.parse(readFileSync(new URL('../infra/'+n+'.template.json',import.meta.url)));
test('storage-only rollout gates group runtime and APIs while keeping room/point resources available',()=>{
 const t=read('rooms');assert.equal(t.Parameters.EnableServices.Default,'false');
 for(const [name,r] of Object.entries(t.Resources))if(!['RoomTable','LocationTable'].includes(name))assert.equal(r.Condition,'ServicesEnabled');
});
test('public deletion intake cannot delete provider/users; worker cannot create approval or release hold',()=>{
 const t=read('account-deletion'),statements=(n)=>t.Resources[n].Properties.Policies[0].PolicyDocument.Statement;
 assert.equal(statements('ApiRole').some(s=>s.Action.some(a=>/^(kms|secretsmanager|cognito-idp):/.test(a))),false);
 for(const s of statements('WorkerRole')){
  if(JSON.stringify(s.Resource).includes('${SessionTableName}'))assert.equal(s.Action.includes('dynamodb:PutItem')||s.Action.includes('dynamodb:UpdateItem'),false);
  assert.equal(s.Action.includes('lambda:InvokeFunction')||s.Action.includes('cognito-idp:AdminCreateUser')||s.Action.includes('kms:GenerateDataKey'),false);
 }
 assert.equal(t.Resources.WorkerFunction.Properties.ReservedConcurrentExecutions,1);assert.equal(t.Resources.Schedule.Properties.ScheduleExpression,'rate(1 minute)');
 assert.equal(t.Resources.DeletionTable.DeletionPolicy,'Retain');assert.equal('TimeToLiveSpecification' in t.Resources.ProgressTable.Properties,false);
});
