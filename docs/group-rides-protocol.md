# Group rides protocol v1 (implementation draft)

Tracked by P03 in [the implementation tracker](group-rides-implementation.md).
Types: `src/types/groupRide.ts`. Client validation/freshness:
`src/utils/groups/location.ts`. Latest-only upload transport:
`src/services/groupUpload.ts`. These modules and the session API/DynamoDB adapter are implemented locally;
Room metadata endpoints/service and revision-conditional persistence now exist
locally; latest-point writes, atomic snapshots and cleanup now also exist locally.
WebSocket fan-out, infrastructure and device integration remain pending.

## Account boundary

Every private request uses an individual Cognito **access** token, with the
`bendbound/groups` scope. The server validates issuer/client/token purpose,
signature/expiry and a live session-family registry (`origin_jti`).
`services/group-rides/src/authorizer.mjs` implements this boundary with
`aws-jwt-verify`. It requires an injected live registry and denies access if the
registry rejects a session or is unavailable. No session infrastructure is
deployed yet. A real DynamoDB adapter and POST/GET/DELETE session Lambda now
exist locally; do not replace the required registry callback with `() => true`
outside tests.

Token verifier timing (2026-10-18, local A02/T01 increment): after awaited
maintained JWT verification, the direct verifier samples the clock exactly once.
It requires a finite clock and finite millisecond conversions of numeric expiry
and authentication-time claims. Exact expiry is denied; authentication time may
be at most one second ahead of that same sample. This also applies to bootstrap
callers that use the verifier without the live-session authorizer. Scope,
signature/provider checks and caller-side session/pilot gates remain required.
This local timing check does not establish commit-time expiry or deployment proof.

Authorization expiry checks (2026-10-18, local A02/A04/T01 increment): the session
registry rechecks access-token, family and pilot-admission deadlines with one
finite clock sample after both consistent reads. Exact expiry denies access;
lifecycle holds and revocation still deny access. The account authorizer also
rechecks token expiry after its awaited registry callback, including callbacks
implemented by other adapters. Invalid nonfinite clock values fail closed at
these boundaries. This does not establish expiry enforcement during subsequent
request processing or database commit, nor atomic revocation across the two reads;
private mutations and deliveries still require their own live security checks.
Deterministic local tests do not substitute for deployed/provider/device evidence.

Stored family deadlines (2026-10-18, local A04/T01 increment): `active()` requires
`family.expiresAt` to be a finite number before comparing it with that final clock
sample, matching the token and pilot deadline read contracts. Numeric strings,
arrays and other coercible values do not authorize a session. This also denies
legacy registration's idempotent fallback when an existing family has a malformed
deadline; it does not repair, replace or extend that row. Existing transaction
conditions remain unchanged. Synthetic malformed-row tests establish local read
denial, not actual SDK acceptance of nonfinite values or DynamoDB/IAM behaviour.

Bootstrap expiry checks (2026-10-18, local A02/A04/T01 increment): registration
with a logout capability samples a finite clock after its three reads on every
transaction attempt. It rejects expired tokens, original authentication lifetime,
family/capability deadlines and pilot admission before sending writes. The same
sample supplies createdAt and the transaction's pilot deadline condition. Existing
revocation, lifecycle-hold and capability-binding conditions remain unchanged.
After a successful transaction response it checks token, family and the observed
pilot deadline again; the session API also checks token expiry using its response
serverTime for POST and GET. Exact expiry and nonfinite clocks deny success.
A denied response can follow a committed registration: the durable logout binding
is retained, not rolled back or extended, and capability logout remains available.
These checks do not enforce wall-clock expiry during transport/database commit or
prove revocation/admission remained unchanged after reads. They do not replace
atomic mutation fences, provider validation or cloud/device acceptance evidence.

Authenticate on socket connect and again when handling commands and sending
location to each recipient. A valid token is not proof of current room membership.
Internal user identity comes from verified token claims, never body `userId`.
The public route-sharing link and the pilot routing token grant no group access.

## Data and units

- `GroupRoom`: protocol version, opaque room ID, monotonically increasing room
  revision, title, lobby/riding/ended state, server expiry, immutable route snapshot
  reference or null for a free ride, and members.
- `GroupMember`: verified user ID, rider nickname, allowlisted motorcycle key,
  owner/member role, explicit sharing flag and nullable latest received fix.
- `GroupFix`: latitude/longitude in decimal degrees; horizontal accuracy in metres;
  heading clockwise from north in degrees `[0,360)` or null; speed in metres/second
  or null; `capturedAt` in Unix milliseconds; server-authorised device session epoch;
  monotonically increasing safe-integer sequence within that epoch.
- `ReceivedGroupFix` additionally carries server `receivedAt` in Unix milliseconds.
  Server receipt time must never replace original capture time.
- Cached account display metadata on the phone is not a server principal. It never
  grants membership or establishes who a location belongs to.

Prototype fix policy: capture <=15 seconds old and no more than 1 second in the
future; accuracy 0-100m; valid coordinate bounds; speed 0-150m/s. Reject invalid
fields rather than clamping/relabeling them. Missing/negative native heading/speed
become null. Local recording quality rules stay independent.

**Publisher clock skew remains open P03/P04 work:** upload validation still requires
a reasonably accurate publisher clock and rejects large skew. Never correct a
capture by replacing it with receipt time. A future publisher-offset contract must
preserve original capture metadata, calibration identity/uncertainty and capture
ordering; receiver calibration below does not establish actual GPS capture age or
prevent a dishonest publisher from lying about timestamps.

### Receiver server-time calibration (local, opt-in helpers)

`createGroupSessionClient().sampleClock(token, account, readClock)` sends the existing
authenticated, no-store `GET /v1/session` through the existing 10-second abort/deadline
transport. It checks the returned identity, server timestamp and session expiry.
It does not register a session, retry, poll, grant membership or change logout.
The server's status budget and live registry/pilot gates still apply. No automatic
caller or native clock source has been wired in this increment.

`readClock` must return a wall Unix-millisecond reading and a monotonic millisecond
reading from one process/timebase. Capture both immediately before the request and
after its JSON body is parsed. `src/utils/groups/clock.ts` rejects negative/nonfinite
readings, reversed monotonic time, wall/monotonic disagreement >100ms, RTT >2 seconds
or unsafe timestamps. An arbitrary static receiver wall-clock offset is allowed.
The timing source and behaviour across device sleep still need native validation.

For server timestamp S generated during that request and measured full RTT R, server
time at body receipt lies in [S, S+R] before resolution/drift allowances. Do not use
R/2 or assume symmetric network latency. After monotonic elapsed E, the helper uses
[S+E-error, S+R+E+error], with error = 1ms + (R+E)*100ppm. Calibration expires after
60 seconds and is invalid on clock discontinuity. These conservative prototype
limits/drift assumptions require measurement and server-clock health checks before
rollout. This interval is an application derivation, not an NTP implementation;
[RFC 5905](https://www.rfc-editor.org/rfc/rfc5905) describes network clock delay and
dispersion concepts. Uncertainty must remain explicit rather than treating a point
estimate as exact time.

Keep calibration in memory, scoped to its API/account and clock source; discard on
logout/account or endpoint change, restart, or suspend/resume until the clock source
has been validated. Never reuse persisted calibration across launches. A failed or
throttled sample produces no new calibration; a caller may retain an earlier sample
only until its original expiry, never extend it on error. Calibration is timing
metadata, not proof that a session or membership is still active.

`calibratedGroupFixFreshness` hides fixes without valid calibration, rejects capture
or receipt timestamps beyond the earliest plausible server now +1 second, then
applies existing freshness thresholds to the latest plausible now (oldest plausible
age). It preserves both timestamps and accounts for capture and receipt age. A point
whose uncertainty crosses a threshold moves to the older category. Delayed delivery,
recent receipt and receiver wall skew cannot make an already old server-comparable
capture fresh. Publisher offset/uncertainty, runtime snapshot integration, expiry
recovery UI and physical-device sleep/drift proof remain pending; the existing raw
freshness helper remains for callers with an already valid server-comparable now.

### Publisher capture timing (draft local contract; no wire change)

`src/utils/groups/publisherClock.ts` adds `createPublisherCaptureClock(sample)`.
Its version-1 **local timing contract** is separate from protocol version 1; it is
not accepted by the uploader or server. One factory owns one prior calibration
and one live API/account/clock-continuity scope. `capture(reading)` must run with
paired wall/monotonic readings **at actual position capture**. It cannot safely be
called with callback receipt time for a queued GPS fix, or with a historical GPS
timestamp combined with the current monotonic reading. No native capture adapter
currently supplies this prerequisite, so this is an unwired prototype.

The immutable handle preserves `rawCapturedAt` plus
`serverCaptureEarliestMs`/`serverCaptureLatestMs` from that original calibration.
Calibration must precede capture and remain valid. `publication(handle, reading)`
requires a handle issued by this exact factory, valid current calibration, forward
monotonic time and wall/monotonic continuity from both calibration and capture.
It returns the original handle with conservative age bounds:
`youngestAgeMs = max(0, now.earliest - capture.latest)` and
`oldestAgeMs = max(0, now.latest - capture.earliest)`.
It rejects publication when the oldest plausible age exceeds 15 seconds. Full RTT
and drift/resolution uncertainty consume that budget; a midpoint is never used.
Later calibration cannot rebind an existing handle or tighten its capture bounds;
cloned, serialised or foreign handles fail provenance checks. Raw time is unchanged.

Call `invalidate()` before replacing the scope on resampling, logout, account/API
change, restart or unvalidated suspend/resume; even retained handles then fail.
The helper detects inconsistent endpoint readings, not every intervening clock
jump (including jumps that cancel). A native source must prove capture pairing and
continuity or explicitly invalidate the scope; wall timestamps alone cannot prove
either. Timing handles are not session/membership authorisation or protection
against dishonest clients. No location data, credentials or calibration is persisted.

Before adopting any versioned wire/storage change, settle the native capture-time
source, uncertainty ceilings, server validation/ordering and receiver interval
semantics. Preserve raw metadata and reject unsupported clients/versions explicitly.
Existing exact-field v1 upload validation still rejects timing metadata and large
raw publisher skew. Neither uploader nor snapshot freshness uses this draft; the
P01/P02 native/provider gates and measured server-clock/drift assumptions stay open.

## HTTP surface (local prototype; not deployed)

| Method/path | Semantics and required checks |
| --- | --- |
| `POST /v1/rooms` | Authenticated owner creates lobby, bounded lifetime/title and fixed route snapshot; creation idempotency key |
| `POST /v1/rooms/{id}/invites` | Owner creates/rotates one-hour invite, bounded by room expiry; persist only its hash |
| `POST /v1/rooms/{id}/members` | Join with body inviteToken; revision-conditional write enforces cap, invite validity and duplicate membership |
| `GET /v1/rooms/{id}` | Current authorised membership/session required; returns current revision/snapshot |
| `POST /v1/rooms/{id}/start` | Owner only; one authoritative room transition; cannot enable peers' sharing |
| `PUT /v1/rooms/{id}/sharing` | User changes own opt-in; enable returns authorised device epoch/expiry; disable clears point and subscribers |
| `PUT /v1/rooms/{id}/fix` | Version 1 + exact fix fields; atomically conditions on room revision/state/lifetime, live session/account and point version |
| `PUT /v1/rooms/{id}/profile` | Current member updates own nickname/allowlisted motorcycle key |
| `DELETE /v1/rooms/{id}/members/me` | Self leave; immediately deny reads/delivery and clear own point |
| `DELETE /v1/rooms/{id}/members/{userId}` | Owner removes member; immediately revoke room access |
| `POST /v1/rooms/{id}/end` | Owner ends room; clear points, revoke invites/sharing; does not finish personal recording |

Metadata writes use revision compare-and-swap, bounded retries and a fresh live
session check per attempt. Creation/commands use a UUID v4 command ID and creation
time, accepted within two minutes of server time. Idempotency is scoped to verified
user + room; conflicting payload re-use is rejected. Cached command results contain
no coordinates. Create retries cannot resurrect ended/expired rooms.
Within an epoch, retransmission of an already accepted identical sequence is an
idempotent acknowledgement; conflicting payload at that sequence or older sequence
cannot overwrite latest. New device epoch must be issued by the server, not chosen
by an uploader to evade replay checks. Explicit host departure transfers ownership to the earliest joined remaining
member; final departure ends the room. A departing member receives no room
snapshot, including on retry. Loss of signal is not a departure.

The current uploader assumes `/v1/rooms/{id}/fix` exists but is **not wired to GPS
or a live endpoint**. `start(lease)` is not proof of permission: the group
service must supply a verified membership/device lease. No pending coordinate queue
is persisted. There is one in-flight attempt, a 5-second throttle, fresh-fix recheck
after token refresh, and a 10-second abort deadline that also releases the callback
when authentication is hung. Stop invalidates pending work and aborts transport.

## Planned events and display

Typed v1 events: snapshot, member.updated, member.removed, room.ended. Each change
includes authoritative room revision. Discard duplicates; a revision gap triggers
an authorised snapshot, not speculative state merging. Reconnect validates session
and membership and starts from a snapshot. Do not allow a buffered old snapshot to
restore a removed member or ended room.

Map display uses each member's selected bundled motorcycle with name/colour to
distinguish identical bikes. Remote heading is relative to camera bearing. Remote
motion does not inherit local road snapping. Capture age and receipt age both matter:
fresh <=20s, stale >20s, offline >=60s, point hidden >=5 minutes. Missing or
implausibly future fixes are hidden. Stale markers freeze; no phantom extrapolation.

## Expiry, safety and retention

Room cap 10; proposed maximum duration 12 hours. Logical expiry is checked on every
private operation even before physical deletion. Stop/leave/end clears latest
positions; a cleanup job purges missed coordinates within 15 minutes. TTL alone is
not sufficient. Record permanent peer trails nowhere. Do not log location payloads,
JWTs, refresh credentials or invite capabilities. Synthetic test fixtures only.

## Implemented session surface (local only)

`POST /v1/session`: exactly `{logoutSecret}` body, offline access-token verification plus live Cognito GetUser
probe before family registration. Body identity and query tokens are rejected.
The registry conditionally creates a new family only while the user is not blocked;
never replaces an existing family and never extends its original authentication
lifetime. `auth_time` prevents expired-family recreation after TTL deletes a record.
`GET /v1/session`: token and live registry required. `DELETE /v1/session`: signed
proof can revoke active or unknown family; unknown revocation creates a tombstone.
A new authentication family may register after logout, but an old one cannot.
`POST /v1/session/logout` additionally accepts a high-entropy revoke-only secret,
without an access bearer, for durable restart recovery. See the contract below.

Session storage is DynamoDB-backed with strongly consistent reads and conditional
transactions; current tests use a contract fake, not a live DynamoDB service.
The exported legacy `register()` helper is currently used by tests/integration
fixtures, not a production source caller. It uses one finite pre-send clock for
token/authentication lifetime validation, admission conditions and creation time;
the converted family deadline must also be finite. Its existing post-write
`active()` check revalidates token, family and admission after storage I/O. A late
response can deny success after a family has committed; it does not roll that write
back. These local checks do not enforce wall-clock expiry at database commit.
Revoking a user blocks their known and new families. Provider lifecycle handlers
and Apple/account deletion remain pending. SDK/network/storage failures fail closed
and return sanitised service errors. Deployment manifest/package are prepared only.

## Room metadata prototype - 2026-10-14

Implementation: `rooms.mjs`, `roomStore.mjs`, `roomApi.mjs`, `roomLambda.mjs` in
`services/group-rides/src/`. No new routes/tables were provisioned. The existing
session template still deploys only the session API; it does not publish room APIs.

Invites use 32 random bytes (256 bits), one active capability per room, at most
one-hour validity, constant-time hash comparison and owner-only retrieval at
creation. Creation always rotates rather than caching a raw capability for replay.
If the response is lost, the owner creates another invite. Membership removal or
any explicit departure invalidates the invite; rejoining requires a new invite
and new sharing consent. Invite-only users cannot read members or room metadata.
Server/per-account rate limiting still needs completion before public use.

Sharing consent issues a server epoch bound to the rider's verified session family.
Host start does not consent for peers. Stop, removal, leave and end invalidate
publication eligibility; replay of an old consent command returns no superseded
lease. This guard is not a location-write permission ticket: subsequent writes
must condition on the same room revision atomically and recheck current session.

The dedicated room adapter requires both room and session table names and rejects
reuse of the retained session table. It rejects coordinate/fix/raw credential fields.
Stored member data is metadata only; metadata-only snapshots report `fix: null`; when LOCATION_TABLE_NAME is configured,
GET uses the atomic authorised point snapshot described below.
Profile updates preserve allowlisted selected motorcycle keys. Logical room expiry
is immediate; metadata TTL targets 24 hours after explicit end (or scheduled expiry
if never ended). Explicit indexed metadata cleanup and monitoring now exist locally;
physical retention remains unproven. Dynamo TTL alone is not a strict cleanup deadline. GPS needs a separate short-lived
store and cleanup worker, with no backups/history, before native sharing is wired.

Prototype constraints: command freshness assumes reasonable device time; clock
calibration remains open. Fixed-route creation is disabled: non-null
`routeSnapshotId` returns `409 ROUTE_UNAVAILABLE` after authentication, creation
budget and input validation, before persistence. Omitted/null means a free ride.
An existing unresolved route reference (including a missing legacy field) also
blocks owner start commands and their retries; membership/owner checks still run
first. Metadata reads and authorised stop/leave/end remain available. This is a
local safety gate, not an immutable route resolver or a purge/migration of legacy
rooms that may already be riding. No deployed legacy-room state has been inspected.

Before enabling fixed routes, implement a private durable route store with
server-verified creator access, immutable version/content binding, bounded payloads
and retention at least through room expiry. Room creation must resolve and pin
that exact version atomically or through a proven immutable retention guarantee;
retries must preserve the same binding and conflict on changed content. Member
route retrieval must recheck live session/room membership without granting access
to outsiders holding an ID/invite. Test removal/revocation, concurrent creation,
missing/expired routes, content mutation and idempotency against real persistence.
Do not store geometry in the metadata-only room table or automatically upload local
tours. Public route shares use expiring bearer-access files; their IDs and the
pilot routing token are not private-route authorisation. No resolver injection or
configuration switch bypasses this gate. Wire/storage/retention/IAM and rollout
design remain pending. Bounded optimistic retries may
return ROOM_BUSY under contention; callers must back off/resynchronise. Live
DynamoDB validation, quotas, room-list/resume design and owner-transfer UX remain
pending. Do not equate synthetic tests with a working public group ride.

## Latest-point prototype - 2026-10-14

`locations.mjs` and `locationStore.mjs` implement publish/read with a separate
short-lived table. No deployment or phone integration is inferred. The optional
LOCATION_TABLE_NAME enables fix and point-bearing snapshot routes in roomLambda;
without it, room reads remain metadata-only and `/fix` returns 404.

Publish body is `{version: 1, fix: GroupFix}` only. Server identities come from
verified principal. Extra fields, invalid bounds/quality, old/future captures and
invalid sequence/epoch fail with INVALID_FIX. A bounded six-attempt loop reads a
current consent lease, checks the previous point and rechecks capture age after
storage latency. The DynamoDB transaction conditions on:

- The exact room revision, riding state and logical room expiry.
- Active unexpired registered session family and an unblocked account.
- The observed random point version (or absence for the first point).

Because consent/epoch/family changes increment room revision, those checks close
publication races. Identical sequence/payload retries conditionally acknowledge the
original receivedAt without rewriting point/TTL. Lower sequence, conflicting same
sequence, or non-increasing capture time in the retained epoch returns 409.
Only one point row per room/user persists. Coordinates never enter retained
account or room metadata tables. Family IDs are hashed in the point record.

Cleanup deletes the point and its ordering state. To prevent sequence reset in
that epoch, an absent point under an epoch issued >=14 minutes ago returns 403
SHARING_LEASE_EXPIRED. The rider must explicitly consent again with a fresh command,
which issues a new epoch. Missing legacy deviceStartedAt also fails closed. A point
that still exists retains its ordering guard even past logical point expiry; fresh
higher-sequence publication can replace it atomically. Capture age still rejects
old fixes. No permanent sequence/location history is kept. The phone must handle
idle-lease recovery before background integration is enabled.

Room updates atomically delete points for stopped/removed/departed members,
changed epochs/families, or ended rooms. Either publication commits first and the
update deletes it, or the updated revision rejects publication. Registry revocation
immediately denies reads/writes, but does not yet physically erase all coordinates
for that account across rooms; worker expiry is the fallback. Lifecycle purge is
still an A05/A06/B06 implementation task.

Snapshot discovery reads keys, then TransactGetItems atomically reads room,
viewer/source grants and point rows. Revision changes require rediscovery. Viewer
membership/session/expiry is checked against that transaction; each source must
still be sharing under its matching family/epoch and have an active session.
Room-ended/expired or removed viewers receive no snapshot. Sources with revoked
sessions, invalid/future/expired fixes or capture/receipt age >=5 minutes are
returned with fix null. Original capture/receipt fields are preserved. Socket
revocation, response/event ordering and resynchronisation still need implementation.

Storage contract: distinct table names; `pk`/`sk` point keys; ExpiryIndex hash
`cleanupBucket` and range `expiresAt`, INCLUDE `pointVersion` only. Disable point
backups/PITR/streams and payload logging in eventual infrastructure. Point deadline
is min(room expiry, receipt +14 minutes); TTL is only a fallback. Cleanup queries
expiry index and conditionally deletes the observed point version and overdue
expiry, paginating at most ten pages of 100 per invocation. Its result contains
counts and a backlog flag only. Deploy every minute, monitor index lag/backlog,
errors and physical age, and prove the <=15-minute retention requirement under
load/outage recovery. None of that is deployed/proven by the local worker alone.

Actual DynamoDB Local integration tests now exercise write/read conditions,
permission races, cleanup and index projection, using synthetic fixtures and
localhost-only endpoints. This validates DynamoDB expressions beyond contract
fakes; it does not prove AWS IAM, index lag, cloud latency or device reliability.
Run with `GROUP_DYNAMO_LOCAL_ENDPOINT=http://127.0.0.1:<port> npm run test:dynamo
--prefix services/group-rides` (one shell line). No AWS resource operations occur.

## Deployment preparation and monitored cleanup - 2026-10-14

A separate room/latest-point template and monitored cleanup worker now exist
locally; see [deployment preparation](group-rides-deployment.md). No AWS resources
were created. The template includes an independent API/roles/tables, forwarding
session routes to the existing session Lambda, one-minute scheduled cleanup and
operational alarms. Optional SNS alarm notification must be configured before
pilot use. Coordinate history/backups/streams remain forbidden.

Cleanup now deletes at most eight rows concurrently, awaits all outcomes, checks
remaining runtime and reports backlog before a hard timeout. Results also include
oldestOverdueMs for aggregate monitoring. Metrics/exception handling allow only
counts, duration and a bounded function dimension; no raw events/errors/points.
The observed overdue age reflects an eventual index, not proof of physical retention.
Local testing covers 1,050 overdue points draining across two bounded invocations;
AWS IAM, index lag, alarms, cloud latency and the <=15-minute target remain unproven.

## Durable sign-out and wire contract - 2026-10-15

See [account sign-out recovery](group-account-logout.md). Bootstrap now requires
exactly logoutSecret in the body; the individual JWT/provider checks remain.
Registry transactions bind its hash to one family, prevent rebinding/revival and
atomically revoke via POST /v1/session/logout. A secret cannot read or publish.
Unknown-secret tombstones close the logout-before-register race; public abuse
controls remain a release gate. No body identities/query credentials are accepted.

Revocation uses one finite clock sample per write attempt: after the strongly
consistent capability read for logout, or before the signed family update. The
computed retention deadline must be finite and later than that sample; an active
capability must have a finite stored deadline. The same logout sample controls
the live-family decision and transaction timestamps, including on conditional
retries. Unknown secrets retain the maximum session lifetime plus the accepted
one-second authentication-time tolerance. Existing capability expiry is preserved;
exactly expired capabilities need no family update. Already-revoked capabilities
return idempotently without clock sampling or a write. Successful committed
tombstones remain successful on late responses; these local clock checks neither
guarantee commit-time timing nor replace DynamoDB/IAM acceptance.

The client saves pending intent before network calls, keeps access tokens out of
persistent storage and refuses to refresh/activate pending credentials. Launch,
foreground and manual retries use the capability after access-token expiry.
Both remote revocations and protected deletion must complete before sign-in resumes.
Late refresh credentials remain revoke-only; config mismatch preserves/blocks the
outbox. Signed DELETE still exists for current/legacy access proof. Deploy the
updated handler/routes before any configured client; all work remains local.

## Pilot admission and atomic room mutations - 2026-10-15

[Server pilot admission](group-pilot-admission.md) now defaults to denied: verified
identity additionally needs a matching active USER row with future pilotExpiresAt.
There is no missing-row/public-mode fallback. Session bootstrap checks this before
provider probing and again atomically during persistence. Logout is exempt from
admission; it remains revoke-only and cannot read or publish.

Every DynamoDB room create/update now requires a verified actor and atomically
checks its live session family and USER approval with the metadata write/point
removals. The adapter has no plain Put fallback. Publication uses the same approval
condition. Atomic snapshots use shared policy for recipients and sources; withdrawn
sources have fix null, withdrawn viewers receive no snapshot. Pilot approval is
not membership, sharing consent or permanent revocation; all still apply.

Runtime roles cannot grant pilot approval. An operator must explicitly enrol a
verified subject through the authorised AWS workflow. Per-user/per-source abuse,
lifecycle purge and cloud IAM/clock/latency validation remain pending. No resources
or approvals were changed by the local implementation.


## Room metadata retention worker - 2026-10-15

B07 now has a separate local metadata cleaner and prepared schedule/alarms. Room
writes index a cleanup time one minute before min(explicit end, scheduled expiry)
+24 hours. A bounded query/conditional-delete worker protects concurrent revision
and deadline changes; it reads only index keys/deadline/revision. It has no point
or account authority. TTL remains a backstop; strict cloud timing, legacy-row
migration, index readiness/lag and outage recovery are release gates. See
[deployment and migration requirements](group-rides-deployment.md). Account-wide
logout/deletion membership/point purge remains a separate pending increment.

## Logout allocation budget - 2026-10-15 (local only)

S03 partial: POST /v1/session/logout now requires a shared DynamoDB budget before
any capability-registry access. One conditional transaction increments global and
per-source fixed-minute counters: 60 global and 6 per source. Failed conditions
return 429 LOGOUT_RATE_LIMITED with Retry-After seconds; unavailable storage or
missing/invalid gateway source returns sanitised 503. No local fallback. Only HTTP
API v2 requestContext.http.sourceIp is used; forwarded headers are ignored. Both
prepared gateways call the same session Lambda and consume the same counters.
No token, capability, subject or coordinate enters the budget table.

This conservatively limits all capability logouts, including retries/known secrets,
not merely unknown tombstones. Shared-network riders compete for the source cap;
an attacker can exhaust the global cap. Durable pending sign-out must remain
blocked/retryable on 429/503, never claim confirmed server revocation. Authentication
and expiry boundaries remain unchanged; logout remains independent of pilot approval.
Fixed windows allow up to twice the cap across a minute boundary. Delayed requests
cannot use permits after their selected minute; ambiguous SDK failure may consume
a permit without performing revocation. The limit is no guarantee of availability.

A separate encrypted counter table stores count, TTL and bounded window-scoped
SHA-256 source keys. These are pseudonymous, not anonymous: addresses can be guessed.
TTL is set one minute beyond window end; physical erasure is eventual, not a strict
privacy deadline. Global admission and source creation are atomic, bounding new
source rows per window to 60, plus one global row. No backups/streams are prepared.
[Conditional update semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html)
underpin the prepared transaction; local contract tests do not prove AWS behaviour.

Cloud execution-role enforcement, trusted gateway context, latency/concurrency,
throttle responses and counter privacy/retention need proof before exposure.
Per-account login/bootstrap/signed logout, room creation/invite/fix and edge abuse
controls remain pending. This increment alone does not complete S03 or open P01/P02.

## Verified-account session budgets - 2026-10-15 (local only)

S03 partial: POST, GET and DELETE /v1/session consume a mandatory distributed
budget after JWT identity verification and before registry/provider access. Each
operation has independent fixed-minute limits: bootstrap and signed logout each
allow 60 global and 6 per verified subject; GET status allows 600 global and 60 per
verified subject. Status, bootstrap and signed logout cannot consume each other's
pool. The account key comes only from the verified principal, never the body, session family, device or headers.
Invalid credentials allocate no counters. Non-admitted accounts can consume bounded
bootstrap permits but still fail pilot admission before provider probing or writes;
the budget is not admission. Signed logout remains independent of pilot admission
and active-family checks, subject to its own budget. GET status consumes its permit
before live registry reads and still rejects inactive/unapproved sessions.
Capability logout retains its separate source/global budget and needs no JWT.

Denied conditions return 429 ACCOUNT_RATE_LIMITED with Retry-After seconds, without
provider or registry effects. Outages/conflicts/ambiguous SDK results return generic
503. No local fallback. A consumed permit can be lost on later failure; delayed
permits cannot cross their minute boundary. Neither 429 nor 503 confirms logout.
Fixed windows permit boundary bursts and global exhaustion can delay legitimate
activation/revocation. Review pilot sizing and recovery before exposure.

A separate encrypted no-PITR/no-stream AccountBudgetTable stores only count, TTL
and bounded operation/window/hash keys. Global and account increments are one
[atomic transaction](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html),
so denied account limits spend no global permits and denied global limits create
no account rows. Per operation/window at most 60 account rows for bootstrap/logout
or 600 for status, plus one global row, can be admitted. SHA-256 hashes include
operation/window/verified subject; they remain pseudonymous and guessable, not anonymous. No raw identities, tokens,
capabilities or positions are stored/logged by this adapter. TTL is one minute
beyond window end; [physical TTL deletion is eventual](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html).
No strict counter retention guarantee or cloud IAM proof is claimed.

The preceding increment's pending per-account session budget is now implemented
locally, including status reads, with real DynamoDB and cloud validation still pending.
Room-operation budgets are described below. Login-provider and edge abuse controls
remain open. This does not complete S03 or open the provider/native/physical-device gates.

## Private room operation budgets (local S03 preparation)

Room creation, invite redemption, fix upload, snapshot reads, invite issuance and
start/profile/sharing-enable controls require a shared DynamoDB budget after
verified live-session authorisation and the API's
body size/JSON/field allowlist check, before room reads/writes or location service
effects. Service-level value, membership, invite and fix validation still applies;
invalid guesses, non-members and duplicate/replayed requests spend permits if they
reach that boundary. No room, invite, request-body or device ID selects the key.

| Operation | Global permits/minute | Permits/account/minute |
| --- | --- | --- |
| create | 60 | 6 |
| redeem | 120 | 12 |
| fix | 600 | 60 |
| snapshot | 600 | 60 |
| invite | 60 | 6 |
| control (start/profile/sharing enable combined) | 120 | 12 |

These are initial pilot caps, not measured capacity. Pools are separate. Each
request atomically increments a global and hashed verified-account counter, or
neither. Successful new account-row allocation per minute is therefore bounded
by that pool's global cap. Fixed windows use server time; late/clock-invalid
permits are refused. Counter TTL is set to one minute after the window ends;
physical TTL deletion is eventual and is not a strict retention guarantee.
Transactions follow the [DynamoDB atomic write contract](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html);
local contract tests do not prove real storage behaviour.

Denied counters return no-store 429 `ROOM_RATE_LIMITED` with integer `Retry-After`
seconds (1-60). Storage/conflict/clock ambiguity returns sanitised no-store 503
`GROUP_SERVICE_UNAVAILABLE`, with no local fallback. Creation/command retry
idempotency stays in the room service: retries spend permits and can receive 429,
even when the original operation succeeded. Upload retries never bypass the budget
or existing epoch/sequence checks. Clients must bound retries and retain only the
newest eligible fix; a throttle cannot establish successful publication.

The guards do not grant membership, revive revoked sessions or admit pilot users.
They do not limit JWT verification/live-session reads, HTTP ingress or fan-out yet.
Sharing stop (only literal boolean false), leave, end and member removal spend no
room permits. They retain all session, membership, role and command checks. Invalid
sharing values still spend control permits before service validation. Start/profile/
sharing-enable share control capacity; all six pools otherwise remain independent.
Dedicated teardown abuse protection remains pending and must preserve safety-path
availability, including during a counter-store outage. Snapshot failure cannot
relabel a cached peer fix as fresh; client 429/503 recovery needs deployment proof.
Cross-room traffic for an account shares its operation cap. Global exhaustion can
delay legitimate riders, fixed-window boundaries allow bursts, and transactions
introduce hot-key contention and extra reads/writes even when requests are denied.
Counter rows contain only window/operation, hash, count and TTL; hashes are guessable
pseudonyms, not anonymisation. No capabilities, tokens, raw identities or positions
are stored or logged by this adapter. S03 and live operational evidence remain open.


Session status budget availability boundary (local preparation): valid JWTs from
inactive or unapproved accounts can spend bounded status capacity, but cannot pass
the live registry check. Invalid tokens/envelopes spend none. Status exhaustion
does not spend logout/bootstrap permits; a shared AccountBudgetTable outage can
still deny all three operations. Capability logout uses its separate table/source
pool. Repeated GETs consume permits even when registry denial follows. Defaults
require actual client polling/load measurements and 429/503 recovery proof before
exposure; counters do not provide an ingress-cost ceiling or full S03 completion.

## Internal blocked-account per-room purge - 2026-10-15

`createBlockedAccountRoomStore` in `blockedAccountRoomStore.mjs` provides an
internal temporary-block operator primitive, with no
HTTP route or production caller. A trusted workflow supplies a verified subject
and known room ID after blocking the USER row. It cannot use a revoked rider's
normal room-write adapter, which deliberately requires an active account.

One transaction checks that the exact USER subject remains blocked, compares the
room revision, replaces affected room metadata and deletes that account's latest
point. A concurrent publication either precedes the block/erasure or fails its
existing USER/revision checks. Revision races cause rediscovery, bounded to six
attempts; an absent/active/mismatched USER row denies the operation. Unknown,
capacity and storage failures propagate. This follows the all-or-nothing and
conditional-write model in the [DynamoDB transaction documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).
The localhost-only integration suite
`services/group-rides/integration/blockedAccountRoomStore.dynamo.mjs` prepares
three isolated synthetic tables and covers the block gate (including readmission
between read/write), revision retry/exhaustion, owner/last-member removal,
absent metadata/membership orphan erasure, concurrent absent-room creation, and
publication ordered before/after block and purge. Interception hooks pause before
real commands and mutate real rows; they do not evaluate expressions in a fake.
Run using the existing `GROUP_DYNAMO_LOCAL_ENDPOINT=http://127.0.0.1:<port>
npm run test:dynamo --prefix services/group-rides` convention in an environment
permitting a local listener. The current sandbox denies listener creation (EPERM),
so this new suite is syntax-checked only; its assertions and actual expression
execution remain unverified. Cloud permissions remain unverified too.

Removal clears the structured member profile and publication grant, invalidates
the invite, and transfers owner to the earliest remaining member. Other members'
grants remain intact. An empty room ends and its owner field becomes null;
existing end time and cleanup/TTL deadlines are never extended. A retained empty
legacy room with the departed account still in ownerId is scrubbed too. Missing
membership or room metadata still permits gated orphan-point erasure; the absent
room is condition-checked so a concurrent metadata creation cannot be missed.
Retries after success leave metadata unchanged. Malformed metadata fails closed
for investigation rather than silently rewriting unknown state.

This is not account-wide deletion: the caller still needs complete room discovery,
durable progress/retry records, orphan-point reconciliation, blocked-account
retention through completion, lifecycle event authentication/deduplication, a
separate least-privilege worker role and provider/Apple revocation. It must not
readmit an account while its deletion workflow is in progress. The per-room
primitive installs no scan, queue, worker, IAM change or route. A separate local
discovery building block is described below. Arbitrary user-authored room titles
and pseudonymous command/fingerprint fields have not been classified or scrubbed
by this primitive; a full deletion/retention policy remains required. Existing
expiry workers remain the fallback for points whose rooms cannot be discovered.
No device, deployed deletion or <=15-minute account-wide purge claim follows.

### Internal bounded discovery/reconciliation - 2026-10-16

`blockedAccountDiscoveryStore.mjs` is a read-only building block with no caller,
route, queue, worker or IAM changes. Its `readPage(subject, { cursor, limit })`
checks the exact persisted USER is blocked before and after one strongly
consistent base-table scan, capped at 100 evaluated items. It returns only
`{ roomIds, next }`. The room phase conservatively projects every room key,
including expired/ended/legacy rooms: these are candidates, not evidence that the
account is a member. Pass candidates only to the existing blocked-account purge
primitive, which rechecks current membership/revision and atomically gates erasure.
The subsequent points phase filters on the subject's hashed RIDER key, projects
only keys and finds points with no retained room or membership. No coordinates,
profiles, invite capabilities or room payloads are read or returned by discovery.

Continue even when `roomIds` is empty if `next` is non-null; filters apply after
evaluation, so the continuation may belong to another rider. An empty/absent
LastEvaluatedKey ends a phase. Only `next: null` ends this traversal; passing a
null cursor starts a new traversal. Cursors are versioned and bound to subject
and all three table names; this detects accidental context reuse, is not a signed
capability, and must remain in trusted internal storage. Malformed keys/pages,
non-progressing cursors, unknown schemas and storage failures fail closed without
returning progress. Unknown legacy key formats require explicit investigation.

A future worker must durably enqueue/finish every returned candidate before
atomically advancing its persisted cursor, replay pages safely after failure,
bind progress to its lifecycle event and deduplicate candidates across phases.
Do not log cursors/room IDs/account hashes. The page ledger below adds internal
storage for that ordering; no production orchestration exists.
A full-table scan has table-wide read cost even with projections/filters; bounded
pages do not impose an aggregate account/job budget. This is a legacy/orphan
reconciliation option, not a substitute for an atomically maintained membership
index and bounded lifecycle scheduler. See the [DynamoDB Scan contract](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Scan.html)
for evaluated-item limits, pagination and absence of snapshot isolation.

Neither a terminal traversal nor the before/after block reads establishes complete
deletability under concurrency. Accounts must remain blocked throughout discovery,
purge and provider completion; current block TTL/readmission policy is not a
sufficient lifecycle lock. Index maintenance/migration, repeated reconciliation,
readmission exclusion, durable retries and a completion policy still need proof.
A transient readmission/reblock between reads cannot be detected by this adapter.
No production deletion worker should be wired until those dependencies and real
DynamoDB expression/IAM gates pass. The request-contract unit tests deliberately
provide no real database, deployment, provider or physical-device evidence.

### Internal hold-bound lifecycle discovery - 2026-10-16

`createLifecycleDiscoveryStore` in `blockedAccountDiscoveryStore.mjs` provides a
separate `readPage(subject, eventId, { cursor, limit })` for future lifecycle use.
It shares the bounded, key-only two-phase scan implementation above, but requires
the hold adapter's strict consistent validation of the exact durable subject/
event/session-table hold before and after every scan. Missing/temporary blocks,
foreign events, malformed holds and any TTL/expiry/pilot approval fail closed.
A changed hold start time also rejects the entire result. Initial/final read or
scan failures propagate without returning candidates or progress; retry with the
original persisted cursor. Inputs are copied before awaiting storage.

Lifecycle cursor bindings include the stable event ID as well as subject and all
three tables. The ledger now validates this same binding. Temporary-reconciliation
cursors, other events and old event-unbound ledger cursors are incompatible and
fail closed; do not reinterpret or automatically rebind retained progress. Progress
storage is unprovisioned and there is no production caller or migration. Any future
legacy-state recovery needs an explicit reconciliation plan. Neither binding is a
signed capability; cursors remain internal and must not be logged.

`createBlockedAccountDiscoveryStore` retains its temporary-block reconciliation
contract and must not be used for durable lifecycle orchestration. The new API
does not acquire a lock or atomically fence later purges. Arbitrary privileged
hold removal/recreation between reads is not excluded by these checks. Per-room
purge for lifecycle use must use the separate exact-hold transaction below;
the ordinary temporary-block API remains insufficient. No production caller, ingress, worker, provider,
IAM or deployment change is supplied here; real DB concurrency remains unproved.

### Internal durable lifecycle page ledger - 2026-10-16

`lifecycleProgressStore.mjs` adds an unused internal adapter for a separate,
currently unprovisioned `pk`-keyed progress table. Its job key hashes subject and
trusted event ID; its binding additionally covers all four storage tables. A
trusted lifecycle ingress must authenticate/deduplicate events and provide a
stable event ID. Different events have different job keys, but each operation now
requires the exact subject/event/session-table durable hold described below. This
adapter cannot acquire or replace that subject-wide hold. No raw event, subject,
credentials or coordinates are stored in the ledger. Job keys, cursors, room hashes and lease tokens must not be logged.

`initialize` conditionally inserts revision 1 and never resets existing work.
On a duplicate or ambiguous result, use `read` to inspect the persisted state.
`claim` takes an expected revision and a fresh server-generated 256-bit hex lease
token, for 1-60 seconds. Active leases cannot be displaced; an expired lease can
be replaced only with a different token. Never reuse tokens across acquisitions.
Other operations require the current token, expected revision and a locally
unexpired lease. Before every write, the hold adapter consistently reads and
strictly validates the non-expiring USER hold for the exact subject/event/table.
The progress transaction checks blocked state, subject, full hold-map equality
(including its start time), and absence of TTL, account expiry and pilot approval,
then compares the progress revision/binding before replacing the row. Temporary
blocks, foreign events and malformed holds cannot authorize progress. A hold
removed/replaced or given expiry/approval between validation and transaction
cancels the entire write. Reads validate the hold both before and after loading
progress and reject a changed start time. These reads are not a transaction or a
lock for later work; arbitrary privileged writers remain an external threat.
A new revision fences stale owners after takeover, including concurrent writes
by the same owner. Conflicts/errors propagate; no storage error becomes success.
This uses [DynamoDB conditional transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

The future worker sequence is:

1. Establish/confirm the durable hold through trusted ingress, then read/create
   the job and acquire a lease; if `pendingPage` exists, resume it.
2. Otherwise call hold-bound lifecycle discovery with the same event ID and
   persisted cursor, then `stagePage` with its
   exact `{ roomIds, next }`. At most 100 unique candidates fit in one page.
   Staging persists work but leaves the discovery cursor unchanged.
3. After real DB/IAM and workflow gates pass, use `createLifecycleRoomStore` to
   purge the first pending room with the same subject/event ID. The temporary-
   block helper is insufficient.
   Only after confirmed success, call `acknowledge` for that room with the current
   revision/token. Repeat, or let the lease expire and resume later.
4. Call `advance` only when the persisted page has no remaining candidates.
   Empty filtered pages still stage/advance. Terminal `next: null` records
   `traversalEnded: true`; this is explicitly not account-deletion completion.

A crash after purge but before acknowledgement replays that purge. A lost write
response requires rereading state before deciding what to repeat; retrying with an
old revision must fail. Candidate deduplication is within a page only; repeated
rooms across phases are intentionally safe to purge again. The adapter cannot
prove that a caller actually purged before acknowledging or supplied the correct
scan result. It has no public route, scheduler, queue or production caller.

Rows have no TTL: unfinished progress must not disappear through automatic expiry.
Retention, final erasure of ledger identifiers and repeated reconciliation need a
separate lifecycle policy. This is bounded work per storage call, not an aggregate
job/read-cost budget. Lease time relies on a trusted synchronized worker clock;
it is checked before issuing writes, not as a server-side commit-time deadline.
Revision fencing, not clock accuracy, prevents an old receipt overwriting a
successful takeover. A stale purge can still run, so erasure must remain idempotent
and account blocking must outlive every in-flight worker.

The existing expiring USER block is still not a lifecycle lock and is now
rejected by this ledger and the separate lifecycle discovery API. The per-room
purge has a separate exact-hold API described below. These checks do not provide a complete
membership index/migration, account-wide job scheduler/budget, provider revocation
or deletion completion. Malformed state fails closed
for investigation. Request-contract tests cover ordering, takeover, races, crash recovery and storage failures only; real
DynamoDB expressions/concurrency, table/IAM provisioning and deployed behaviour
remain unverified. Do not wire a worker until those prerequisites pass.

### Internal durable subject-wide lifecycle hold - 2026-10-16

`lifecycleHoldStore.mjs` adds an unused internal `begin(subject, eventId)` / `read`
adapter on the existing USER row. Trusted ingress must authenticate the subject,
validate the lifecycle event and provide a stable event ID before calling it.
A conditional Put replaces an absent row or a matching-subject legacy/active/
temporary-blocked row only while `lifecycleHold` is absent. The replacement is
blocked, has no TTL, expiry or pilot approval, and contains a versioned hold with
start time and a hash binding subject/event/table. No raw event is stored. This
uses [DynamoDB conditional replacement](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_PutItem.html).

An existing hold is never replaced, even by the same event. Only a confirmed
conditional failure permits a consistent reread: the exact same valid hold is
returned for duplicates; a different event, storage context, malformed hold or
mismatched subject fails closed for investigation. An ambiguous/network/storage
error propagates; reread or retry the stable event before starting any cleanup.
Different provider events need trusted subject-wide coalescing policy: they cannot
silently start independent workflows by replacing the first hold. The existing
per-event page ledger does not implement this policy.

The registry's temporary `blockUser` now conditionally refuses held or mismatched-
subject rows, so a delayed temporary block cannot reintroduce TTL over a hold.
Its denial must not be swallowed as successful conversion. Registry admission,
active-session/snapshot checks and atomic registration/room/publication gates also
require hold absence, including when a malformed row claims active pilot approval.
Normal sign-out remains independent of admission. No hold release/delete/readmit
operation exists. Holds outlive worker leases, retry windows and provider outages;
TTL of unrelated session rows does not remove the hold.

A hold in the USER row is not protection from arbitrary privileged Put/Delete,
backup restoration or an old writer unaware of this contract. Every operator grant
must atomically reject blocked/held rows; no unconditional overwrite/delete or
read-before-write grant is safe. Existing runtime roles cannot write USER rows.
A separate lifecycle/operator role, conditional admission tooling and real IAM/
DynamoDB race evidence are prerequisites to using this hold in production. No role
or resources were created here. Existing legacy temporary blocks remain expiring
until explicitly converted through authenticated ingress; no migration ran.

Before future orchestration, confirm the exact hold/event, then initialize/resume
the ledger; keep the hold through all discovery, purges, in-flight workers and
provider completion. The ledger now enforces the exact event hold on reads and
transactional writes; the separate lifecycle discovery API validates the same
event before/after scanning. Lifecycle per-room purge now checks the same hold
transactionally; temporary reconciliation/operator APIs still accept ordinary
blocks and must not substitute for these lifecycle APIs. Do not expose or
wire a worker until hold-aware sequencing, event coalescing, membership indexing,
reconciliation/budgets and actual database/IAM gates are proved. Permanent retention
of this pseudonymous block and ledger identifiers still needs an explicit privacy
policy; a terminal traversal or provider success must never automatically release
it. Full account deletion and <=15-minute account-wide erasure remain unproved.


### Internal hold-bound lifecycle per-room purge - 2026-10-16

`createLifecycleRoomStore` in `blockedAccountRoomStore.mjs` provides the separate
internal `purgeRoom(subject, eventId, roomId)` API. Before each room read it uses
the hold adapter's strict consistent read to require the exact non-expiring
subject/event/session-table hold. Missing, temporary, foreign-event, malformed,
TTL/expiry/pilot-approved rows fail closed. The first validated hold is retained
through all six bounded room-revision/transaction-conflict attempts; a later
hold with a different start time is rejected rather than adopted.

Each transaction checks blocked state, subject, full hold-map equality and absence
of TTL/account expiry/pilot approval, together with the room revision (or absence)
and latest-point delete. Hold removal, replacement or introduced expiry/approval
between validation and commit cancels all erasure. Initial/retry hold reads and
room reads can fail without erasure; unknown/storage/capacity errors propagate.
An ambiguous commit response is not reported as success: retry idempotently under
the same stable event and confirm success before ledger acknowledgement. A retry
after a confirmed commit leaves unaffected room metadata unchanged.

This API shares existing owner/member/last-member/legacy-owner and orphan-point
erasure logic with `createBlockedAccountRoomStore`. The latter retains its
`purgeRoom(subject, roomId)` temporary-block operator contract; it is not suitable
for lifecycle orchestration. Use the lifecycle API with the same trusted event
as hold, discovery and ledger. No production caller, HTTP route, worker, hold
release or completion authority is added. Hold checks are not protection against
arbitrary privileged USER overwrites/removal/recreation. Request-contract tests
exercise the new transaction shape and races only; real DynamoDB expression/
concurrency and IAM evidence remain pending. Existing retention/classification,
indexing/migration/reconciliation, trusted ingress/event-coalescing, budget,
provider/Apple and physical-device gates still apply. A terminal traversal is
not account-deletion completion or proof of account-wide erasure within 15 minutes.


Local integration preparation (2026-10-16): the guarded three-table suite
`services/group-rides/integration/blockedAccountRoomStore.dynamo.mjs` now includes
eight exact-event lifecycle cases alongside the existing operator cases. It
prepares holds through the real adapter and exercises owner/member/last-member
and orphan erasure, duplicate begin/replay, strict initial denial before room
reads, complete hold-map/absent-expiry commit conditions, changed ownership after
an actual revision cancellation, bounded revision retries and committed-but-lost
responses. Race hooks mutate actual local rows before forwarding real commands;
they do not simulate condition evaluation. Introduced TTL/expiry/approval fields
use zero to prove attribute presence denies even already-expired values.

A fresh localhost bind probe in this session failed with `EPERM`, so the emulator
was not launched and these integration assertions remain unexecuted. Syntax and
request-contract regressions do not establish actual database race/expression
behaviour. Run the existing strictly localhost-only `test:dynamo` command in a
listener-enabled authorised environment, then address any real DB failures before
considering workflow integration. No cloud, AWS TTL-service/IAM, deployment or
physical-device validation follows from this test preparation.

Local hold integration preparation (2026-10-16): the separate guarded suite
`services/group-rides/integration/lifecycleHold.dynamo.mjs` adds nine cases for
conditional acquisition from absent/legacy/admitted/temporary rows, stable restart
and concurrent duplicate/competing events, foreign/malformed/expiring holds,
existing/new session denial, hold acquisition between admission preflight and both
registration transactions, delayed temporary blocks and committed-but-lost-response
recovery. Synthetic isolated session-table rows and real-command interception are
used; condition evaluation is delegated to the local service, never simulated.
Setup records table creation before cleanup; teardown destroys the client even if
table deletion fails. The suite retains the strict localhost-only endpoint guard.

The fresh loopback bind probe for this increment also failed with `EPERM`. These
nine assertions are prepared, not executed against DynamoDB. Syntax, guard and
unit-regression results cannot substitute for DB/IAM/concurrency evidence. Run
`GROUP_DYNAMO_LOCAL_ENDPOINT=http://127.0.0.1:<port> npm run test:dynamo --prefix services/group-rides`
with installed Node22 and a verified DynamoDB Local runtime in a listener-enabled
authorised environment; retain cleanup failures as failures. No production caller,
provider change, deployment or device validation is established by this suite.
Discovery and durable page-ledger integration preparation remain pending.

### Prepared lifecycle discovery database integration - 2026-10-16

`services/group-rides/integration/lifecycleDiscovery.dynamo.mjs` adds seven
localhost-only cases with independent synthetic session/metadata/location tables
per case. It prepares real small-evaluated-limit traversal through both phases,
empty filtered page continuation, key-only projection, expired room/orphan point
candidates, empty tables, event/subject/all-table/temporary-cursor rejection before
I/O, strict initial hold denial, and actual hold mutation/removal after scans in
both phases. Additional cases retain unchanged holds across scans/restarts, copy
caller cursor inputs before awaiting reads and inject lost responses after actual
reads/scans, then retry the unchanged continuation. Scan order is not assumed;
hooks control timing only and never emulate DynamoDB expression evaluation.
Cleanup attempts deletion of every confirmed-created synthetic table even after
a failed case. No production caller, worker, migration or IAM change is included.

Node22 syntax and endpoint rejection are local checks only. The current session's
fresh loopback bind probe failed with `PermissionError(1, Operation not permitted)`
(`EPERM`); no emulator was launched and none of these database assertions ran.
In a listener-enabled environment with checksum-verified DynamoDB Local, run using
installed Node22:
`GROUP_DYNAMO_LOCAL_ENDPOINT=http://127.0.0.1:<port> npm run test:dynamo --prefix services/group-rides`.
Keep the strict localhost endpoint guard. Actual DB expressions, concurrency,
cleanup execution and AWS IAM/TTL-service behavior remain separate pending gates.
Page-ledger database integration and trusted lifecycle orchestration remain pending.

### Prepared lifecycle page-ledger database coverage - 2026-10-16

`integration/lifecycleProgress.dynamo.mjs` adds nine dedicated localhost-only
integration cases. Each fixture creates isolated synthetic progress, session,
room and point tables plus a context-rejection table, and attempts deletion of
every confirmed-created table even if assertions or another deletion fail.
Real-command hooks control timing and response loss; DynamoDB itself must evaluate
transactions, conditional puts and reads. No condition evaluator is simulated.

Prepared assertions cover actual discovery-page serialization, retained original
cursor and pending candidates across restart, empty-page/terminal traversal,
lease expiry/takeover and stale-owner rejection, concurrent initialization and
same-revision claims, every mutation's atomic cancellation after eight hold
changes, initial/post-load hold denial, subject/event/all-table context binding,
legacy/foreign cursors, committed lost responses for all five mutations,
precommit failure and caller-input copying. Acknowledgement here exercises ledger
mechanics only: no per-room purge or account-deletion completion is established.

Run with installed Node22 and a verified local runtime:
`GROUP_DYNAMO_LOCAL_ENDPOINT=http://127.0.0.1:<port> npm run test:dynamo --prefix services/group-rides`.
Missing or non-loopback endpoints reject before table creation. This session's
fresh loopback bind probe failed `PermissionError(1, Operation not permitted)`;
no runtime was launched and no database assertions or fixture cleanup ran.
Syntax/endpoint/unit checks do not prove real expressions, races, AWS IAM or TTL
service behavior. Trusted orchestration, progress provisioning, retention policy,
provider/native/device validation and all existing acceptance gates remain pending.

### Prepared lifecycle recovery composition coverage - 2026-10-16

`integration/lifecycleRecovery.dynamo.mjs` adds six synthetic localhost-only
composition cases. Independent four-table fixtures use the same exact-event hold
for real discovery pages, durable progress and `createLifecycleRoomStore` purges.
The test-side sequence stages before erasing, acknowledges only confirmed purge
success and advances only drained pages. Prepared assertions cover small-page
traversal including unrelated metadata and orphan points, peer preservation,
crash after purge/before acknowledgement, expired-lease takeover/stale receipts,
idempotent replay, precommit failure, ambiguous committed purge, committed lost
acknowledgement/advance responses, and hold removal between purge and ledger write.
Terminal traversal retains the hold and makes no deletion-completion claim.
The ledger cannot enforce that a future caller actually purged a candidate.

Real-command hooks control timing/response loss without simulating conditions.
Each fixture attempts deletion of all confirmed-created tables even on failure;
cleanup failures remain failures. Synthetic row seeding and identical-hold
restoration are test-only and do not authorize admission or hold release tooling.
No production orchestration, cloud/native API or dependency changes are included.

The fresh loopback bind probe failed with `EPERM`; no runtime or DB assertions/
fixture cleanup executed here. Syntax, endpoint guards and unit regressions do not
prove real DynamoDB expression, pagination, concurrency, cleanup or IAM behavior.
In a listener-enabled environment with checksum-verified DynamoDB Local, run:
`GROUP_DYNAMO_LOCAL_ENDPOINT=http://127.0.0.1:<port> npm run test:dynamo --prefix services/group-rides`
using installed Node22. Retain all DB/IAM, trusted-ingress, retention, provisioning,
provider/Apple and physical-device gates before production worker integration.

Partial-page recovery extension (2026-10-16): the recovery composition suite now
prepares nine cases in total. Two new cases stage three actual discovery
candidates, purge/acknowledge the first, fail the second purge before commit or
lose its committed response, then restart and take over the expired lease.
Assertions preserve the exact retained suffix and original cursor, reject stale
receipts and out-of-order acknowledgements, confirm idempotent replay and advance
only after draining. Candidate order comes from discovery, never scan assumptions.
A third case loses the committed stagePage response, rereads the durable page
before any purge, rejects stale/current-receipt restaging, and drains the retained
candidates in order. These remain test-side sequences, not production orchestration.
The fresh listener probe still failed with `EPERM`; the three additional DB cases
and fixture cleanup are prepared/unexecuted. The existing rerun command and all
DB/IAM, provider, native, retention and production integration gates still apply.

Hold-replacement recovery extension (2026-10-16): eleven composition cases are
now prepared. Two additional cases replace the exact event binding or startedAt
between hold validation and the real purge/acknowledgement transaction after a
three-candidate page's first purge/acknowledgement. Raw fixture snapshots assert
that rejected transactions preserve metadata, subject/peer points and the exact
retained progress. Foreign-event replacement also denies new read/purge/ledger
calls. Identical-original-hold fixture restoration then permits expired-lease
takeover, stale/out-of-order receipt rejection, idempotent replay of the already
purged second candidate and ordered suffix draining without resetting the prefix.

The startedAt condition pins an in-flight operation only. The progress row does
not persist a hold incarnation; a stable same-event hold with changed startedAt
can be accepted by later invocations. These tests do not establish durable
incarnation fencing or authorize privileged USER overwrite/recreation, hold
release or readmission tooling. Preventing those writes remains a production
IAM/admission gate. Both new DB cases and fixture cleanup remain unexecuted here
because the fresh listener probe failed EPERM. Syntax/guard/unit checks cannot
replace actual DB/IAM evidence; all previous deployment/device gates remain.

Concurrent recovery extension (2026-10-16): twelve composition cases are now
prepared. A new three-candidate case purges/acknowledges the discovery-ordered
prefix, then rendezvous two independent purge adapters before their first real
same-revision transactions. A five-second barrier bounds missing competitors;
retries forward without reentering the barrier. Assertions require both purges
to confirm success with exactly one membership mutation, revision-conflict retry,
peer preservation and no automatic ledger movement. Only then two same-revision
acknowledgements compete through a second bounded barrier. Exactly one durable
winner is recovered by reread; stale/repeated-prefix acknowledgements and early
advance are denied, and the remaining suffix is drained in order. Replay cannot
mutate the already-purged candidate. This remains test-side sequencing, not a
production worker or proof that the ledger enforces purge-before-acknowledgement.
The new DB case and fixture cleanup remain unexecuted because loopback bind still
fails EPERM; syntax/guards/unit passes do not prove actual DB races or IAM. All
production provisioning, retention, provider/native/device gates remain pending.

Concurrent orphan recovery extension (2026-10-16): thirteen composition cases
are now prepared. The new isolated fixture enters points discovery through an
empty room page, stages three actual orphan candidates in discovered order and
purges/acknowledges the prefix. Independent adapters rendezvous before their first
real transactions to purge the retained second point, condition-checking absent
metadata and deleting only the subject's point. Both must confirm success without
creating metadata; a membership revision retry is not required when no room exists.
Transaction-conflict retries remain bounded by the existing adapter limit. Peer
points, the third candidate and the durable ledger remain intact through purge.
Only then same-revision acknowledgements compete; a single persisted winner is
reread, stale/prefix receipts and premature advance are denied, and the exact
suffix drains to terminal traversal with the hold retained. This is test-side
sequencing; it does not enforce purge-before-acknowledgement for future workers.
The new DB assertions and fixture cleanup remain prepared/unexecuted because the
fresh loopback bind probe failed EPERM. Syntax/guards/unit passes cannot establish
actual transaction behavior; DB/IAM, retention, provisioning, provider and physical
device gates remain pending. No production worker/schema/native changes.

Retry-exhaustion recovery extension (2026-10-16): fourteen composition cases are
now prepared. The new discovery-ordered three-candidate fixture acknowledges the
prefix, then writes a real room revision immediately before forwarding each of
six real purge transactions for the second candidate. Each database cancellation
must identify the metadata revision condition; injected transport errors cannot
substitute for retry exhaustion. ROOM_BUSY preserves subject/peer points, room
membership, retained suffix and ledger, while only the six fixture revision writes
persist. A fresh adapter takes over the expired lease and rejects stale, repeated
prefix and out-of-order receipts. With conflicts stopped, confirmed purge and
idempotent replay precede acknowledgement; exact suffix draining preserves peers,
the acknowledged prefix and hold. This remains test-side orchestration only.
The additional DB assertions and fixture cleanup remain prepared/unexecuted:
loopback bind failed EPERM. Existing localhost rerun instructions, DB/IAM,
provisioning, retention, provider/native/device and production-worker gates apply.

Lost-takeover-response recovery extension (2026-10-16): fifteen composition cases
are now prepared. A discovery-ordered three-candidate fixture acknowledges the
prefix, expires its lease, forwards a real conditional takeover transaction and
loses only its successful response. No purge follows the ambiguous result until
a fresh adapter rereads the exact durable winning revision/token/lease and retained
suffix/cursor. Stale takeover retries, competing claims during the active lease,
old-worker receipts (including a current revision with the old token), repeated
prefix/out-of-order acknowledgement, restaging and premature advance are rejected
without moving progress or mutating candidates. Confirmed purge and idempotent
replay precede each ordered suffix acknowledgement; peers, prefix and hold survive.
This is isolated test-side sequencing, not a production ownership/recovery API.
The new DB assertions and fixture cleanup remain prepared/unexecuted because the
fresh loopback bind failed EPERM. Syntax/guards/unit results cannot prove actual
conditional writes or recovery. All DB/IAM, provisioning, retention, provider,
native/device and production orchestration gates remain pending.

Lease-expiry-during-purge recovery extension (2026-10-16): sixteen composition
cases are now prepared. The new discovery-ordered three-candidate fixture
acknowledges the prefix, forwards the second candidate's real purge transaction,
then sets the fixture clock to exact lease expiry before returning its successful
response. Membership/point removal commits while the durable suffix remains
unchanged. Already-expired acknowledgement, restaging and advance must reject
before any ledger transaction. A fresh takeover rereads and retains the suffix;
old-worker/current-revision-old-token receipts, active-lease competition,
prefix/out-of-order acknowledgement and premature advance reject. Confirmed
idempotent replay precedes acknowledgement of the second candidate, then the
remaining suffix drains in order with peers, prefix and hold preserved.
This is test-side recovery sequencing, not commit-time lease fencing: the purge
adapter does not accept a worker lease, and this test does not establish fencing
for ledger operations whose lease expires after their own admission checks.
The new DB assertions and fixture cleanup remain prepared/unexecuted because a
fresh loopback bind failed EPERM. Syntax/guard/unit checks do not replace actual
DB/IAM acceptance. Existing production, retention, provider/native/device gates
and localhost-only rerun instructions remain in force.

Admitted-acknowledgement versus takeover extension (2026-10-16): seventeen
composition cases are now prepared. After purging/acknowledging a discovered
prefix and purging the second candidate, the old adapter passes its live-lease
admission and hold reads. Its actual acknowledgement transaction is intercepted
before forwarding; the fixture clock expires and a separate adapter commits a
fresh takeover. Forwarding the old transaction must produce a real progress
revision-condition cancellation, with the hold condition satisfied. A fresh read
must recover the exact winning lease/revision, cursor and two-candidate suffix.
Stale/current-revision-old-token, prefix/out-of-order, restaging and early-advance
receipts reject. Confirmed idempotent replay precedes winner acknowledgement;
the remaining candidate then purges/replays/acknowledges in order, preserving
peers, prefix and hold. This establishes a prepared takeover revision race only,
not wall-clock commit fencing when no takeover commits. No production worker or
schema change. DB assertions and fixture cleanup remain unexecuted: loopback bind
failed EPERM. Syntax/guards/unit results do not replace actual DB/IAM evidence;
all existing provisioning, retention, provider/native/device gates remain pending.

Admitted-advance versus takeover extension (2026-10-16): eighteen composition
cases are prepared. A discovered one-candidate page is purged, replay-confirmed
and acknowledged while additional rooms remain. The old advance transaction is
intercepted after live-lease admission and hold reads; fixture time reaches lease
expiry and a separate adapter commits takeover before forwarding the old real
transaction. Assertions require progress revision-condition cancellation with the
hold condition satisfied, exact winning lease/revision, retained empty page and
original cursor. Stale and current-revision-old-token advances, restaging and
repeated acknowledgement reject. The winner advances exactly once; a real scan
must resume from its persisted next cursor before staging the next page. Peer
points, acknowledged metadata, unprocessed rooms/points and hold remain intact.
This is test-side takeover revision fencing, not wall-clock commit fencing without
a committed takeover or a production worker. DB assertions and fixture cleanup
remain prepared/unexecuted because loopback binding fails EPERM. Syntax, guards
and unit regressions do not replace DB/IAM acceptance; existing deployment,
retention, provider/native/device gates remain pending.

Admitted-stage versus takeover extension (2026-10-16): nineteen composition
cases prepared locally, not DB-executed. An isolated three-room fixture drains
one page to establish a non-null persisted cursor, then discovers the next page
without staging. The old stage passes live-lease admission and exact-hold reads;
a separate adapter commits takeover at fixture-clock expiry before the old real
transaction is forwarded. Assertions require only the progress revision condition
to cancel, retaining the exact winner with no pending page and original cursor.
Stale/current-revision-old-token stages, acknowledgement without a page, advance
and active-lease takeover reject without changing rooms, points, peers or hold.
A real scan checks the winner's persisted ExclusiveStartKey and rediscovers the
same page. The winner stages once, purge/replay-confirms before acknowledgement,
and advances once; the acknowledged prefix, unprocessed rooms and peer points
remain intact. This prepares takeover revision fencing, not wall-clock commit
fencing without takeover. No production worker/schema/API change. Actual DB
assertions and fixture cleanup remain pending behind the localhost-listener gate;
unit/syntax/guard checks cannot establish transaction or IAM acceptance.

Concurrent-stage extension (2026-10-16): twenty composition cases prepared.
After draining a prefix, two fresh adapters use the same live lease/revision and
one real discovered page. A bounded test-side barrier admits both stage calls
before forwarding either real transaction. The first real write commits before
the second is forwarded, deterministically exercising revision fencing rather
than simultaneous storage-lock arbitration. Exactly one must commit; the other
must have only the progress revision condition fail. A durable reread must match
the sole stage result, original non-null cursor and unchanged lease before any
purge. Stale/current-revision restaging and premature advance reject. Recovery
purges and confirms idempotent replay before acknowledgement, then advances once;
prefix, untouched data, peer points and exact hold remain intact. The barrier
controls timing and commit order only; it does not synthesize DB results. No
production adapter/worker/schema/API change. Actual DB concurrency assertions and
fixture cleanup remain unexecuted while localhost listeners are blocked; local
syntax/guard/unit checks cannot establish transaction acceptance or AWS IAM/TTL.


Competing-advance extension (2026-10-17): twenty-one composition cases prepared.
After a drained prefix, a second discovered page is staged, purged, replay-
confirmed and acknowledged while a third room remains untouched. Two fresh
adapters pass admission with the same live lease/revision before either advance
transaction is forwarded. The first real advance commits before the second is
sent; exactly one must succeed and the loser must report only progress revision-
condition cancellation. Durable reread must match the sole winner, next cursor
and unchanged lease. Stale and page-less advances and duplicate acknowledgement
reject. A real consistent scan must resume at the persisted ExclusiveStartKey,
find the remaining room and stage it without changing purged metadata, untouched
work, peer points or the hold. Bounded barriers collect both operations on
failure; no DB result is synthesized. Production worker/schema/API unchanged.
Actual DB assertions/fixture cleanup remain pending behind the listener gate;
syntax/guard/unit checks cannot establish transaction or AWS IAM acceptance.

Terminal competing-advance extension (2026-10-17): twenty-two composition cases
prepared. Actual room discovery drains an unrelated room without changing its
metadata, then points discovery stages an orphan candidate on a terminal page.
Purge and idempotent replay are confirmed before acknowledgement. Two fresh
adapters admit advances using the identical live receipt; a bounded barrier
commits the first real transaction before forwarding the second. Exactly one
must succeed, with only progress revision-condition cancellation for the loser.
Durable reread must equal the winner with traversalEnded true, null cursor/page
and unchanged lease. Stale and current-revision stage, acknowledgement, advance
and claim reject without transactions; claim also rejects after lease expiry.
Peer points, untouched room metadata and the exact hold remain intact, with no
completion or TTL marker. Terminal traversal does not release the lifecycle hold
or establish account deletion. Timing controls never synthesize DB outcomes;
actual DB assertions and cleanup remain unexecuted behind the localhost-listener
gate. No production worker/schema/API or deployment change; local checks cannot
replace DB/IAM, provider or physical-device acceptance.

Terminal response-loss extension (2026-10-17): twenty-four composition cases
prepared. Two isolated fixtures drain an unrelated room, discover terminal orphan
points, purge and confirm idempotent replay before acknowledgement. An advance
hook either fails before forwarding or forwards the real transaction and drops
its response. Exact intended terminal row/revision are asserted before forwarding;
no storage outcome is synthesized. A fresh adapter rereads durable progress:
precommit failure must retain the exact drained page and allow one retry, while
committed response loss must reveal the terminal winner and reject stale retry
without another transaction. Both paths require unchanged lease and terminal
reread, no stale/current-revision stage, acknowledgement, advance or claim even
after expiry, preserved peers/unrelated metadata and the exact hold. No completion
or TTL marker, production worker/schema/API change or deployment. Actual DB
assertions and fixture cleanup remain pending behind the localhost-listener gate;
local checks cannot establish DB/IAM, provider or physical-device acceptance.

Terminal retry takeover extension (2026-10-17): twenty-five composition cases
prepared. Real discovery, purge, replay confirmation and acknowledgement drain a
terminal orphan-points page before advance fails without forwarding its write.
At exact lease expiry, a fresh adapter must reread the unchanged drained page;
expired advance and same-token claim reject without transactions. One real claim
with a fresh token must change only revision/lease. Both the stale receipt and
old token with the new revision are fenced before one real terminal advance under
the replacement lease. Exact transaction intent and durable rereads are asserted;
terminal mutations/claims reject before and at the replacement lease expiry.
Peers, unrelated room metadata and the exact hold must remain intact, with no
completion/TTL marker. No production worker/schema/API or deployment change.
Actual DB execution and fixture cleanup remain pending behind the listener gate;
prepared assertions and local regressions cannot establish DB/IAM or device proof.

Terminal takeover hold-race extension (2026-10-17): twenty-six composition cases
prepared. One isolated fixture discovers terminal orphan work, purges/replay-
confirms and acknowledges it, then expires the lease. A fresh-token takeover hook
asserts the exact original hold and intended claim row before replacing only the
fixture hold with a foreign event and forwarding the real transaction. Real
cancellation must identify only the hold condition, leaving the exact drained
ledger, peer points, unrelated metadata and replacement hold unchanged. New read/
claim calls also fail closed without transactions. Only the fixture restores its
identical original hold; fresh reread, one successful claim and one terminal
advance then fence old receipts and reject terminal mutations/claims through the
replacement lease expiry. No completion/TTL marker or production hold replacement,
release/readmission API. The hook awaits each real command directly, with no
uncollected concurrent worker or synthetic storage result. Actual DB assertions
and finally cleanup remain unexecuted behind the localhost-listener gate. Local
checks cannot replace DB/IAM, provider or physical-device acceptance.

Terminal advance hold-race extension (2026-10-17): twenty-seven composition cases
prepared. An isolated fixture discovers terminal orphan work, purges/replay-
confirms it and acknowledges the drained page under an active lease. The advance
hook asserts the original hold and exact intended terminal row, replaces only the
fixture hold with a foreign event and forwards the real transaction. Cancellation
must identify only the hold condition; the raw drained ledger, peer points,
unrelated metadata and replacement hold must remain unchanged. Subsequent read/
advance calls fail closed without transactions. Fixture-only restoration of the
identical original hold permits fresh reread and exactly one terminal advance
without changing the lease. Stale/current terminal mutations and claims reject
before and at lease expiry. No completion/TTL marker or production replacement,
release/readmission API. Each hook command is directly awaited. Actual DB execution
and finally cleanup remain pending behind the listener gate; local checks cannot
replace DB/IAM, provider or physical-device acceptance.

Competing terminal takeover extension (2026-10-17): twenty-eight composition cases
prepared. An isolated fixture discovers/purges/replay-confirms terminal orphan
work, acknowledges the drained page and expires its lease. Two independent
fresh-token claims must load the same revision and reach transaction admission
before either write is forwarded. Bounded gates then forward one real claim to
commit before its competitor: exactly one wins and the loser must fail only the
ledger condition, avoiding dependence on transient transaction-lock behaviour.
Fresh adapter/raw rereads must preserve the exact page/cursor under the winning
lease. Stale revisions and old/losing tokens paired with the new revision cannot
mutate the ledger; active-lease claims also reject. The winner advances exactly
once, with terminal writes/claims rejected before and at replacement lease expiry.
Peer points, unrelated metadata and the exact hold remain intact, with no
completion/TTL marker. Both attempts are settled and gates released on failure
before fixture cleanup. Actual DB assertions and cleanup remain unexecuted behind
the listener gate; local checks cannot establish DB/IAM/provider/device acceptance.

Competing partial-page takeover extension (2026-10-17): twenty-nine composition
cases prepared. Real discovery stages a nonterminal room page; purge, confirmed
replay and acknowledgement remove only its first candidate. Two independent
fresh-token claims load the same expired revision with the exact ordered suffix
retained. Bounded admission gates precede ordered real sends: exactly one claim
commits and the loser must fail only the ledger condition. Fresh/raw rereads
preserve suffix/cursor under the winning lease, with untouched suffix rooms and
points. Stale revisions, old/losing tokens, active-lease claims, early advance and
out-of-order acknowledgement reject without transactions. The winner purges,
replay-confirms and acknowledges each suffix candidate in order, preserving cursor
and lease until exactly one advance installs the staged continuation. The already
purged prefix, peer points, unrelated metadata and exact lifecycle hold remain
intact. Both claims settle on failure before fixture cleanup. No production worker,
completion/TTL marker or hold-release API. Actual DB assertions and cleanup remain
pending behind the listener gate; syntax/regressions do not establish DB/IAM,
provider or physical-device acceptance.

Partial-page takeover hold-race extension (2026-10-17): thirty composition cases
prepared. Real discovery/prefix purge/replay/acknowledgement retain an ordered
nonterminal suffix through lease expiry. The takeover hook replaces only the
fixture hold with a foreign-event binding after admission, then forwards the real
claim transaction. Assertions require hold-only cancellation and exact unchanged
raw ledger, suffix, cursor, expired lease, rooms and points. Further reads/claims,
discovery and suffix purges fail closed. Identical fixture-only hold restoration
and fresh reread/new token permit recovery; stale/failed/old-token receipts, early
advance and out-of-order acknowledgement reject without transactions. Confirmed
ordered suffix purges and acknowledgements precede exactly one cursor advance.
Purged prefix, peer points, unrelated metadata and original hold remain intact.
All calls are awaited before fixture cleanup; no deferred worker, production
release/readmission API or completion marker. Actual DB assertions/cleanup remain
unexecuted behind the listener gate; no DB/IAM/provider/device acceptance inferred.

Nonterminal advance hold-race extension (2026-10-17): thirty-one composition cases
prepared. Real small-page discovery and confirmed prefix/suffix purges drain a
nonterminal room page under its live lease. The advance hook replaces only the
fixture hold with a foreign-event binding after admission and forwards the real
transaction. Assertions require hold-only cancellation and exact unchanged raw
ledger, drained page, cursor, revision, lease, room metadata, subject/peer points
and remaining candidate. Further read/advance/discovery/purge calls fail
closed. Identical fixture-only hold restoration and fresh reread permit exactly
one continuation advance; repeated/stale advances and acknowledgements reject.
A real consistent scan uses the exact persisted continuation to discover and stage
the remaining candidate without skipping work. Original hold and peer data remain
intact. No production worker, release/readmission API or completion marker. Actual
DB assertions/cleanup remain pending behind the listener gate; local checks do
not establish DB/IAM, provider, native or physical-device acceptance.


Committed-continuation response-loss extension (2026-10-17): thirty-two
composition cases prepared. Real discovery and confirmed prefix/suffix purges
drain a nonterminal page. The hook forwards the real advance transaction, checks
the exact committed continuation/revision/lease, then replaces only the fixture
hold with a foreign-event binding and drops the response. Raw reads must preserve
the committed row and all room/point/peer data. Authorised reread, discovery,
purge and a valid next-stage attempt fail closed while replaced; stale advance
fails on revision without reaching hold admission. Identical fixture-only hold
restoration and fresh reread recover the committed cursor. Neither stale nor
current receipts can advance the already advanced page. A real consistent scan
must start from that exact cursor and stage only the remaining candidate. All
calls are awaited before fixture cleanup. No production worker, hold release/
readmission API or completion marker. Actual DB assertions/cleanup remain
unexecuted behind the listener gate; no DB/IAM/provider/native/device acceptance
is inferred from local syntax, guard or regression checks.

Expired committed-continuation recovery extension (2026-10-17): thirty-three
composition cases prepared. The response-loss fixture also expires the committed
lease while its foreign-event fixture hold remains installed. Raw committed
cursor/revision/lease, room metadata and subject/peer points must remain exact;
reread and new-token claim stay denied by the hold. Identical fixture-only hold
restoration permits reread but cannot renew the expired lease: staging and
same-token claim reject without writes. A real new-token claim must preserve the
committed continuation, increment revision once and fence old revision/token
receipts. A consistent scan starts at that exact cursor; only the remaining
candidate can be staged using the recovered live lease. Existing live-lease
response-loss coverage remains. All operations are awaited before fixture cleanup.
No production worker, schema, release/readmission or completion API change. Actual
DB assertions/cleanup and DB/IAM/provider/native/device acceptance remain pending;
local syntax/guard/regression checks do not satisfy those gates.

Lost committed-continuation takeover response extension (2026-10-17): thirty-four
composition cases prepared. An additional expired-continuation variant forwards
the real new-token conditional takeover, verifies its committed raw row and then
loses only response delivery. A fresh authorised reread must recover exactly the
winning revision/token/lease and continuation before discovery or staging. Retry,
competing live-lease claims and old revision/token receipts must fail without
writes; room metadata and subject/peer points stay exact. Consistent discovery
starts at the committed cursor and stages only the real remaining candidate in
one transaction. Both stale-revision and current-revision restaging fail, as do
advance with pending work and acknowledgement of the prior page's candidate.
Existing live/expired variants and finally cleanup remain. This is test-only;
actual DynamoDB assertions/cleanup and DB/IAM/provider/native/device acceptance
remain pending. Local regression checks cannot establish those results.

Lost committed-continuation stage response extension (2026-10-17): thirty-five
composition cases prepared. The additional variant retains both prior committed
continuation and takeover response losses, then forwards the real conditional
next-page stage before dropping its response. Raw progress must contain exactly
the winning pending page/revision/cursor/lease while room and subject/peer data
remain unchanged. A fresh authorised read recovers the page before further work;
stale/current restaging, early advance and prior-page acknowledgement reject
without writes. Only the retained candidate is purged, absence and idempotent
replay confirmed, then acknowledged and advanced with fresh receipts. Earlier
rooms and peer points remain exact and the lifecycle hold remains installed;
traversal is not account deletion completion. Existing variants and awaited
finally cleanup remain. Actual DB assertions/cleanup are unexecuted behind the
listener gate; local checks do not establish DB/IAM/provider/native/device
acceptance. No production worker, schema or hold-release/readmission change.

Lost committed-continuation purge response extension (2026-10-17): thirty-six
composition cases prepared. The fifth continuation variant retains the lost
continuation, takeover and stage responses, then commits the real conditional
retained-room purge before dropping its response. Raw pending progress remains
exact; only that room's subject membership/point change, with earlier rooms and
peer points preserved. A fresh authorised progress read recovers the retained page;
stale/current restaging, early advance and prior-page acknowledgement reject
without writes. Confirmed idempotent purge replay and unchanged room revision
precede fresh acknowledgement/advance. Hold retention and finally cleanup remain.
This is test-only coverage: actual DB assertions/cleanup and DB/IAM/provider/native/
physical-device acceptance remain pending. No production worker, schema or
hold-release/readmission change; traversal cannot establish deletion completion.

Lost committed-continuation acknowledgement response extension (2026-10-17):
thirty-seven composition cases prepared. The sixth continuation variant retains
continuation/takeover/stage/purge response losses and confirms idempotent purge
replay before forwarding the real conditional acknowledgement transaction. Its
response is lost only after exact raw drained page/revision/cursor/lease and
unchanged room/point/peer/earlier-room state are asserted. A fresh authorised read
recovers that drained page; stale/current acknowledgement and restaging retries
and stale advance reject without new transactions before exactly one fresh advance.
Hold retention and awaited finally cleanup remain. Actual DB assertions/cleanup
are unexecuted behind the listener gate. DB/IAM/provider/native/physical-device
acceptance and deletion completion remain pending; no production/schema change.

Lost recovered-continuation advance response extension (2026-10-17): thirty-eight
composition cases prepared. The seventh continuation variant retains the prior
continuation/takeover/stage/purge/acknowledgement response losses, then forwards the
real conditional advance of the recovered drained page. Exact raw committed cursor,
revision, lease, pending-page and traversal state plus unchanged purged rooms,
subject points and peer points are asserted before response loss. A fresh authorised
read recovers that state before old/current advance and acknowledgement retries
reject without transactions; the drained page is never replayed. Hold retention
and awaited finally cleanup remain. Actual DynamoDB assertions/cleanup remain
unexecuted behind the listener gate; DB/IAM/provider/native/physical-device
acceptance and deletion completion remain pending. No production/schema change.


Recovered-continuation advance hold-race extension (2026-10-17): thirty-nine
composition cases prepared. The eighth continuation variant retains lost
continuation/takeover/stage/purge/acknowledgement responses, then replaces only the
fixture hold after validation of the recovered final advance. The real transaction
must cancel on its hold condition with no progress write: exact drained page,
cursor/revision/lease and purged rooms/subject points/peers remain unchanged.
Foreign-hold read/advance/purge retries reject without transactions. Identical
fixture restoration is followed by a fresh authorised reread before exactly one
successful advance; prior/current receipts cannot replay advancement or acknowledge
purged work. Hold retention and awaited finally cleanup remain. Fixture restoration
is no production release/readmission API or durable cross-call incarnation fence.
Actual DB assertions/cleanup remain unexecuted behind the listener gate; DB/IAM,
provider/Apple, deployment and physical-device acceptance stay pending. No production
or schema change and no deletion-completion claim.

Recovered drained-page lease expiry under a foreign hold (2026-10-17): forty
composition cases prepared. The ninth continuation variant retains the composed
response losses and real final-advance hold-condition cancellation, then expires
the recovered drained page's lease while the foreign fixture hold remains. Reads
and fresh-token claims stay denied; exact raw progress, cursor, drained page,
lease and purged rooms/subject points/peers remain unchanged. Identical fixture
restoration permits a fresh authorised reread but cannot renew the lease: expired
advance/stage/acknowledgement and same-token claim reject without transactions.
Exactly one real fresh-token conditional claim must retain the drained page and
cursor while changing only revision/lease. Old revision/token receipts and competing
live claims reject without transactions before exactly one final advance, without
rediscovery or purge replay. Hold retention and awaited finally cleanup remain.
Fixture restoration is no production release/readmission API or durable cross-call
incarnation fence. Actual DB assertions/cleanup, IAM, deployment, provider/Apple and
physical-device acceptance remain pending; no production/schema change or deletion
completion is claimed.

Lost recovered drained-page claim response (2026-10-17): forty-one composition
cases prepared. The tenth continuation variant retains the prior composed response
losses, final-advance hold-condition cancellation and drained-page lease expiry.
After identical fixture hold restoration and authorised reread, exactly one real
fresh-token conditional claim commits; exact raw revision/lease/drained page/cursor
and unchanged purged rooms/subject points/peers are asserted before losing only
its response. A fresh authorised adapter must recover that committed lease before
advance. Old revision/token write and claim retries and competing live claims
reject without transactions, followed by one final advance without rediscovery or
purge replay. Hold retention and awaited finally cleanup remain. Fixture restoration
is no production release/readmission API or durable cross-call incarnation fence.
Actual DB assertions/cleanup, IAM, deployment, provider/Apple and physical-device
acceptance remain pending; no production/schema change or deletion completion claim.

Expired lost drained-page claim before recovery read (2026-10-17): forty-two
composition cases prepared. The eleventh continuation variant retains the composed
response losses, final hold-condition cancellation, fixture hold restoration and
first drained-page lease expiry. The final fresh claim commits once and loses only
its response, then its lease expires at the exact boundary before a fresh authorised
read. That read recovers the unchanged drained page/cursor/revision/expired lease;
expired current receipts and stale revisions/tokens cannot write or renew it.
Exactly one distinct real conditional claim changes only revision/lease, preserving
purged rooms/subject points/peers and drained work. Stale and competing live claims
remain fenced before one final advance without rediscovery or purge replay. Hold
retention and awaited finally cleanup remain. Fixture restoration is no production
release/readmission API or durable cross-call incarnation fence. Actual DynamoDB
assertions/cleanup, IAM, deployment, provider/Apple and physical-device acceptance
remain pending; no production/schema change or deletion-completion claim.

Second drained-page reclaim hold race (2026-10-17): forty-three composition cases
prepared. The twelfth continuation variant retains the prior response losses,
advance hold-condition cancellation, first reclaim commit/response loss and expiry
before recovery. After validation of the second reclaim, a foreign fixture hold
replaces the original immediately before forwarding its real transaction. The hold
condition must cancel the entire transaction: zero committed reclaims, unchanged
expired revision/lease, drained page/cursor and purged rooms/subject points/peers.
Reads, fresh claims and purge remain denied under that hold; expired mutations
reject without transactions. Identical synthetic hold restoration and a fresh
authorised reread precede retry of the uncommitted distinct-token receipt. Exactly
one reclaim commits, preserving drained work; stale/competing receipts remain fenced
before one final advance without rediscovery or purge replay. Hold retention and
awaited finally cleanup remain. Fixture restoration provides no production release/
readmission API or durable cross-call incarnation fence. Actual DynamoDB assertions/
cleanup, IAM, deployment, provider/Apple and physical-device acceptance remain
pending; no production/schema change or deletion-completion claim.

Lifecycle ledger pre-send lease check (2026-10-17): hold validation is asynchronous
and can outlast a lease that was live when the progress row was loaded. Claims
(including expired-lease takeovers), page staging, acknowledgements and cursor
advances recheck the injected clock after the hold read, immediately before sending
the transaction. A proposed lease at or past its deadline, or an unavailable/unsafe
clock, rejects without a transaction; persisted progress and the hold remain intact.
A newly claimed lease is not extended to hide hold-read latency. The last millisecond
before its deadline remains eligible. Initialization has no lease and is unchanged.
Deterministic request-contract tests reproduce the former boundary failure and
exercise all five operation paths. This local pre-send check cannot establish
wall-clock expiry during transport or at database commit; conditional revision and
exact-hold checks still fence concurrent writers. Actual DynamoDB expressions,
IAM, deployment, retention, provider/Apple deletion and device evidence remain
pending. No worker, schema, hold-release or deletion-completion API is introduced.

Temporary account-block timing (2026-10-18): registry.blockUser() validates one
finite pre-send clock sample and a finite, strictly advancing retention deadline
before sending its conditional replacement. Invalid clocks or nonadvancing
arithmetic reject without storage; valid blocks retain the configured bounded
lifetime and TTL cleanup semantics. Subject binding and absence of lifecycleHold
remain atomic write conditions. A durable hold acquired while a temporary block
is in flight therefore still fences that write. Storage/conditional failures
propagate; a lost response can leave a committed block, while a late successful
response is not reclassified by a second clock sample. This temporary operator/
provider helper has only test/integration-fixture callers currently; it is not
a durable deletion hold, deletion acknowledgement or automatic readmission API.
Local clock guards and expression fakes do not prove commit-time expiry, actual
DynamoDB/IAM behaviour, provider revocation or deletion completion.

## Session budget completion clocks - 2026-10-18 (local only)

S03/A05 partial: account and capability-logout budgets use one post-send clock
sample on each successful or conditional-rejection result. The sample must be a
safe integer no earlier than the pre-send sample. Successful permits additionally
require completion strictly before their original minute boundary; invalid,
regressing or expired success clocks deny downstream effects. On conditional
rejection, invalid/regressing clocks produce sanitized no-store 503 with no
Retry-After header; valid clocks preserve 429 with integer Retry-After clamped to
1-60 seconds, including rejection received after the original window ended.
Unrelated/ambiguous storage failures propagate without another clock sample.
There is no retry, fallback or compensating counter decrement: a successful send
followed by clock failure may still have consumed both permits. Atomic counter
conditions, operation pools and credential-independent source keys are unchanged.
Synthetic local tests establish adapter/API behavior only; DynamoDB/IAM, actual
clock/latency behavior, deployment and device evidence remain separate gates.

Logout budget arithmetic headroom (2026-10-18, local only): the initial clock
must also be nonnegative and no greater than Number.MAX_SAFE_INTEGER minus two
minute windows, matching account/room budgets. Unsupported clocks fail before
hashing or SDK send so both the next window boundary and its extra-window TTL
arithmetic remain safe integers. The inclusive supported boundary retains existing
counter conditions, source keys, TTL and bounded Retry-After behavior. The API
returns sanitized no-store 503 without Retry-After or revocation effects on clock
failure. Synthetic extreme-clock tests prove local adapter/API behavior only;
they do not establish real clock exposure or DynamoDB/SDK acceptance. No schema,
transaction conditions, refunds or deployment changes accompany this guard.
