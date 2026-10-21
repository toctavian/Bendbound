# Native Apple sign-in: implementation and delivery contract

Decision confirmed by Octavian on 2026-10-19: iOS uses the native Apple authorization
sheet (`expo-apple-authentication`), without a browser fallback. Cognito remains the
app-session issuer. The existing Cognito hosted federation deployment is retained;
it is not a native-token exchange and cannot by itself serve this flow.

## Implemented locally

- SDK57-compatible native module, config plugin and `ios.usesAppleSignIn`.
  Existing local iOS project has the entitlement and mixed-localization setting;
  CocoaPods installs `ExpoAppleAuthentication 57.0.2`. Native files are ignored by
  Git, so retain the plugin/config when regenerating them. A new signed build is required.
- Apple-provided Continue button, availability detection and normal cancellation.
  `src/services/auth/cognito.ts` now requests the native sheet with a server nonce
  and challenge ID as state. It never opens a browser for sign-in.
- `src/services/auth/nativeApple.ts` implements the HTTPS challenge/exchange client.
  Apple credentials stay in memory. It refuses redirects, wrong state, incomplete
  credentials and an exchange that returns the raw Apple identity token as access.
- A returned Cognito grant passes GetUser for display identity, then the existing
  protected session manager and server registration. Refresh rotation, durable
  logout, admission and server token verification remain required.
- `services/group-rides/src/nativeApple.mjs` verifies Apple JWTs using
  `aws-jwt-verify`, fixed issuer/JWKS, native bundle audience, nonce, freshness and
  optional code hash. Server-only code exchange signs short-lived ES256 client
  secrets, uses the native bundle ID (not web Services ID), and verifies the
  exchanged identity matches. Its internal transport captures provider refresh material; the journalled
  production wrapper never returns that material to the HTTP/session issuer.

## Bridge implementation and verified deployment

The server bridge now exists locally: `nativeAppleApi.mjs` (strict HTTP boundary),
`nativeAppleStore.mjs` (atomic challenges/proofs and operator mappings),
`nativeAppleVault.mjs` (KMS envelope encryption), `nativeAppleIssuer.mjs`
(Cognito custom-auth issuance), `nativeAppleTriggers.mjs` (challenge/scope triggers),
and the two Lambda entrypoints. Infrastructure: `infra/native-apple.template.json`;
identity template has an opt-in native trigger ARN parameter. No automatic account
creation or approval: pilot identities require operator-provisioned immutable
forward/reverse mappings plus an existing active expiring USER grant.

DynamoDB Local 3.3.1 checks pass: one winner among 20 concurrent challenge consumers,
restart persistence, logical TTL expiry, username/subject/nonce-bound proof use,
matching mapping rows and encrypted provider-token retention before issuance.
Synthetic AES encryption uses a mocked KMS wrapper; actual cloud IAM/KMS and Apple
credentials still require live proof. All test tables removed; emulator stopped.

`EXPO_PUBLIC_NATIVE_APPLE_API_URL` is configured in ignored local `.env`. Accounts
preview remains false. These routes belong to the isolated native auth API, never the session-only API. Do not point this
variable at Cognito or claim working native login from these local helpers.

Required wire contract (all responses `Cache-Control: no-store`):

1. `POST /v1/auth/apple/challenge`, body `{}` → `{challengeId, nonce}`. Both values
   are independent cryptographically random 32-byte lowercase hex strings. Store
   the nonce server-side against a short-lived challenge (suggested 5 minutes).
2. `POST /v1/auth/apple/exchange`, body `{challengeId, identityToken,
   authorizationCode}`. Atomically consume a live challenge **once**, including
   under concurrent requests. Resolve its server nonce; never accept a nonce or
   account ID supplied by the exchange caller. Verify/exchange with the local
   Apple module. Fail closed on signature, audience, nonce, code or subject mismatch.
3. Resolve an immutable Apple provider-subject → Cognito-subject mapping; never
   link by email. Existing federated users must have explicit migration/linking
   rules. Mapping lookup is implemented; operator provisioning/migration remains required.
4. Store Apple refresh material encrypted with tightly scoped vault/KMS access
   before issuing an app session; retain it for provider revocation/deletion.
   No plaintext provider tokens in ordinary DynamoDB rows, Cognito attributes,
   responses or logs. Use the journalled recovery flow described below for vault/issuance failures.
5. Use Cognito's supported custom challenge mechanism with a server-created,
   single-use short-lived proof to issue Cognito access/refresh tokens. Implement
   Define/Create/Verify triggers and a V2 pre-token trigger for `bendbound/groups`.
   Scope addition must be tied to trusted immutable provider mapping, including
   refresh; client metadata is not authority. Preserve `origin_jti`, `auth_time`,
   `aws.cognito.signin.user.admin`, five-minute access life, rotation and revocation.
   Implemented in the local triggers/issuer. This is custom application logic,
   **not** an existing native Apple federation API.
6. Check server-owned expiring pilot USER grants; absent/blocked/expired deny.
   No automatic pilot approval. Add throttling and durable budgets on both public
   auth routes, strict body limits, safe errors and no request-body/token logging.
7. Only then return `{accessToken, refreshToken, expiresIn}` (Cognito tokens,
   `expiresIn` 1–300 seconds). Never return Apple's refresh or identity token.

Deployed through AWS MCP on 2026-10-19: `bendbound-group-pilot-native-apple`
CREATE_COMPLETE and termination-protected; identity stack UPDATE_COMPLETE with
native Define/Create/Verify and V2 pre-token triggers. Public client allows custom
auth only, preserving revocation, rotation and five-minute access tokens. No
existing resource replaced. Native URL and artifact checksum are in the
[public deployment manifest](group-identity-deployment.json).

Live checks: challenge creation 200, invalid Apple/replayed challenge 401,
body identities/query credentials 400, all no-store. Original bridge/trigger Lambdas Active/Successful
with matching deployed artifact digest; auth TTL ENABLED; vault KMS key Enabled.
IAM simulation confirms mapping writes/decrypt denied for bridge, correct-context
data-key generation allowed, and secret reads denied for triggers. This is policy
simulation, not proof of real provider encryption/issuance or account deletion.
No testers, mappings, provider tokens or accounts created by this deployment. Retain the current Apple signing secret and deployed
session API; no need to recreate them. Do not expose partially wired triggers.
Verify replay/concurrency, pilot denial, cloud IAM and refresh/logout/provider
revocation before enabling a private signed test.
Then perform P01 on a physical iPhone, including Apple Hide My Email and deletion.

## Sources checked for this change

- [Expo SDK57 AppleAuthentication](https://docs.expo.dev/versions/v57.0.0/sdk/apple-authentication/)
- [Cognito custom authentication challenges](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-challenge.html)
- [Cognito pre-token generation trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html)
- [Cognito token refresh endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)
  permits API-issued refresh tokens when remembered devices are off; preserve this
  pool setting or switch refresh to the appropriate API.
- [Apple token validation/exchange](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)
- [AWS maintained JWT verifier](https://github.com/awslabs/aws-jwt-verify)

## Controlled tester enrollment

Enrollment and final operator outcome handling are deployed in the native stack
(UPDATE_COMPLETE). All three functions are Active/Successful with matching artifact
digests. Private missing-request smoke returns REQUEST_NOT_ELIGIBLE; public approval
URL returns 404. IAM simulation denies bridge/trigger invocation of the operator.
See the manifest/tracker for verified artifacts and evidence limits.
A missing native mapping now produces `403 PILOT_APPROVAL_REQUIRED` only after
Apple JWT/nonce verification. The server issues a random 64-hex reference against
a canonical 24-hour pending request; concurrent/repeated logins for the same
identity reuse it. It contains a provider digest, not the Apple subject, email,
tokens or coordinates. No Apple code exchange, account or access grant occurs.
Blocked/malformed existing mappings keep returning 401 and cannot re-enroll.
Pending references expire logically after 24 hours; DynamoDB TTL cleanup is
best-effort and is not proof of a physical 24-hour deletion guarantee.

The account panel shows the reference as selectable text. Copy it and explicitly
match it to the invited tester before approval. It identifies a request; it cannot
be used as an authentication token, room invite or approval capability.

The privileged approval path is a separate IAM-only Python3.13 Lambda, with no
API Gateway integration, function URL, or bridge/trigger invocation permission.
`scripts/group-pilot-enrollment.py` invokes it through the configured AWS MCP.
Python >=3.11 is required by the CLI. For example, from repo root:

```sh
# Read-only; inspect a reference supplied by the actual invited tester.
uv run --python 3.12 python scripts/group-pilot-enrollment.py --request <full-reference>
# Only after explicitly matching/approving that tester. Lifetime: 1–7 days.
uv run --python 3.12 python scripts/group-pilot-enrollment.py --request <full-reference> --days 1 --approve
```

The agent must not run `--approve` for an actual person without Octavian's explicit
tester approval. There is no hourly job, agent/model call or automatic enrollment.
No requests have been approved by this implementation session.

Operator behavior (`src/nativeEnrollmentOperator.py`):

- Review reads the verified request/index/mapping state without creating accounts.
- Execution creates or resumes a request-owned deterministic Cognito user. Messages
  are SUPPRESSED; passwords are random, unshared and generated inside Lambda.
  The client allows custom auth only. A pre-existing account without the matching
  request marker is never linked or reset. Email is never an identity key.
- Five records commit in one DynamoDB transaction: immutable forward/reverse
  mappings, a new active expiring USER grant, and approved request/index state.
  Existing USER rows are never overwritten, including blocked/held/expired ones.
  Request expiry and mapping conflicts are checked in that transaction.
- A retry acknowledges a matching still-active prior approval without extending
  it. Withdrawal or a lifecycle hold prevents this acknowledgement/renewal.
- A Cognito account may remain confirmed but unapproved if provisioning succeeds
  and the transaction fails. Review/retry conservatively; never automatically
  delete accounts, remove holds, overwrite mappings or widen admission to recover.
- Unexpected SDK errors report approval as **unconfirmed**; review before retrying.
  A definite validation conflict reports not_applied. Neither outcome removes holds
  or attempts an automatic rollback of a possibly committed approval.
- Neither approval nor review returns passwords, provider tokens or raw identity.
  Login still requires a fresh native Apple credential after approval.

AWS MCP's script sandbox blocks hashlib/secrets imports. For that reason the
cryptographic provisioning code runs inside the IAM-only Lambda; MCP performs
only its authenticated invocation. This is not a local SDK resource-operation
fallback. The Lambda uses the compatible runtime-provided Boto3 SDK; no Python
SDK dependency fragments are included in the archive.

Local evidence: native DynamoDB suite 5/5 and operator transaction suite 4/4 PASS,
including deduplication, read-only review, committed approval, retry without
extension, expiry rollback and concurrent hold preservation. Cognito is synthetic
in these suites. Live valid native enrollment/approval still needs an invited
user's signed-device interaction. Deployment status is in the manifest/tracker.

## Provider exchange recovery and private cleanup

Deployed on 2026-10-19, native stack UPDATE_COMPLETE, in
`appleGrantJournal.mjs`, `journalledAppleExchange.mjs`,
`appleProviderCleanup.mjs` and `appleProviderCleanupLambda.mjs`. All four Lambda artifact hashes match.
The private no-hold smoke returns unconfirmed/PENDING; public cleanup URL404,
no function URL, grant TTL enabled. IAM simulations with complete context confirm
bridge cannot decrypt/invoke cleanup; cleanup cannot write/delete USER, delete
Cognito users, generate data keys or invoke enrollment. These are policy simulations.
Pre-execution scans found zero legacy VAULT
records and zero native mappings. Detailed checks are in the manifest/tracker;
do not infer device/provider proof from them.

Before contacting Apple, prepare the signing credential and KMS data key, then
transactionally record an exchange intent against the currently active pilot USER.
The transaction rejects an existing lifecycle hold. A separate retained composite-key
Apple grant table stores each attempt under a hashed Cognito subject and random ID.
A returned refresh token is encrypted/captured before validating the exchanged ID
or issuing Cognito credentials. Downstream issuance failure retains the saved grant.
No plaintext credentials, raw Apple subjects or request bodies are logged/stored.

If capture/validation fails after a token was returned, attempt immediate Apple
revocation. Only HTTP200 confirms revocation, including previously invalid tokens;
400, throttling, server errors and timeouts do not. On failed compensation, retry
saving the encrypted envelope. The original intent remains even if persistence is
unavailable. An exchange whose response was lost remains `uncertain`; a successful
response with captured credentials remains `captured`/`validated`. Those records
have no TTL. Definite no-grant rejection or confirmed revocation closes the record,
removes its encrypted credential and gives only that closed metadata a seven-day TTL.
A lost intent-write response can conservatively leave an intent even if no Apple
call occurred. Never treat such an intent as proof that a token exists or was revoked.

The IAM-only provider worker has no API Gateway route, function URL or permission
for app roles to invoke it. Trusted lifecycle orchestration supplies
`{subject, eventId, holdStartedAt, cursor?}` from the original permanent USER hold.
It checks that hold before/after work, reads at most three grants, decrypts and
revokes captured tokens, then transactionally deletes each row against the unchanged
hold and journal revision. Unknown attempts remain pending. Cleanup rechecks the
partition from its beginning before reporting `providerTokensDrained`; a forged or
terminal cursor cannot manufacture completion. Deletion of a journal row cannot
resurrect it through a delayed capture update. Worker retries must follow the cursor,
then restart scanning pending work. The account deletion pipeline now embeds this
primitive; its pagination/backoff fix is deployed and verified. Follow the tracker
for the remaining signed-device acceptance steps.

The bridge may generate data keys and write journal entries, but cannot decrypt.
The worker may decrypt, read the signing secret, query/delete journal entries and
condition-check the permanent USER hold. It cannot write USER grants, release a
hold, invoke enrollment, or delete Cognito accounts. Apple is an external side
effect: a DynamoDB hold cannot atomically fence the remote revoke call. Rechecks
and transactional acknowledgement prevent a changed hold from acknowledging cleanup.

This primitive **does not delete an account**, purge app data, process Apple
notifications, start/release a hold or acknowledge lifecycle completion. The separate
account deletion pipeline now implements intake, queued purge and receipts; the app
UI is local and signed-device proof remains pending. The old auth-table VAULT
scheme has no automatic migration: verify zero legacy records immediately before
rollout, or implement/verify migration first.

Apple's [token revocation documentation](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens)
requires the provider token. [TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)
explains the missing-token fallback: fulfill deletion of the app's own account/data
and direct the user to manual Apple authorization revocation when programmatic
revocation cannot be done. A lost response cannot be reconstructed automatically.
Keep provider uncertainty separate from app-data deletion; never claim Apple
revocation or delay own-data deletion indefinitely because a token is unavailable.

Local evidence: backend 2198/2198 PASS, focused native/bridge/infrastructure 13/13,
and native/recovery DynamoDB integration 9/9 PASS. Real DB map reordering exposed
and verified a fix to canonical envelope digest/AAD context comparison. Tests cover
late capture, no resurrection, held exchange denial, lost response, compensating
revocation, forged cleanup cursor, decrypt tampering, failed revoke retention and
replacement-hold fencing. KMS and Apple are synthetic in those database tests.
Independent ListTables confirmed zero test tables and the emulator was stopped.

## Next: complete lifecycle and signed device proof

The account deletion pipeline and embedded room/point coordinator are now deployed.
Atomic intake, receipts, durable retries, account/Cognito purge and independent Apple
cleanup are described in [the deletion runbook](group-account-deletion.md). The app
UI is implemented locally. Real user deletion and provider-driven notifications remain
unproved/incomplete; the tracker names the remaining operational limits.

Then prove native signed login → Apple exchange → actual KMS-encrypted durable
journal write → Cognito issuance/GetUser → session activation, rotation and logout,
plus account deletion/provider revocation. A real invited tester and signed iPhone
build are required; public accounts remain disabled. No real enrollment, Apple grant
write, revocation or account deletion has yet been proved in AWS.
