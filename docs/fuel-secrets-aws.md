# Fuel Finder credentials in AWS

The production OAuth credentials are stored as one JSON secret named `bendbound/fuel-finder/oauth` in London (`eu-west-2`). Its two fields are `client_id` and `client_secret`. The values are not included in this repository or deployment records.

- Secret ARN: `arn:aws:secretsmanager:eu-west-2:843872332156:secret:bendbound/fuel-finder/oauth-IDM7OW`
- Active EC2 instance: `i-0c392dc16f7c9d857`
- Instance role: `bendbound-routing-catalogue-london-InstanceRole-oGELvTyfbW4H`
- Access-policy CloudFormation stack: `bendbound-fuel-finder-secret-access`
- Encryption: AWS-managed `aws/secretsmanager` key.

[Open the secret in AWS](https://eu-west-2.console.aws.amazon.com/secretsmanager/secret?name=bendbound%2Ffuel-finder%2Foauth&region=eu-west-2).

The [access template](../routing/ec2/fuel-secrets-access-template.json) attaches a separate inline policy to the existing EC2 role. It grants only `secretsmanager:GetSecretValue` on this exact secret ARN. It grants no secret writes, deletes, listing or access to other secrets. The secret was created separately from the access-policy stack; removing that stack revokes this grant without deleting the stored credentials. No custom KMS key, rotation Lambda, VPC endpoint or extra EC2 instance was created for this setup.

## Server usage

The deployed fuel-price service uses the AWS SDK's default credential provider and the EC2 role to call `GetSecretValue` with this ARN in `eu-west-2`, then parse the `SecretString` JSON in memory. Do not add static AWS credentials, secret values or OAuth tokens to app environment variables, Docker configuration, command arguments, logs or deployment files. Cache the secret in the server process rather than reading it for each Fuel Finder request.

The current Docker metadata isolation has not been changed. Verify the future service's runtime identity and secret access when deploying it; successful access from the EC2 host does not establish access from every container. Run the fuel service with an appropriately scoped runtime identity without exposing instance metadata to unrelated containers.

The local `.secrets.env` remains Git-ignored for development. Editing it does not automatically update the AWS secret. Update the two fields together through Secrets Manager when the Fuel Finder provider issues replacement credentials. Automatic credential rotation is not configured; generating replacement OAuth client credentials requires support from Fuel Finder.

## Verification

[routing/ec2/verify-fuel-secret.py](../routing/ec2/verify-fuel-secret.py) is an EC2-host diagnostic. It uses the installed Python AWS SDK, verifies the exact instance-role identity, reads the secret into memory and requests one Fuel Finder access token. Output contains only the caller ARN and success flags. It neither prints nor writes secrets or tokens. It is run via AWS MCP/SSM, with no credential values embedded in the SSM command.

The IAM template has a test that checks its exact resource and permitted action. Deployment verification is recorded in [fuel-secrets-deployment.json](../routing/ec2/fuel-secrets-deployment.json).

The POI backend is now implemented alongside this secret storage; see [deployment and operations](poi-service.md). Its app price endpoint and background polling follow the [saved Fuel Finder terms](legal/fuel-finder-access-terms.md) and [integration requirements](place-discovery.md).
