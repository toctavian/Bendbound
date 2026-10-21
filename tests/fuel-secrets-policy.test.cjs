const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');

test('EC2 Fuel Finder policy grants only value retrieval for the exact supplied secret',()=>{
  const template=JSON.parse(readFileSync('routing/ec2/fuel-secrets-access-template.json','utf8'));
  const resources=Object.values(template.Resources);
  assert.equal(resources.length,1);
  assert.equal(resources[0].Type,'AWS::IAM::Policy');
  const properties=resources[0].Properties;
  assert.deepEqual(properties.Roles,[{Ref:'InstanceRoleName'}]);
  assert.deepEqual(properties.PolicyDocument.Statement,[{Effect:'Allow',Action:['secretsmanager:GetSecretValue'],Resource:{Ref:'SecretArn'}}]);
  assert.ok(!JSON.stringify(template).includes('client_secret'));
  assert.ok(!JSON.stringify(template).includes('secretsmanager:*'));
});
