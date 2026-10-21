# Group account prototype: setup and remaining gates

This documents P01. Cognito and its Apple provider are deployed; the initial
authorization redirect reaches Apple. End-to-end user/native login, revocation,
deletion and group-sharing acceptance remain pending.
Follow [the tracker](group-rides-implementation.md) and
[protocol draft](group-rides-protocol.md) before continuing.

## Implemented architecture

**Updated decision (2026-10-19): native Apple authorization sheet, confirmed by
Octavian.** The app now calls `expo-apple-authentication` and uses Apple's button.
See [the implementation and remaining bridge contract](group-native-apple.md).
The deployed Cognito hosted federation remains configured, but is no longer the
chosen iOS sign-in UI. Its redirect checks below are historical deployment facts.

A native Apple credential must be verified/exchanged by our server before Cognito
issues an app session. Local native client and Apple verification/code-exchange
helpers exist. The durable bridge, encrypted provider vault and Cognito custom-auth triggers
are now deployed (see manifest). Native endpoint is configured locally; preview
remains false. Controlled tester enrollment is implemented with operator-only approval (see
[native delivery contract](group-native-apple.md)). Provider lifecycle recovery and
real signed login/refresh/logout/deletion proof remain pending.

Initial display identity now comes from Cognito GetUser. Only refresh material,
provider/client binding and display metadata persist in SecureStore; access tokens
stay in memory. Display metadata is not authorisation proof. Rotated credentials
are saved before use. Keychain access is device-only after first unlock; physical
screen-lock behaviour still needs proof in a rebuilt signed app.

Session activation registers a verified family with the group backend. Logout
invalidates in-flight sign-in/refresh, clears local credentials and attempts both
backend family revocation and provider revocation. It reports remote failure
honestly. Durable protected pending intent and revocation-only capability retry
now exist locally; see [sign-out recovery](group-account-logout.md). Pending records
never refresh or activate. Socket/native sharing teardown and live provider/device
proof remain pending before release.

## Existing hosted configuration and remaining work

These completed steps describe the deployed hosted foundation. Implement the
[native bridge](group-native-apple.md) before the signed-device step below.

Use authorised AWS MCP tools for resource operations under repository instructions.
AWS MCP access is restored. The London identity foundation is now deployed:
see [verified identifiers](group-identity-deployment.json). The session API and
Apple provider are configured; signed login and deletion/device proofs remain
pending. Room/location APIs are not deployed.

1. Identity foundation DONE (2026-10-19): CloudFormation
   `bendbound-group-pilot-identity`, public code-flow client, `bendbound/groups`,
   five-minute access/ID tokens, 30-day refresh lifetime with rotation and 5-second
   grace, revocation enabled, no client secret, admin-only native sign-up.
   Essentials is required: the live service rejected rotation on Lite. The retained
   empty pool was imported after rollback and the corrected stack is UPDATE_COMPLETE.
   Domain uses classic hosted UI (version 1), supported with Essentials. Apple is
   now the supported identity provider; no app preview or user admission enabled.
2. Apple configuration DONE (2026-10-19): App ID/capability, Services ID and exact Cognito
   `/oauth2/idpresponse` return URL. Supply Apple private key via appropriate protected
   provider configuration; no private key in app configuration or version control.
3. Client configuration DONE: Apple provider on a **public client without a client secret**, OAuth code
   flow, `openid`, `profile`, `email`, and custom resource-server scope
   `bendbound/groups` and `aws.cognito.signin.user.admin` (needed for the server
   GetUser revocation probe; this is a user-scoped OAuth permission, not IAM
   administrator access). Configure exact callback `bendbound://auth/callback`.
4. Rotation configuration DONE: five-minute access/ID lifetime, 30-day refresh
   lifetime and five-second refresh grace. Live refresh behaviour remains unproved. The registry binds lease expiry to signed `auth_time` plus 30 days,
   so repeated registration/TTL deletion cannot extend the family. Verify
   `origin_jti` and `auth_time` support.
5. Public configuration DONE in ignored local `.env`, using
   `.env.example`, including the separate HTTPS `EXPO_PUBLIC_GROUP_API_URL`. Keep `EXPO_PUBLIC_ACCOUNTS_PREVIEW=false` for release builds;
   turn it on only for the private prototype when configuration is actually ready.
6. Build a signed native development app with current plugins and test Apple Share
   My Email/Hide My Email, cancellation, state mismatch, expiry, refresh/restart,
   logout offline/online and locked-screen credential access. Exporting JS does not
   prove a native build or successful Apple login.
7. Session API provisioned; complete authenticated live validation using the
   deployed stack below. Registration verifies the access JWT and probes Cognito GetUser
   before a conditional transaction. Existing revoked/blocked/expired records cannot
   be renewed, including after TTL cleanup. HTTP room/latest-point handlers now exist locally and use the registry too;
   deployment and socket fan-out remain pending. See the separate
   [room deployment preparation](group-rides-deployment.md).
8. Complete account deletion and Apple token revocation before enabling public
   accounts. **Open integration issue:** Cognito federation does not hand the Apple
   refresh token to this app. Establish and prove a supported reauthentication/
   provider-revocation flow; do not pass a Cognito token to Apple's revoke endpoint
   or claim Cognito user deletion revokes Apple authorisation.

## Checks

From the app root: `npm run lint`, `npm run typecheck`, `npm test`.
From the app root for server verifier tests:
`npm ci --prefix services/group-rides`, then `npm test --prefix services/group-rides`.

Local tests use synthetic signed JWTs, mock OAuth/native storage and synthetic GPS
samples. They are not provider or physical-device evidence. Session HTTP handlers and DynamoDB adapter now exist locally; live provider/DB
validation, deployment of private room handlers, native capture registration for sharing, group
UI, bike markers and deployment remain subsequent work. The existing recorder is unchanged.

## Session API deployment (private pilot, authenticated acceptance pending)

- Entry point: `services/group-rides/src/sessionLambda.mjs`.
- Infrastructure: `services/group-rides/infra/sessions.template.json`, targeting
  London and requiring existing Cognito pool/client identifiers.
- Build locally: `npm run package:lambda --prefix services/group-rides`.
  Output `services/group-rides/.artifacts/sessions.zip` is Git-ignored. The script
  allowlists src, package manifest and installed runtime dependencies; it excludes
  app data, env files, tests and rejects secret-file names/symlinks.
- Schema check: `uv tool run --from cfn-lint cfn-lint
  services/group-rides/infra/sessions.template.json` (one shell command).
- Deployed through AWS MCP as `bendbound-group-pilot-sessions`; exact URL,
  function and table identifiers are in the deployment manifest. Uploaded archive
  checksum matches the active Lambda. Future changes must use reviewed stack
  updates and immutable artifact keys; no CLI resource workaround.
- Template provides an encrypted pay-per-request session table with TTL, limited
  Lambda concurrency and API throttling, least-privilege table/log access and
  seven-day runtime log retention. No body/header access logging is enabled.
  The table is retained on stack deletion so revocation records are not discarded
  accidentally; decommissioning must explicitly consider remaining token lifetimes.
- Routes: POST/GET/DELETE `/v1/session`. Lambda performs all token/registry checks.
  These routes accept no query tokens or body identity. Bootstrap now requires a
  logoutSecret body field; POST `/v1/session/logout` accepts that revoke-only secret
  even after access-token expiry. Both templates include its scoped route/permission. There is no general group
  API, group location storage or WebSocket deployment in this stack yet.
- Pilot throttling is a basic cost bound, not complete account/IP abuse protection.
  The preview flag is UI gating only. Backend pilot admission now requires an
  operator-owned matching USER grant with active state and future pilotExpiresAt;
  see [pilot admission](group-pilot-admission.md). No grants are assigned locally.
  Complete onboarding and edge/per-user abuse controls before configured builds.
- Live tests required: provider-revoked tokens, concurrent logout/registration,
  Dynamo conditional/TTL behaviours, blocked user, wrong client/type/scope, short
  expiry and replay after revocation. Test the actual Lambda role, not admin keys.

## Revocation and privacy limits still open

A successful local registry revoke blocks future private authorisation immediately.
It does not recall an in-flight response, terminate a socket not yet implemented,
or revoke Apple authorisation. Offline/expired-token logout now has a protected
pending record and hash-bound revocation-only capability, implemented locally.
Configuration migration, legacy missing-proof records, abuse controls and real
provider/device validation still need work; the UI reports pending work honestly.
Session records contain only pseudonymous subject, hashed family/user keys, status
and timing; no refresh/access tokens, email or coordinates. Tombstones/leases last
at most the configured refresh lifetime plus cleanup delay. Provider user blocking
fails closed while its tombstone remains; TTL is not immediate physical erasure.
Document this security retention and deletion policy before wider release.

Provider/transaction references: [Cognito GetUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_GetUser.html), [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

## Server pilot gate - 2026-10-15

Pilot access now defaults to denied even for a valid Cognito user. An active,
unexpired USER approval must exist in the shared session table; only a trusted
operator/lifecycle context can write it. Session runtime writes are restricted
to family/capability keys, and room runtime cannot modify approvals. Registration,
room mutation and point-write transactions check live approval; snapshots check
both viewer and source. Logout remains available after withdrawal. See
[operator contract and remaining release gates](group-pilot-admission.md).
No account was approved or deployed during this work.


## Immediate Apple portal handoff — 2026-10-19

The existing app configuration identifies team `U5CJCX8BV2` and bundle/App ID
`com.octavian.bendbound`. These still need verification in the actual developer
account; portal login alone does not establish a Services ID or signing key.

1. In Apple Developer → Certificates, Identifiers & Profiles → Identifiers,
   select that App ID and confirm Sign in with Apple is enabled as a primary app.
2. Check for an existing associated Services ID. If absent, register one (suggested
   identifier `com.octavian.bendbound.signin`, subject to availability) and enable
   Sign in with Apple for the primary app. Use this exact domain (no scheme/path):
   `bendbound-group-pilot-843872332156.auth.eu-west-2.amazoncognito.com`.
   Return URL:
   `https://bendbound-group-pilot-843872332156.auth.eu-west-2.amazoncognito.com/oauth2/idpresponse`.
3. Confirm/create an associated Sign in with Apple signing key and note its Key ID.
   Keep the private key protected; do not paste its contents into chat or commit it.
   Provider integration must use protected server-side material. Public Team ID,
   Services ID and Key ID can be supplied separately for configuration.

Follow [Apple's Services ID instructions](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web)
and [key instructions](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key/).
After Apple registration, add the Apple provider and update the CloudFormation
client's SupportedIdentityProviders; do not leave an unrecorded manual client drift.
The original native callback remains `bendbound://auth/callback`; Apple returns to
Cognito first. Apple deletion/revocation, native signing and pilot admission gates
remain open.

Actual London Lambda capacity is now 1000, clearing the earlier capacity block;
the separate request for 1001 still shows CASE_OPENED. Keep the per-function caps.
A private, encrypted, versioned S3 artifact bucket is deployed and the rebuilt
Lambda archive uploaded under a content-hash key with verified SHA256 checksum.
See the deployment manifest for exact resource identifiers and current API status.


## Verified Apple configuration — 2026-10-19

Services ID `com.octavian.bendbound.signin`, Team ID `U5CJCX8BV2`, Key ID
`VQSL8P2SUR`. Validated the local P-256 key without printing it and stored its JSON
`private_key` field in Secrets Manager `bendbound/groups/apple-sign-in`. The
CloudFormation Apple provider uses a versionless secret dynamic reference; private
key contents are not in the repository/template. A temporary encrypted private S3
transfer was removed by exact version ID and ListObjectVersions confirmed no
versions/delete markers remained. Original Desktop download remains local (0600).

Live DescribeIdentityProvider/DescribeUserPoolClient confirmed SignInWithApple,
`email name` provider scopes and expected IDs; client supports Apple only and keeps
revocation/rotation. Cognito authorization with PKCE returned 302 to Apple with the
exact Services ID/return URL, and Apple sign-in page returned HTTP200. This does
not prove a completed Apple authentication, JWT issuance or native callback.
The deletion/reauthentication integration issue above remains open. Key rotation
must update the secret and the provider through a reviewed stack operation;
changing the secret alone does not force CloudFormation to refresh the IdP.


## Session API live baseline — 2026-10-19

Stack UPDATE_COMPLETE, Node22 Lambda Active/Successful, five reserved executions,
20-second timeout, session TTL ENABLED. GET without/with invalid bearer returns
401; query credentials and malformed logout capability return 400; all no-store.
IAM policy simulation of the real role denies USER writes and Apple-key reads,
permits SESSION writes with required leading-key context, and denies writes
without that context. This does not establish real authenticated lifecycle/race
behaviour under the execution role. No user grants or rider data were created.

Both session and room stages now wait for SessionLogoutRoute before applying its
route-specific throttle. This fixes a reproduced CloudFormation 404 during initial
session deployment. The retained session table was imported/preserved, and TTL was
explicitly enabled after rollback. The room stack is still undeployed.

Public prototype configuration is in ignored `.env`; accounts preview remains
false. The current group API URL points to the session-only API, which has no
room/location routes. Plan endpoint migration before room sharing. Completing a
signed native login and the Apple deletion path are the next P01 requirements.
