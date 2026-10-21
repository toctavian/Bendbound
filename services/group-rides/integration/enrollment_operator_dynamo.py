"""Actual DynamoDB Local transaction checks; Cognito is synthetic. Never reaches AWS."""
import asyncio
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import time
import unittest
import uuid
import boto3

endpoint = os.environ.get('GROUP_DYNAMO_LOCAL_ENDPOINT', '')
if not re.fullmatch(r'http://(127\.0\.0\.1|localhost):\d+', endpoint):
    raise RuntimeError('Local DynamoDB endpoint required')
spec = importlib.util.spec_from_file_location('enroll', Path(__file__).parents[1] / 'src/nativeEnrollmentOperator.py')
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
db = boto3.client('dynamodb', endpoint_url=endpoint, region_name='eu-west-2',
                  aws_access_key_id='synthetic', aws_secret_access_key='synthetic')
sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
encode = lambda values: {key: {'N': str(value)} if isinstance(value, int) else {'S': value} for key, value in values.items()}

class EnrollmentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.auth = 'enroll-auth-' + uuid.uuid4().hex
        self.sessions = 'enroll-session-' + uuid.uuid4().hex
        for table in [self.auth, self.sessions]:
            db.create_table(TableName=table, BillingMode='PAY_PER_REQUEST', KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}],
                AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'}])
        self.reference = uuid.uuid4().hex * 2
        self.provider = 'NATIVEAPPLE#' + uuid.uuid4().hex * 2
        self.request_pk = 'ENROLL#' + sha(self.reference)
        self.index_pk = 'ENROLLIDENTITY#' + self.provider[len('NATIVEAPPLE#'):]
        self.username = 'native_' + self.provider[len('NATIVEAPPLE#'):]
        self.subject = 'synthetic-' + uuid.uuid4().hex
        values = {'version': 1, 'requestId': self.reference, 'providerKey': self.provider, 'state': 'pending',
            'createdAt': int(time.time() * 1000), 'expiresAt': int(time.time() * 1000) + 60000}
        for pk in [self.request_pk, self.index_pk]:
            db.put_item(TableName=self.auth, Item=encode({'pk': pk, **values}))
        self.user = None
        self.calls = []
        self.before_commit = None
    def tearDown(self):
        for table in [self.auth, self.sessions]:
            db.delete_table(TableName=table)
    async def aws(self, *, service_name, operation_name, region_name, params):
        assert region_name == 'eu-west-2'
        self.calls.append((service_name, operation_name))
        if service_name == 'dynamodb':
            if operation_name == 'TransactWriteItems' and self.before_commit:
                hook, self.before_commit = self.before_commit, None
                hook()
            method = re.sub(r'(?<!^)(?=[A-Z])', '_', operation_name).lower()
            return getattr(db, method)(**params)
        assert service_name == 'cognito-idp'
        if operation_name == 'AdminGetUser':
            if self.user is None:
                raise RuntimeError('UserNotFoundException')
            return self.user
        if operation_name == 'AdminCreateUser':
            assert params['MessageAction'] == 'SUPPRESS'
            self.user = {'Enabled': True, 'UserStatus': 'FORCE_CHANGE_PASSWORD',
                'UserAttributes': [{'Name': 'sub', 'Value': self.subject}, *params['UserAttributes']]}
            return {}
        if operation_name == 'AdminSetUserPassword':
            assert params['Permanent'] is True
            self.user['UserStatus'] = 'CONFIRMED'
            return {}
        raise AssertionError(operation_name)
    async def run_operator(self, execute=False):
        return await operator.enroll(self.aws, auth_table=self.auth, session_table=self.sessions,
            pool_id='eu-west-2_Synthetic', request_id=self.reference, days=1, execute=execute)
    def read(self, table, pk):
        return db.get_item(TableName=table, Key={'pk': {'S': pk}}, ConsistentRead=True).get('Item')
    async def test_review_is_read_only_and_approval_commits_all_five_rows_then_retries_without_extension(self):
        self.assertEqual((await self.run_operator())['status'], 'review_required')
        self.assertFalse(any(s == 'cognito-idp' for s, _ in self.calls))
        self.assertIsNone(self.read(self.auth, self.provider))
        approved = await self.run_operator(True)
        self.assertEqual(approved['status'], 'approved')
        self.assertEqual(self.read(self.auth, self.provider)['subject']['S'], self.subject)
        self.assertEqual(self.read(self.auth, 'NATIVEUSER#' + sha(self.username))['subject']['S'], self.subject)
        grant = self.read(self.sessions, 'USER#' + sha(self.subject))
        self.assertEqual(grant['pilotExpiresAt']['N'], str(approved['pilotExpiresAt']))
        retry = await self.run_operator(True)
        self.assertEqual(retry['status'], 'already_approved')
        self.assertEqual(retry['pilotExpiresAt'], approved['pilotExpiresAt'])
        self.assertFalse(retry['extended'])
        grant['lifecycleHold'] = {'S': 'synthetic-hold'}
        db.put_item(TableName=self.sessions, Item=grant)
        with self.assertRaisesRegex(ValueError, 'no renewal'):
            await self.run_operator(True)
    async def test_withdrawal_between_read_and_commit_rolls_back_mappings_and_preserves_hold(self):
        def hold():
            db.put_item(TableName=self.sessions, Item=encode({'pk': 'USER#' + sha(self.subject),
                'subject': self.subject, 'state': 'blocked', 'lifecycleHold': 'synthetic-hold'}))
        self.before_commit = hold
        with self.assertRaises(Exception):
            await self.run_operator(True)
        self.assertIsNone(self.before_commit)
        self.assertIsNone(self.read(self.auth, self.provider))
        self.assertIsNone(self.read(self.auth, 'NATIVEUSER#' + sha(self.username)))
        self.assertEqual(self.read(self.sessions, 'USER#' + sha(self.subject))['lifecycleHold']['S'], 'synthetic-hold')
        self.assertEqual(self.read(self.auth, self.request_pk)['state']['S'], 'pending')
    async def test_expiry_during_cognito_provisioning_rolls_back_all_admission_records(self):
        def expire():
            row = self.read(self.auth, self.request_pk)
            row['expiresAt'] = {'N': '0'}
            db.put_item(TableName=self.auth, Item=row)
        self.before_commit = expire
        with self.assertRaises(Exception):
            await self.run_operator(True)
        self.assertIsNone(self.before_commit)
        self.assertIsNone(self.read(self.auth, self.provider))
        self.assertIsNone(self.read(self.sessions, 'USER#' + sha(self.subject)))
    async def test_preexisting_cognito_identity_is_not_linked_or_reset(self):
        self.user = {'Enabled': True, 'UserStatus': 'CONFIRMED', 'UserAttributes': [{'Name': 'sub', 'Value': 'synthetic-existing'}]}
        with self.assertRaisesRegex(ValueError, 'not owned'):
            await self.run_operator(True)
        self.assertFalse(any(op == 'AdminSetUserPassword' for _, op in self.calls))
        self.assertIsNone(self.read(self.auth, self.provider))

class OperatorOutcomeTests(unittest.TestCase):
    def test_ambiguous_sdk_result_never_claims_approval_was_not_applied(self):
        import sys
        from unittest.mock import patch
        sys.path.insert(0, str(Path(__file__).parents[1]))
        from src import nativeEnrollmentLambda as entrypoint
        event = {'requestId': 'a' * 64, 'days': 1, 'approve': True}
        config = {'NATIVE_AUTH_TABLE_NAME': 'synthetic-auth', 'SESSION_TABLE_NAME': 'synthetic-session', 'COGNITO_USER_POOL_ID': 'eu-west-2_Synthetic'}
        async def ambiguous(*args, **kwargs):
            raise RuntimeError('sensitive SDK failure after a possible commit')
        async def ineligible(*args, **kwargs):
            raise ValueError('sensitive account data')
        with patch.dict(os.environ, config), patch.object(entrypoint, 'enroll', ambiguous):
            result = entrypoint.handler(event, None)
            self.assertEqual(result['status'], 'unconfirmed')
            self.assertNotIn('sensitive', str(result))
        with patch.dict(os.environ, config), patch.object(entrypoint, 'enroll', ineligible):
            self.assertEqual(entrypoint.handler(event, None)['status'], 'not_applied')

if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        db.close()
