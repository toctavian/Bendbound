# Private-pilot account deletion

Implemented/deployed on 2026-10-19. This is not signed-device acceptance or a
production release approval. Exact resources/artifacts/checks are in
[group-identity-deployment.json](group-identity-deployment.json).

## Request, receipt and access denial

`POST /v1/account/deletion` requires a verified Cognito access JWT for this app,
`bendbound/groups`, recent authentication (within ten minutes), and a successful
provider GetUser check matching the verified sub. The body contains only a random
32-byte lowercase-hex `receiptSecret`. No body identity, email linking, cookies or
query credentials. The app saves this receipt in device-only SecureStore before
sending, bound to the account and service. Account switches across asynchronous
work deny dispatch; an accepted deletion does not sign out a different account.

One DynamoDB transaction replaces the matching USER grant with a permanent lifecycle
hold and creates a queued deletion job. Neither a response loss nor a crash can
leave a successful hold without its queued job. Same-receipt retry recovers the
existing job; another receipt cannot overwrite the hold. The private privileged
intake role can write USER holds; normal session/bridge roles still cannot approve
users. Code enforces blocked-only replacement and cannot create a missing USER.

The hold immediately denies registration, refresh-trigger admission and live group
access, regardless of any old signed token. The app signs out after acceptance.
Ordinary offline planning, saved tours, local recordings and settings are untouched.

`POST /v1/account/deletion/status` uses only the protected receipt. It remains usable
after Cognito removal and returns no account identity, job cursor, tokens or locations.
Unknown receipts return 404; all responses are no-store. Both routes have shared
atomic global/per-source budgets, body limits and gateway throttles. Keep the app
installed until its receipt is resolved. An unconfirmed request can be retried with
the same receipt after checking status; never erase a pending receipt to retry.

## Bounded worker and honest completion

A one-minute schedule queries a due-work index. One job/phase per invocation;
revision/lease and original hold checks guard durable changes. Leases last 55 seconds;
the Lambda is capped at 60 seconds with reserved concurrency one. Crashes recover
from persisted state. Repeated failures back off, pause after eight failures and
emit a generic operator metric/alarm, with no identity/coordinate/token logging.

Phases: room/member/own-point traversal; session/logout records; native mappings,
proofs and approved enrollment records; Cognito removal by immutable local-user sub;
six-minute settling window; repeat session/native purge; independently scan both
account tables to verify no matching records; then Apple cleanup. The settling
window assumes the deployed five-minute access tokens and bounded auth/session
Lambda runtimes; do not extend either without updating/proving this protection.
Cognito absence is checked after deletion. A lost deletion response is retried
idempotently, never treated as proof. These local-user semantics follow
[AWS AdminDeleteUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminDeleteUser.html).

Room traversal uses the original hold-bound persistent page/lease coordinator.
Other members/points survive, ownership transfers if needed, and orphan own points
are included. A terminal traversal is not itself account completion. Normal sources
cannot publish/add membership after the hold because their transactions check USER.
Unknown data shapes (including legacy provider VAULT material) stop erasure for
operator reconciliation rather than discarding unrevoked credentials.

Own profile/session/native account data and Cognito removal advance independently
of Apple outages or missing tokens. `appDataDeleted` describes these records and
shared map data, excluding the minimal suppression/recovery records below. Only
`complete` also confirms the stored provider-token ledger drained. Uncertain Apple
exchanges report manual authorization action; the app directs removal of Bendbound
from Sign in with Apple settings. No false provider revocation is claimed. See
[Apple recovery details](group-native-apple.md) and Apple's linked TN3194.

## Retained records and operational limits

- Permanent minimal USER deny/hold: pseudonymous Cognito sub, hash key and hold binding.
  This prevents old grants/retries being revived; no rider location or profile.
- Deletion receipt/job and progress: recovery/status metadata; completed, provider-drained
  jobs receive seven-day DynamoDB TTL. TTL is best-effort, not physical deletion proof.
  Progress currently has no TTL. A physical metadata-retention sweeper and agreed
  retention limits remain release work; do not promise exact seven-day physical purge.
- Uncertain provider attempts/encrypted unreconciled grants: no TTL until resolved.
  Apple notifications/manual recovery and a bounded escalation/retention policy remain
  required before general release. Do not keep own-data deletion waiting for them.

The CloudWatch operator alarm currently has no notification destination. Operator
ownership, escalation, retry/resume tooling and heartbeat/retention monitoring need
completion before broader accounts. Do not release holds, renew pilot grants or
manually delete recovery records to make a job appear complete. Inspect the existing
hold, job revision, phase and provider result without dumping credentials or points.

The separate room stack is deployed with `EnableServices=false`: only storage exists.
No group room/location API, public discovery or WebSocket service is enabled. Do not
change this flag before P01/P02 acceptance and real runtime/IAM checks.

## Actual evidence and next live step

Real DynamoDB tests: atomic hold/outbox, lost-response retry, wrong-receipt conflict,
access denial, room/orphan/account purge with peer preservation, immutable Cognito sub
usage, provider uncertainty independent of own data and replacement-hold denial.
Cognito/Apple are synthetic there. A local regression also verifies traversing
past uncertain provider pages, restarting failed passes and accumulating failures
across pages. That final fix is deployed with verified function hashes; see the
tracker/manifest for artifacts and signed-device acceptance limits. Live cloud checks prove denial routes, no-store,
actual empty-queue read and deployed artifact hashes. IAM simulations prove worker
cannot write USER/approve mappings/delete another pool; public intake cannot delete
Cognito or decrypt. They do not prove actual provider revocation or valid user deletion.

EAS project: https://expo.dev/accounts/toctavian/projects/bendbound . `group-pilot`
profile enables accounts only for the private build, using public deployed endpoints.
Default local preview remains off. Credentials/backend files are excluded by
`.easignore`; the inspected archive has no key/env/server files.

Octavian completed distribution signing and registered one iPhone. The signed
internal pilot build **1.1.0 (8)** finished successfully on 2026-10-19:
https://expo.dev/accounts/toctavian/projects/bendbound/builds/810cb2bb-d3f7-4459-9813-54c804451c53

The downloaded IPA passed deep/strict signature verification, expected bundle and
application identity checks, and native Apple sign-in entitlement verification.
The provisioning profile contains one registered device. Dependency installation,
SDK compatibility, lint/typecheck, app240/240 and iOS/Hermes export checks passed.
No actual device login or account deletion has been verified yet.

Code-signing certificates/profiles are separate from the Sign in with Apple `.p8`
key; do not upload that provider key as a distribution credential. Never record
passwords, 2FA, device identifiers or signing material in the tracker/chat. The CLI
also flagged missing export-compliance declaration (`ITSAppUsesNonExemptEncryption`);
resolve the correct declaration during release setup rather than inventing legal approval.

Install from the page above on the registered iPhone. Open Profile → Group ride
account → Continue with Apple and obtain the pending pilot reference. Agent reviews
that actual reference read-only; Octavian explicitly approves that real tester;
then retry sign-in and prove login/refresh/logout. Actual self-deletion needs the
user's explicit confirmation. No tester approval or real account removal has occurred.
One phone suffices for these P01 account tests; a second real device/tester is still
needed for simultaneous two-iPhone P02/P04 sharing and background reliability proof.
