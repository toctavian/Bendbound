"""Runs in the private IAM-only operator Lambda. No automatic approvals."""
import hashlib
import secrets
import time


async def enroll(call_boto3, *, auth_table, session_table, pool_id, request_id, days=1, execute=False):
    if len(request_id) != 64 or any(c not in '0123456789abcdef' for c in request_id):
        raise ValueError('Invalid approval reference')
    if not isinstance(days, int) or not 1 <= days <= 7:
        raise ValueError('Pilot approval must be 1–7 days')
    if not auth_table or not session_table or not pool_id.startswith('eu-west-2_'):
        raise ValueError('Invalid pilot deployment')
    region = 'eu-west-2'
    digest = lambda value: hashlib.sha256(value.encode()).hexdigest()
    text = lambda item, key: item.get(key, {}).get('S')
    number = lambda item, key: int(item.get(key, {}).get('N', '-1'))
    async def aws(service, operation, params):
        return await call_boto3(service_name=service, operation_name=operation, region_name=region, params=params)
    async def get(table, pk):
        return (await aws('dynamodb', 'GetItem', {'TableName': table, 'Key': {'pk': {'S': pk}}, 'ConsistentRead': True})).get('Item', {})
    request_hash = digest(request_id)
    request_pk = 'ENROLL#' + request_hash
    request = await get(auth_table, request_pk)
    at = int(time.time() * 1000)
    provider_key = text(request, 'providerKey') or ''
    if (text(request, 'requestId') != request_id or number(request, 'version') != 1
            or not provider_key.startswith('NATIVEAPPLE#') or len(provider_key) != len('NATIVEAPPLE#') + 64
            or any(c not in '0123456789abcdef' for c in provider_key[len('NATIVEAPPLE#'):])):
        # The request contains only a server-derived provider digest.
        raise ValueError('No valid server-verified enrollment request')
    index_pk = 'ENROLLIDENTITY#' + provider_key[len('NATIVEAPPLE#'):]
    index = await get(auth_table, index_pk)
    if text(index, 'requestId') != request_id or text(index, 'providerKey') != provider_key:
        raise ValueError('Enrollment index changed; no approval applied')
    username = 'native_' + provider_key[len('NATIVEAPPLE#'):]
    user_pk = 'NATIVEUSER#' + digest(username)
    if text(request, 'state') == 'approved':
        subject = text(request, 'subject')
        forward, reverse = await get(auth_table, provider_key), await get(auth_table, user_pk)
        grant = await get(session_table, 'USER#' + digest(subject or ''))
        if (not subject or any(text(row, 'subject') != subject or text(row, 'username') != username
                or text(row, 'providerKey') != provider_key or text(row, 'state') != 'active'
                or text(row, 'approvalRequestHash') != request_hash for row in [forward, reverse])
                or text(grant, 'subject') != subject or text(grant, 'state') != 'active'
                or text(grant, 'approvalRequestHash') != request_hash or 'lifecycleHold' in grant
                or number(grant, 'pilotExpiresAt') <= at):
            raise ValueError('Previously approved enrollment is no longer active; no renewal applied')
        return {'status': 'already_approved', 'pilotExpiresAt': number(grant, 'pilotExpiresAt'), 'extended': False}
    if (text(request, 'state') != 'pending' or text(index, 'state') != 'pending'
            or min(number(request, 'expiresAt'), number(index, 'expiresAt')) <= at):
        raise ValueError('Enrollment request expired or is not pending')
    if await get(auth_table, provider_key) or await get(auth_table, user_pk):
        raise ValueError('Existing identity mapping; no overwrite applied')
    if not execute:
        return {'status': 'review_required', 'requestId': request_id, 'approvalDays': days,
                'requestExpiresAt': number(request, 'expiresAt'), 'provisionsOrResumesAccount': True,
                'createsMappingsAndGrant': True, 'messagesSent': False}
    marker = 'bendbound-enrollment:' + request_hash
    async def read_user():
        try:
            return await aws('cognito-idp', 'AdminGetUser', {'UserPoolId': pool_id, 'Username': username})
        except Exception as error:
            if 'UserNotFoundException' not in str(error):
                raise
            return None
    user = await read_user()
    if user is None:
        try:
            await aws('cognito-idp', 'AdminCreateUser', {'UserPoolId': pool_id, 'Username': username,
                'MessageAction': 'SUPPRESS', 'TemporaryPassword': secrets.token_urlsafe(48) + 'aA1!',
                'UserAttributes': [{'Name': 'preferred_username', 'Value': marker}]})
        except Exception as error:
            if 'UsernameExistsException' not in str(error):
                raise
        user = await read_user()
    attrs = {item['Name']: item['Value'] for item in (user or {}).get('UserAttributes', [])}
    if (not user or user.get('Enabled') is not True or attrs.get('preferred_username') != marker
            or user.get('UserStatus') not in ['FORCE_CHANGE_PASSWORD', 'CONFIRMED'] or not attrs.get('sub')):
        raise ValueError('Existing Cognito account is not owned by this request; no linking/reset applied')
    if user['UserStatus'] == 'FORCE_CHANGE_PASSWORD':
        await aws('cognito-idp', 'AdminSetUserPassword', {'UserPoolId': pool_id, 'Username': username,
            'Permanent': True, 'Password': secrets.token_urlsafe(48) + 'aA1!'})
        user = await read_user()
        if not user or user.get('UserStatus') != 'CONFIRMED' or user.get('Enabled') is not True:
            raise ValueError('Cognito confirmation not complete; no approval applied')
        confirmed_attrs = {item['Name']: item['Value'] for item in user.get('UserAttributes', [])}
        if confirmed_attrs.get('sub') != attrs['sub'] or confirmed_attrs.get('preferred_username') != marker:
            raise ValueError('Cognito identity changed; no approval applied')
    subject = attrs['sub']
    grant_pk = 'USER#' + digest(subject)
    if await get(session_table, grant_pk):
        raise ValueError('Existing pilot record (possibly blocked/held); no overwrite applied')
    at = int(time.time() * 1000)
    deadline = at + days * 86400000
    def item(values):
        return {key: {'N': str(value)} if isinstance(value, int) else {'S': value} for key, value in values.items()}
    mapping = {'username': username, 'subject': subject, 'providerKey': provider_key,
               'state': 'active', 'approvalRequestHash': request_hash}
    writes = []
    for pk in [provider_key, user_pk]:
        writes.append({'Put': {'TableName': auth_table, 'Item': item({'pk': pk, **mapping}),
                               'ConditionExpression': 'attribute_not_exists(pk)'}})
    writes.append({'Put': {'TableName': session_table, 'Item': item({'pk': grant_pk, 'subject': subject,
        'state': 'active', 'pilotExpiresAt': deadline, 'approvalRequestHash': request_hash}),
        'ConditionExpression': 'attribute_not_exists(pk)'}})
    for pk in [request_pk, index_pk]:
        writes.append({'Update': {'TableName': auth_table, 'Key': {'pk': {'S': pk}},
            'UpdateExpression': 'SET #state = :approved, subject = :subject, approvedAt = :now',
            'ConditionExpression': '#state = :pending AND requestId = :request AND providerKey = :provider AND expiresAt > :now',
            'ExpressionAttributeNames': {'#state': 'state'},
            'ExpressionAttributeValues': {':approved': {'S': 'approved'}, ':pending': {'S': 'pending'},
                ':subject': {'S': subject}, ':request': {'S': request_id}, ':provider': {'S': provider_key}, ':now': {'N': str(at)}}}})
    # All five records commit together. Missing/held/blocked/conflicting records
    # can never be upgraded by this tool; ambiguous failures require review/retry.
    await aws('dynamodb', 'TransactWriteItems', {'TransactItems': writes, 'ClientRequestToken': secrets.token_hex(16)})
    return {'status': 'approved', 'pilotExpiresAt': deadline, 'messagesSent': False}
