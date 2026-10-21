"""Run on EC2: verify instance-role secret access and Fuel Finder OAuth in memory."""
import json
import sys
import urllib.error
import urllib.request


def verify():
    import boto3
    from botocore.config import Config

    region = 'eu-west-2'
    config = Config(connect_timeout=5, read_timeout=20, retries={'max_attempts': 1})
    identity = boto3.client('sts', region_name=region, config=config).get_caller_identity()
    # Verify through the intended EC2 role, not a user's static credentials.
    expected_role = 'bendbound-routing-catalogue-london-InstanceRole-oGELvTyfbW4H'
    if ':assumed-role/' + expected_role + '/' not in identity['Arn']:
        raise RuntimeError('The caller is not the configured EC2 instance role.')
    response = boto3.client('secretsmanager', region_name=region, config=config).get_secret_value(
        SecretId='arn:aws:secretsmanager:eu-west-2:843872332156:secret:bendbound/fuel-finder/oauth-IDM7OW'
    )
    credentials = json.loads(response['SecretString'])
    if not all(isinstance(credentials.get(key), str) and credentials[key] for key in ['client_id', 'client_secret']):
        raise RuntimeError('The secret is missing required OAuth fields.')
    request = urllib.request.Request(
        'https://www.fuel-finder.service.gov.uk/api/v1/oauth/generate_access_token',
        data=json.dumps({'client_id': credentials['client_id'], 'client_secret': credentials['client_secret']}).encode(),
        headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
        method='POST',
    )
    # Reject redirects so credentials are sent only to the intended endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as result:
        auth = json.load(result)
    if auth.get('success') is False or not auth.get('data', {}).get('access_token'):
        raise RuntimeError('Fuel Finder did not return a usable access token.')
    # Never print or persist the secret, temporary AWS credentials or OAuth tokens.
    return {'callerArn': identity['Arn'], 'secretRead': True, 'oauthAuthenticated': True}


if __name__ == '__main__':
    try:
        print(json.dumps(verify()))
    except Exception as error:
        # Exception bodies may contain sensitive data; report type/status only.
        status = getattr(error, 'code', None)
        print(json.dumps({'verified': False, 'errorType': type(error).__name__, 'httpStatus': status}))
        sys.exit(1)
