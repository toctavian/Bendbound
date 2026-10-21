"""IAM-only pilot operator entrypoint. Never attach to API Gateway or an app role."""
import asyncio
import os
import re
import boto3
from src.nativeEnrollmentOperator import enroll


def handler(event, context):
    if (not isinstance(event, dict) or set(event) != {'requestId', 'days', 'approve'}
            or not isinstance(event['requestId'], str) or not re.fullmatch('[a-f0-9]{64}', event['requestId'])
            or type(event['days']) is not int or not 1 <= event['days'] <= 7 or type(event['approve']) is not bool):
        return {'status': 'not_applied', 'reason': 'INVALID_REQUEST'}
    clients = {}
    async def aws(*, service_name, operation_name, region_name, params):
        if service_name not in clients:
            clients[service_name] = boto3.client(service_name, region_name=region_name)
        operation = re.sub(r'(?<!^)(?=[A-Z])', '_', operation_name).lower()
        return getattr(clients[service_name], operation)(**params)
    try:
        return asyncio.run(enroll(aws, auth_table=os.environ['NATIVE_AUTH_TABLE_NAME'],
            session_table=os.environ['SESSION_TABLE_NAME'], pool_id=os.environ['COGNITO_USER_POOL_ID'],
            request_id=event['requestId'], days=event['days'], execute=event['approve']))
    except ValueError:
        return {'status': 'not_applied', 'reason': 'REQUEST_NOT_ELIGIBLE'}
    except Exception:
        # Keep provider metadata, passwords and SDK details out of operator logs.
        # An ambiguous commit is resolved by a read-only review/retry, never rollback.
        return {'status': 'unconfirmed', 'reason': 'OPERATOR_SERVICE_UNAVAILABLE_REVIEW_BEFORE_RETRY'}
    finally:
        for client in clients.values():
            client.close()
