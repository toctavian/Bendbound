# Durable account sign-out prototype

Implemented locally on 2026-10-15 for A03/A04/A05. This is not a deployed or
physical-device-validated login system. Follow
[the implementation tracker](group-rides-implementation.md) and
[deployment preparation](group-rides-deployment.md).

## Client intent and recovery

Each new login generates 32 native random bytes with Expo Crypto's asynchronous
API and hex-encodes them as a 64-character logout secret. It is saved alongside
the refresh credential before backend activation. Refresh retries reuse the same
secret; a new login gets another. No access token is persisted.

Sign-out invalidates pending login/refresh operations and immediately removes the
in-memory account. Before network work, it replaces the same SecureStore key with:

```
{ version: 2, kind: 'logout', binding, refreshToken, logoutSecret }
```

The example is a field schema, not real credential data. Binding includes the
issuer, public client ID and canonical group API base URL. The record contains no
profile, coordinates or persistent access token. It is protected using the same
existing device-only keychain policy; settings/recording databases are unchanged.

A pending record can only be used for revocation. Restore never refreshes it,
registers a session or publishes an account. Launch/foreground recovery retries
pending work, and Profile offers Retry sign-out. There is no periodic/background
retry timer or coordinate queue. Concurrent retries are coalesced. New sign-in is
blocked until pending work completes; a mismatched configuration remains pending
and is not sent to the replacement server.

Backend and Cognito revocation are attempted independently. Both must confirm
before the protected record is deleted. Errors, unconfirmed responses and delete
failures retain pending state. Backend requests (including response decoding) and
provider revocation have explicit ten-second deadlines with abort. If a late
refresh finishes after logout, its rotated refresh credential becomes pending
revocation only. An older successful attempt cannot erase that newer record.

A failed write of pending intent is reported as incomplete; retry before closing
the app. Code cannot promise restart durability if protected storage refuses the
write. A lost/corrupt/uninstalled keychain cannot recreate a revocation secret.
A binding change needs an explicit old-configuration cleanup/migration workflow;
retained work must not silently be dropped. Legacy records without a logout secret
can use the existing signed DELETE while access proof is available, but cannot
complete capability-based retry after that proof expires. No live account rollout
has occurred; migration must be settled before distributing configured builds.

## Backend capability contract

POST `/v1/session` now requires exactly `{logoutSecret}` in its body as well as
the verified individual access bearer. The Cognito GetUser probe and existing
issuer/client/purpose/signature/scope/expiry checks still apply. Client body
identity is never accepted. Registration atomically checks account status and
creates/binds a session-family row plus a LOGOUT row keyed by a SHA-256 hash of the
secret. The raw secret never enters DynamoDB, responses or application logs.

A family can bind one logout key. A secret cannot be rebound to another family or
subject. Idempotent refresh registration does not extend the original
`auth_time + maxSessionMs` deadline or revive a revoked/blocked/expired family.
Old metadata without a key may attach one while its family is still active.

POST `/v1/session/logout` accepts exactly `{logoutSecret}`, with no bearer required.
The secret authorises revocation of its mapped family only: it grants no identity,
snapshot, membership, login or location-publication access. Query credentials,
extra fields, short/non-hex secrets and oversized bodies are rejected. Responses
are no-store and return only `{revoked: true}` on success. Raw storage failures are
sanitised. GET and signed DELETE `/v1/session` retain their existing semantics.

Revocation atomically tombstones the capability and its family. Unknown secrets
also get a tombstone, preventing logout-before-registration from being undone by
a delayed registration. Unknown tombstones last at most the configured maximum
session lifetime plus the accepted one-second authentication-clock tolerance;
known-capability TTL follows the original family deadline. Replays of a still
stored revoked capability acknowledge it without extending that row's lifetime.
Expired capability revocation can safely succeed if TTL already removed the
expired family. Tombstone physical deletion is asynchronous; authorisation checks
logical expiry/state independently.

The session role already has the required item actions; no IAM expansion or new
server signing secret is needed. Both prepared APIs forward the new POST path to
the session handler with path/method-scoped Lambda permission. Its route throttle
is 1 request/second, burst 2; clients retain pending work on throttling.

## Remaining gates

This endpoint uses a high-entropy bearer capability rather than user login. Unknown
secret tombstones allocate rows, so aggregate route throttling is not a complete
abuse/admission policy. Complete pilot admission and appropriate edge/per-source
abuse controls, verify quotas/cost bounds and monitor actual behaviour before
exposing configured builds. The account preview flag does not protect a backend.
Neither API template has been deployed in this project.

Deploy the updated session handler/routes before testing the updated client: an
older session handler rejects the new bootstrap body. Keep preview disabled.
Check actual Lambda-role transactions, concurrent registration/revocation, TTL
cleanup, metrics and response redaction. Native iOS export proves bundling only.
Physical-device tests must cover offline logout, process death at each persistence
boundary, keychain failure/lock/restart, refresh rotation and both partial-failure
orders. Verify Cognito's origin_jti and rotation behaviour with the chosen client;
synthetic JWTs do not establish provider-family semantics or eliminate every
provider-side crash window. See [Cognito refresh rotation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html)
and [its revocation endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/revocation-endpoint.html).

Backend revocation logically denies private reads/writes immediately. It does not
yet physically erase every point for that account across rooms, shut down future
native sharing consumers/sockets, revoke Apple authorisation or delete an account.
Those remain A05/A06/B07/M01 work. Existing worker expiry is still the point purge
fallback, with the cloud retention limit unproven.
