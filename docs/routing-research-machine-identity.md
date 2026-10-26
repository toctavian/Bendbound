# Scheduled ratings identity

The 06:00 Mac job uses `bendbound-research`, a certificate-backed IAM Roles
Anywhere identity. Interactive agents retain `bendbound` and its existing normal
London browser flow: `aws login --profile bendbound --region eu-west-2`.
The shared Codex MCP configuration is not replaced or broadened.

## Architecture and permissions

The publisher starts the configured official AWS MCP proxy in a separate process,
with `AWS_MCP_PROXY_PROFILES=bendbound-research`. The AWS profile's
`credential_process` invokes the pinned official signing helper to obtain temporary
one-hour credentials. Reconnecting obtains fresh credentials without a browser.
No IAM user access keys or cached AWS session credentials are saved in the repository.

- IAM role: `bendbound-research-publisher` in account `843872332156`.
- Trust anchor/profile: `bendbound-research-mac`, London `eu-west-2`.
- Trust is limited to that anchor, account and certificate subject CN.
- S3 access: Get/Put/Delete only under the existing artifacts bucket's
  `route-research/` prefix, plus GetBucketLocation on that one bucket (required
  by the MCP signing tool). No bucket listing or other object prefixes.
- SSM SendCommand: only `Bendbound-PublishReviewedRatings` on
  `i-0c392dc16f7c9d857`. No general `AWS-RunShellScript` permission.
- The fixed command accepts base64 data, validates its fields, pins the graph and
  transfer URL prefix, then verifies the current overlay or runs the existing
  checksum/native-consumer/rollback/public-route-checked installer. It does not
  accept caller-supplied scripts or shell commands.
- `ssm:GetCommandInvocation` reads completion/output. AWS does not support an
  individual command ARN for this action, so its resource is `*`; this is broader
  than the tightly scoped command-execution permission.
- No IAM modification, Secrets Manager, resource provisioning or arbitrary shell
  permission. Publication still requires the locally reviewed immutable artifact.

Manual prompts do not select this identity by default. Setting
`BENDBOUND_RESEARCH_AWS_PROFILE=bendbound-research` selects it only for the
publisher's dedicated MCP subprocess. The LaunchAgent sets that variable.
Unattended credential failures retry fresh machine credentials and stop safely;
they never open a browser or silently escalate to `bendbound`. Administrative
repair/enrollment uses the manual profile and its normal authentication recovery.

## Certificate storage and renewal

Material lives outside Git under `~/.aws/bendbound-research` (directory 0700,
private keys 0600). The workload signing key is readable by this Mac user so a
scheduled process can authenticate without a prompt. The dedicated CA key is
AES-encrypted; its random password is stored in the macOS login Keychain. The
CA key/password are not used during normal morning jobs. The AWS helper binary
is pinned to version 1.8.5, verified against AWS's published arm64 checksum and
its macOS code signature. No AWS Private CA service is provisioned.

The workload certificate lasts one year; CA lasts ten years. This removes daily
browser renewal, not all lifecycle maintenance. Renew the workload certificate
before expiry; enrollment's local setup refuses a certificate with less than
30 days remaining. Mac compromise/user access still exposes the workload key;
revoke access by disabling the Roles Anywhere profile/trust anchor from a manual
admin session. Re-enroll a replacement certificate after compromise.

`routing/catalogue/research/identity/enroll.py` performs explicit administrative
enrollment through AWS MCP and records non-secret resource ARNs/expiry in
`~/.aws/bendbound-research/enrollment.json`. It preserves the existing manual AWS
profile and does not print private keys, temporary credentials or sign-in URLs.
The source does not itself establish a successful deployment: use the verification
checkpoint below and the local receipt for actual state.

## Verification checkpoint

Completed 22 October 2026, 11:24–11:26 BST. The Mac LaunchAgent is installed
for 06:00 Europe/London with the machine-profile environment variable. It was
re-registered without launching another research/reviewer run.

- Two distinct temporary credential sessions issued using the certificate, without
  browser login; actual MCP STS principal is the intended assumed publisher role.
- A small object was uploaded, downloaded, compared and deleted through the scoped
  MCP transfer path. The required GetBucketLocation permission was verified too.
- Fixed-document server verification succeeded, SSM
  `e9f2f6d5-2574-45b6-89e2-51fa889a9f64`.
- Full deterministic publisher no-change path succeeded using isolated local state,
  SSM `97afd142-d895-4ca0-a245-89967a483253`. Input/review hashes and the full
  immutable overlay were validated; the current live hash matched. No ratings
  changed and no API/engine restart was needed for these verification checks.
- Actual IAM role has no attached policies and only `RatingsPublicationOnly` inline.
  IAM simulation confirms generic shell execution, Secrets Manager reads and
  objects outside the transfer prefix are implicitly denied.
- 39 research/security tests passed; lint/typecheck and diff whitespace checks passed.
- Certificate expires 22 October 2027 at 10:15:05 UTC. Plan renewal by
  22 September 2027; enrollment refuses less than 30 days remaining.

Evidence: `routing/catalogue/ec2/research-identity.json` and the private local
`~/.aws/bendbound-research/{enrollment,verification}.json` receipts. Manual Codex
MCP configuration still exposes only `bendbound`. An enrollment subprocess
initially attempted browser recovery for an SSM document validation error;
remaining enrollment completed through the already-authenticated manual MCP.
The document's regex and Docker-template interpolation were corrected before
successful creation. Subsequent machine checks used no browser authentication.

To repeat the non-destructive live identity check:

```sh
BENDBOUND_RESEARCH_AWS_PROFILE=bendbound-research /opt/homebrew/bin/python3 routing/catalogue/research/identity/verify.py
```

To renew the certificate, stop the local LaunchAgent first, preserve the current
client certificate/key as a rollback pair, and issue a replacement with the same
CN using the dedicated encrypted CA and its Keychain password. The local
`identity/local_identity.py` setup can issue a new client pair when `client.pem`
is absent; keep `ca.pem` and the encrypted CA key intact. Run the live verifier
above with the replacement, then reinstall the schedule. If verification fails,
restore the original unexpired pair. Do not leave the scheduler disabled after a
successful renewal. Certificate rotation is an explicit maintenance task, not a
background researcher operation.

The Mac must still be awake/online, Codex signed in with allowance, and the
certificate valid. Research/review and per-road accounting rules are unchanged.
