# Group room deployment preparation

Current rollout (2026-10-19): Cognito/Apple identity, private session API and
artifact stacks are deployed. [Verified resources and checks](group-identity-deployment.json).
Room/location/progress/WebSocket services and end-to-end acceptance remain pending.
Historical local-only notes below do not supersede this status or the tracker.
Both API stages now depend on SessionLogoutRoute before applying its route-specific
throttle, fixing an actual session-stack creation failure. The session table was
preserved/imported and TTL verified enabled. No runtime admission bypass was added.

Local preparation for B01/B07/S02/S03. Nothing in these templates has been
deployed. Follow [the tracker](group-rides-implementation.md) and
[account setup](group-accounts-setup.md); keep account preview off until the
provider, lifecycle and physical-device gates pass.

## Resources and dependencies

`services/group-rides/infra/sessions.template.json` remains the session stack.
The new `services/group-rides/infra/rooms.template.json` requires its existing
SessionTableName and SessionFunctionArn, plus the same Cognito pool/client in
London. The room stack owns a separate HTTP API, room metadata table, latest-point
table, room Lambda, separate point/metadata cleanup Lambdas, one-minute
EventBridge rules and alarms.

The room API forwards POST/GET/DELETE `/v1/session` and POST `/v1/session/logout`
to the existing session Lambda;
all `/v1/rooms` operations go to the room Lambda. This gives the app a single
HTTPS EXPO_PUBLIC_GROUP_API_URL while preserving the existing registry/bootstrap
implementation. The additional Lambda invoke permission is scoped to the new API.
The old session API remains valid; it uses the same registry. No configuration is
written into the app by creating these templates.

Both tables are encrypted pay-per-request DynamoDB tables. The point table has
PK pk/SK sk and an expiry GSI projecting only primary/index keys and pointVersion.
No coordinates/family IDs enter that index. PITR is explicitly disabled, streams
are absent, and stack deletion/replacement deletes these tables. The retained
account-session table is not owned or deleted by this stack. Keep point storage out
of organisation-level AWS Backup policies and exports; this cannot be enforced by
these local template settings alone. Room metadata now has an explicit expiry
cleaner in addition to asynchronous TTL; the strict 24-hour bound remains an
unproven operational requirement.

Roles are distinct. The API can read/check existing session grants, conditionally
read/write room metadata and read/write/delete/check points. It cannot register or
revoke accounts. Cleanup can query only the expiry index and delete point rows;
it cannot read coordinates from the table or touch room/session grants. Each role
can write only its own pre-created seven-day runtime log group. DynamoDB transaction
permissions use the underlying item actions plus ConditionCheckItem, following
[AWS's transaction IAM model](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).
No Scan, table administration, backup, export or wildcard storage permissions are
provided. AWS IAM must still be live-tested with each actual execution role.

Pilot bounds: default route rate 20 requests/second with burst 40; room Lambda concurrency
10 and timeout 20 seconds. Cleanup concurrency 1 and timeout 55 seconds. The API
performs JWT/session/membership checks inside Lambda; CloudFormation routes do not
replace those checks. These are route throttles, not an aggregate account-wide limit or per-user abuse protection
or a pilot admission policy. Configure those before configured builds circulate.

## Cleanup and monitoring

Cleanup queries oldest due rows, at most 10 pages of 100, deleting up to eight
independent rows concurrently. Deletes require the observed point version and an
overdue deadline. A stale index cannot delete a refreshed point. All launched
operations settle before returning/failing. The worker checks remaining runtime
and stops with backlog while reserving five seconds for metrics/return. The next
scheduled run starts from oldest entries; no coordinate retry queue is persisted.

EventBridge triggers each minute with an empty body. Both EventBridge delivery and
Lambda asynchronous processing use a 60-second age limit and no error retries;
the next periodic invocation performs fresh cleanup. This avoids accumulating
old scheduled work behind a serial worker. Scheduling/delivery/async discard can
still fail, so these are monitored separately.

The worker emits CloudWatch embedded metrics with one bounded FunctionName
dimension: success/failure, backlog, examined/deleted counts and oldest observed
overdue age. It never logs events, IDs, points or raw SDK exception/cause. Metrics
are written through logs without giving the Lambda PutMetricData permission, using
[the AWS embedded metric format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html).

Local error-boundary regressions also cover a failing metric sink or timestamp
supplier: failure reporting is best-effort and only the generic cleanup error
escapes, without the original error/cause. A success-metric failure still fails
the invocation; it does not rerun cleanup. If failure reporting also fails, no
failure metric is guaranteed, so runtime-error and missing-success alarms remain
necessary. Synthetic tests cover API unavailable responses and worker output;
they do not establish deployed gateway, runtime, proxy or crash-log redaction.

Local room control regressions cover create, invite, redemption, start/end,
sharing on/off, profile, leave and removal. Unexpected service failures expose
only the generic no-store 503; typed denials expose their public code/status,
without private message, stack, cause or request metadata. Budget denials retain
their integer Retry-After and prevent service effects. Safety actions bypass
budgets but still recheck live sessions in the room service before storage access.
These synthetic checks do not prove deployed revocation or logging behaviour.

Local session transport regressions cover bootstrap/status/signed revoke and
secret-based logout. Invalid query/body requests return exact sanitized no-store
responses before verifier, budget, provider or registry calls. Raw/base64 valid
controls verify argument forwarding and independent logout-budget ordering without
requiring a live access token. The existing 1,024-character envelope limit applies
before decoding (base64 therefore permits fewer decoded bytes); status/revoke
accept absent/null/empty event bodies and reject nonempty bodies. These synthetic
tests do not prove canonical base64, strict UTF-8, gateway/runtime logging, live
provider revocation, DB/IAM behavior or deployed logout/deletion completion.

Local session semantic regressions assert pilot denial before provider/registration,
inactive-status denial, and early termination after each unauthorized dependency.
Bootstrap/status sample the response clock after awaited effects and reject token
expiry at or beyond that deadline; invalid clocks deny access and throwing clocks
return a sanitized service failure. Signed revoke still requires verification and
its account budget, but neither revocation route uses the status response clock.
The bootstrap response deadline check runs after registration; these stub tests do
not prove that an expired request made no registry mutation. Registry admission,
family expiry and real verifier behavior require their separate evidence. No
production source defect was reproduced by these semantic tests.

Local provider-probe regressions bind GetUser's `sub` to the verified subject,
classify provider revocation separately from outages, and sanitize original error
messages/causes. Missing or mismatched subjects deny authorization; malformed SDK
response shapes fail closed as service failures. Node22 mock timers exercise the
8-second abort signal, cleanup after success/denial/failure, synchronous throws
and independent overlapping probes. The deadline requests SDK cancellation; these
tests do not establish a hard settlement bound for a client that ignores abort,
live Cognito revocation, SDK/network retry behavior or deployed logging. No
production source defect was reproduced by this contract increment.

Local account-verifier input regressions assert that malformed Authorization
headers, including control characters and values exceeding 16,384 characters,
reject before JWT verification, clock sampling or live-session lookup. Valid
boundary controls forward the exact token and return only a frozen principal.
Missing/wrong-type subject, session-family and scope claims deny before registry
access; group permission requires an exact space-delimited scope token. JWT
dependency failures become sanitized unauthorized errors. These synthetic controls
complement the signed JWT tests; they do not establish provider claim issuance,
gateway header normalization, live revocation or deployed logging behavior. No
production source change was needed for these input boundaries.

Local room transport regressions cover all twelve paths, including snapshots,
fix uploads and the four unbudgeted safety actions. Query strings are rejected
before authentication; malformed/non-object bodies, unknown top-level fields and
raw/encoded envelopes over the existing 12,000-character limit are rejected after
authentication but before budget or service calls. Valid raw/base64 JSON retains
argument forwarding and safety-action budget exemptions. The limit applies to the
encoded envelope, so base64 accepts less decoded JSON than raw input. These tests
do not establish canonical base64/strict UTF-8 validation, nested domain validation
or actual gateway request limits/log redaction. No production source change was
needed for these cases.

Alarms cover cleanup failures, hard runtime failures/throttles, backlog, missing
successful runs for three minutes, dropped asynchronous events, EventBridge failed
delivery, room runtime/throttle failures, and API server errors. The last uses the
HTTP API `5xx` metric rather than relying on Lambda Errors, since handled 503
responses are successful Lambda invocations. See [AWS HTTP API metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html).

Supply an existing, monitored London SNS AlarmTopicArn before pilot use. With the
empty default, alarms exist but send no notifications. Check subscriptions and
actual delivery under the deployment operator's authorised workflow; no messages
were sent while preparing this work.

**Retention is not yet proven.** Point deadlines are receipt +14 minutes or room
expiry; TTL is a backup only. A one-minute schedule, index lag, cold starts,
processing time and backlog can exceed a 15-minute physical purge bound. The
retention alarm warns at observed overdue age >=60 seconds; this is an index
observation, not a strongly consistent audit of every physical row. Stale index
entries can cause conservative warnings; an index outage can hide overdue rows.
Cloud validation must measure physical age, adjust the deadline/capacity to leave
sufficient margin, and define outage recovery before native sharing launches.
Account-wide logout/deletion purge and proof of strict ended-room metadata
retention are still open. No alarm settings establish compliance by themselves.

## Local validation and eventual deployment order

1. Run `npm test --prefix services/group-rides` and
   `uv tool run --from cfn-lint cfn-lint services/group-rides/infra/sessions.template.json services/group-rides/infra/rooms.template.json`.
2. Start a checksum-verified DynamoDB Local runtime (Java 17+) on localhost and run
   `GROUP_DYNAMO_LOCAL_ENDPOINT=http://127.0.0.1:<port> npm run test:dynamo --prefix services/group-rides`.
   This suite rejects non-local endpoints and uses synthetic credentials/data.
   It tests 1,050 expired rows: first bounded run deletes 1,000 and reports backlog,
   next run deletes the remaining 50. It does not model AWS index lag/IAM/latency.
3. Build `npm run package:lambda --prefix services/group-rides`. The ignored
   `.artifacts/sessions.zip` includes all handlers under src, runtime dependencies
   and manifest only; it excludes app data/env/test files. Cleanup requires the
   automatic AWS_LAMBDA_FUNCTION_NAME environment value for its metric dimension.
4. Obtain the authorised AWS resource MCP capability. Repository instructions permit
   AWS CLI login for renewing authentication, but require MCP for resource changes.
   No resource tool was exposed in this session; do not work around that with CLI
   or SDK resource calls. Review target account/region and concurrency quotas.
5. Configure/validate Cognito and Apple, then deploy the session stack and verify
   its live registration/status/revocation using signed provider access tokens.
6. Upload the reviewed archive under an immutable S3 artifact key and prepare the
   room stack with existing pool/client/table/function identifiers, a compatible
   ResourcePrefix and monitored AlarmTopicArn. Review the change set, including
   deletion/replacement policies. Apply within the user's authorised scope.
7. Test API paths, wrong token/purpose/client/scope, inactive/blocked families,
   membership removal races, point ordering and actual IAM roles. Prove schedule,
   metrics ingestion and alarms with synthetic fixtures. Validate retention under
   index lag/load/outage recovery and ensure backup policies exclude points.
8. Only after P01 readiness, set the public group API URL for a private signed
   prototype. Wire GPS ownership/recovery and prove two-phone locked-screen sharing
   for 30-60 minutes. WebSockets and full room/map UI remain subsequent work.

## Durable logout route update - 2026-10-15

Both prepared templates now include POST `/v1/session/logout`, forwarded to the
session handler with a path/method-scoped permission and lower route throttle
(1/sec, burst2). POST `/v1/session` requires exactly a logoutSecret body in addition
to signed identity/provider proof. No IAM expansion: hash-bound capability records
use the existing encrypted session table and item permissions. Deploy matching
handler/routes before the updated client. See [wire contract and recovery limits](group-account-logout.md).
No stack has been deployed; preview remains off. Anonymous unknown-capability
requests allocate bounded-lived tombstones; appropriate pilot/edge abuse controls
must be completed before configured builds are distributed.

## Pilot admission and restricted approval writes - 2026-10-15

The session and room handlers now require shared USER approval records with
matching verified subject, active state and finite future pilotExpiresAt. Empty
new stacks deny everyone. Do not replace this with an environment list or treat
an app preview flag/room invite as pilot admission. See
[the operator/withdrawal contract](group-pilot-admission.md).

Session role reads/conditions remain allowed, but writes are now restricted to
SESSION#/LOGOUT# leading keys with an explicit present-key condition. USER grant
writes require separate trusted operator/lifecycle authority; neither runtime can
self-enrol. Live IAM enforcement is still unproven. Room writes now use transactions
that include family/approval checks, using the role's existing ConditionCheckItem
permission on the shared session table. No role expansion or extra table is needed.

Deploy matching artifacts/roles, approve only actual intended tester subjects via
AWS MCP, and test missing/expired/withdrawn/blocked grants and in-flight operations.
Signed/capability logout must still work after withdrawal. These local changes do
not implement the remaining anonymous-allocation/edge/per-user abuse controls.


## Explicit room metadata cleanup - 2026-10-15

New room writes carry `cleanupBucket=ROOMS`, `purgeAt` in milliseconds and the
existing seconds-based TTL. The retention deadline is the earlier of explicit end
and scheduled room expiry plus 24 hours. `purgeAt` starts cleanup one minute before
that deadline; TTL remains at the deadline as an asynchronous backstop. No room
write can extend retention by supplying an end time later than scheduled expiry.

The room table's ExpiryIndex projects only keys, purgeAt and revision, without
members, profiles or invite hashes. The independent room cleaner queries oldest
due rows, at most 1,000 per invocation with eight deletes in flight, checks runtime,
and deletes only if both observed revision and exact purgeAt still match and the
row remains due. Stale-index conflicts are harmless; other failures are sanitised
and monitored. Its role can query that index and delete room rows only. It cannot
read room payloads, access account grants or erase points. Existing point cleanup
continues independently; metadata erasure does not claim immediate point purge.

The separate schedule, concurrency limit, delivery/discard/runtime/backlog/heartbeat
and observed-age alarms mirror point cleanup. Counts are RoomsDeleted/RoomsExamined
under the room worker's FunctionName dimension; no IDs or payloads are logged.
The observed-age alarm at 60 seconds warns at the 24-hour target, but does not
prove physical erasure. Index lag/outage, scheduling, backlog and cold starts can
exceed the one-minute margin; measure and tune capacity/margin before pilot use.

**Migration gate:** old rows without cleanupBucket/purgeAt are absent from the GSI.
No infrastructure is deployed according to the tracker. For a future upgrade of
an existing environment, an authorised operator must inventory and conditionally
backfill these fields from authoritative room metadata (without logging payloads),
or prove the table contains no legacy rows. Deploy matching room writers/index and
worker, wait for index readiness, validate legacy coverage and actual role/alarm
behaviour before claiming retention. The runtime deliberately has no Scan/backfill
permission; do not silently fall back to TTL for legacy rows.

## Logout budget rollout gate - 2026-10-15

The session template now provisions a separate encrypted, no-PITR/no-stream
LogoutBudgetTable and passes LOGOUT_BUDGET_TABLE_NAME to the session Lambda.
The session role has only UpdateItem on LOGOUT_RATE#* there; existing SESSION/LOGOUT
write constraints and USER denial remain intact. Both prepared HTTP APIs invoke
this same Lambda; do not create independent per-gateway budgets. Missing table
configuration fails Lambda construction rather than disabling protection.

Deploy the matching table/role/environment/archive together through authorised AWS
MCP. Prove both API paths share a global 60/minute and per-gateway-source 6/minute
cap, forged forwarded headers cannot select a bucket, and exhausted/unavailable
storage cannot create logout tombstones. Exercise durable client retry on 429/503,
including shared-network riders and minute boundaries. Fixed windows admit boundary
bursts; global exhaustion can delay legitimate server revocation. Retain existing
API Gateway route throttles; their best-effort throttling alone is insufficient.

Counter keys include window-scoped source hashes (pseudonymous, guessable); keep
payload/access logging disabled, restrict operator access and establish actual
privacy retention. TTL one minute after window end is eventual deletion only;
no physical counter retention SLA is claimed. Table replacement/deletion discards
budget state and can reset caps, so validate deployment/recovery behaviour. No
cloud rollout, IAM proof, counter cleanup proof or public abuse review has occurred.
Other S03 per-account/room/fix/edge controls and account lifecycle purge remain open.

## Verified-account budget rollout gate - 2026-10-15

Deploy matching session archive, AccountBudgetTable, prefix-scoped UpdateItem role
and mandatory ACCOUNT_BUDGET_TABLE_NAME together through authorised AWS MCP. Both
HTTP gateway paths must use the same session Lambda/table. Runtime construction
fails without this configuration; do not add optional fallback or substitute the
capability logout table. The table is encrypted, has no PITR/stream, and is deleted
on stack deletion/replacement. Existing USER write denial and room roles stay intact.

Before exposure, prove actual transaction conditions/rollback, concurrent caps,
role isolation, verified identity ordering, both gateway paths, minute boundaries,
timeouts and privacy retention. New localhost-only accountBudget.dynamo.mjs covers
real counter expressions, concurrency, rollback/no denied-row allocation, operation
isolation and reset with old TTL rows retained. It is prepared and syntax checked;
this session's localhost listener failed EPERM, so no DB assertion ran. Cloud
storage/IAM results cannot be inferred from contract fakes or schema lint.

Default pools are independently 60 global / 6 per account per minute for bootstrap
and signed logout; status has its own 600 global / 60 per account per minute pool.
The matching session role must include the exact ACCOUNT_RATE#status#* leading-key
prefix before deploying the new handler. Non-pilot valid JWTs can spend bounded bootstrap capacity, but
cannot pass admission or provider registration. Review capacity for legitimate
refresh/retry traffic; global hot-key conflicts and SDK ambiguity fail closed and
may delay legitimate operations. Verify retries never report confirmed logout on
429/503. Keep existing gateway throttles/source capability limits and release gates.

Per-operation global admission bounds new account rows to 60/window for bootstrap
or signed logout and 600/window for status, plus one global row per pool. Hashes are pseudonymous; disable payload/access logging and restrict operator
access. TTL is eventual, backups must be excluded operationally, and table reset
can reset permits within a minute. Prove recovery/replacement behaviour before use.
Room-operation budgets are described below; provider-login and edge controls,
lifecycle purge, Cognito/Apple and
physical-device validation remain pending; nothing was deployed by this increment.

## Room operation budget rollout (not deployed)

Deploy the matching archive, isolated RoomBudgetTable, RoomRole UpdateItem-only
prefix grant and required ROOM_BUDGET_TABLE_NAME binding together through authorised
AWS MCP. The room Lambda fails initialisation if budget configuration is absent;
there is no in-memory fallback or shared session-counter permission. The encrypted
counter table has eventual TTL, no streams/PITR and delete-on-stack-removal policies.
Neither cleaner nor session runtime receives counter access. No migration is needed
for the new table, but prior room/point legacy cleanup migration remains unresolved.

Before exposure, run the localhost-only integration suite including
`integration/roomBudget.dynamo.mjs`, then prove actual DynamoDB transactions,
conditional rollback, bounded allocation, concurrency, IAM prefix isolation and
both 429/503 paths in the deployed environment. Prove invalid/revoked identities
cannot consume operation permits; prove membership/sequence checks still apply
when a permit succeeds. Measure ten-rider upload cadence/retries against the
600-global/60-account fixed-minute fix cap, contention, cost and denial behaviour.
Review 60/6 create, 120/12 redemption, 600/60 snapshot, 60/6 invite issuance and
120/12 combined start/profile/sharing-enable defaults against pilot usage. Deploy
all six exact ROOM_RATE operation prefixes with the matching adapter/API archive;
old IAM denies new pools and must not be worked around by removing the guards.
The cap is not an edge/DDoS or table-request-cost ceiling: denied attempts still cost work.

Prove stop-sharing/leave/end/member removal remain usable during exhausted pools
and counter-store failures, while session/membership/owner checks remain enforced.
Prove bounded client retry/reconnect handling, no freshness claims for rejected fixes, no identifier or
position logging, TTL physical retention and error/alarm recovery. Global permit
loss or ambiguous failures can conservatively deny legitimate traffic; boundary
bursts remain possible. Counter hashes are pseudonyms requiring privacy handling.
Roll back only as a matching gated stack/archive; never restore an unbudgeted public
handler to recover availability. Keep account preview off and P01/P02/native/device
and provider/deletion gates pending. This is partial S03 local preparation;
dedicated teardown abuse protection,
provider/session-GET/edge limits, fan-out and account-wide lifecycle purge still
need implementation/proof. New snapshot throttles must not keep cached positions
apparently fresh; prove client recovery and UI handling before integration.


Session status rollout addendum (local only): GET must consume verified-principal
status permits before registry.active, on both gateway routes. Prove separate-pool
caps/rollback/no denied-row allocation with real DynamoDB and prefix isolation with
actual IAM. Exercise invalid/inactive/unapproved credentials, status 429/503 and
logout recovery during exhaustion. Shared account-table outages may deny all signed
operations; capability logout retains its separate source budget/table. Measure
legitimate polling/retry traffic before adopting defaults. No new deployment,
provider/device evidence or strict counter-retention claim follows from local tests.

## Account/logout budget failure contracts - local evidence, 2026-10-18

`tests/sessionBudgetFailures.test.mjs` exercises the real account/logout adapters
with synthetic SDK failures and passes them through all four session API paths.
Conditional quota failures in the global or account/source transaction position
produce typed 429 responses. Conflicts, throttles, validation/capacity failures,
unknown/nonconditional reasons and malformed details without a conditional code
deny session effects with sanitized no-store 503 responses. Provider checks,
admission, registration, active-session reads and both revocation methods do not
run after budget rejection. Tests verify one application-level send and no retry,
refund or fallback; they do not inspect retries inside the real SDK.

The ordered cancellation-code fixtures follow the
[AWS TransactWriteItems reference](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).
Malformed fixtures are defensive controls, not claimed AWS response shapes.
Mixed conditional and other failure codes are outside this increment's coverage;
the existing adapters classify any observed conditional code as quota denial.
No production source changed. These tests do not establish actual database
atomicity, SDK/network retry behavior, gateway normalization, deployed IAM,
retention, metric delivery or live-provider/device behavior. All existing rollout
gates remain pending.

## Room budget failure contracts - local evidence, 2026-10-18

`tests/roomBudgetFailures.test.mjs` passes synthetic SDK failures through the actual
room-budget adapter and all eight protected room API paths, plus the room-only
snapshot fallback. Conditional failure in either counter position produces a
sanitized no-store 429 with bounded Retry-After; nonconditional conflicts,
capacity/throttle/validation failures, non-Error rejections and malformed details
without a conditional code deny downstream effects with 503. The adapter tests
check one application send, no completion-clock sampling on nonconditional errors
and fresh typed quota errors without private storage details.

Stop-sharing, leave, member removal and end never call the installed failing
adapter or its clock, while still requiring authorization and forwarding the
verified actor. This proves API ordering with controlled room/location effects;
existing room-engine tests and real DB/IAM acceptance remain separate requirements.
Mixed conditional/other reasons retain existing any-conditional classification and
are outside this increment. Production source is unchanged. These controls do not
prove actual transactions, SDK internal retries, deployed permissions, session or
membership revocation, retention, provider behavior or physical-device operation.
All rollout gates above remain pending.

## Lambda configuration gates - local evidence, 2026-10-18

`tests/lambdaConfiguration.test.mjs` imports the actual session and room entry
points in fresh Node child processes with explicit synthetic environments, without
inheriting shell credentials or configuration. SDK sends, socket connections and
HTTP/fetch calls are guarded. Valid configuration must export a handler without
I/O; missing or malformed required session/room/budget table names and missing
identity prerequisites must reject startup. Malformed pool IDs and existing
room/session/location table collision gates are exercised too. The optional
location table remains optional for a room-only handler; an explicitly empty or
malformed location name fails configuration.

The same isolated suite covers the location and room cleanup entry points.
It requires valid monitoring function names and required storage names before
exporting handlers, rejects all three location/room/session collision pairs, and
checks valid name-length boundaries. Minimal cleanup configurations omit Cognito
and API-budget settings; room cleanup also omits session and location settings.
Imports must perform zero observed SDK sends or guarded network calls. Handlers
are not invoked, so this does not prove scheduled execution, deletion, metric
delivery or alarm behavior in AWS.

These are executable local wiring checks alongside the template/IAM assertions,
not a deployment smoke test. No AWS request, credential resolution, table lookup,
JWT/JWKS fetch, provider login or handler invocation is needed. Successful import
does not establish resource existence, IAM access, usable Cognito configuration,
network connectivity, budget transaction semantics or device behavior. Budget-table
separation continues to be a template/IAM requirement; this coverage does not
claim runtime rejection of every possible cross-table alias. All rollout gates
remain pending.

## Cleanup Lambda handler wiring - local evidence, 2026-10-18

`tests/cleanupLambda.test.mjs` invokes the actual exported location/room cleanup
handlers in fresh processes with explicit synthetic environments and intercepted
SDK sends. It checks paginated Query/Delete command scope against the intended
expiry index/table, conditional deletion versions, point versus room aggregate
metric names, stale-index conditional conflicts and the five-second runtime-budget
boundary. Query/delete failures must stop work and emit only sanitized failure
metrics and entity-specific generic errors without event or SDK error details.
Room cleanup needs no session/location configuration; location cleanup must never
send to those other configured tables. Socket, HTTP and fetch calls are denied.

These controlled adapter responses exercise executable wiring, not DynamoDB or
AWS acceptance. They do not establish SDK internal retries, real query/condition
semantics, IAM, scheduled invocation, physical erasure, CloudWatch/alarm delivery,
provider revocation or device behavior. Deployment and release gates remain pending.

Verification note: the first full backend run alongside root tests/lint/typecheck
hit child-import timeouts in this suite and the existing configuration suite.
All 1,785 backend tests subsequently passed with Node22, running alone from
services/group-rides: `node --test --test-concurrency=2 tests/*.test.mjs`.
No assertions or timeouts were relaxed. Use bounded test concurrency when running
these process-isolated suites on a contended workstation; these are functional
wiring checks and do not measure production cleanup throughput.

Warm-invocation local evidence (2026-10-18): six further scenarios reuse each
actual exported handler for three sequential invocations in one imported module
instance. A first-invocation stop after one page, second-page query failure or
second-page delete failure is followed by two successful calls. Exact commands
and aggregate metrics assert a fresh cutoff/metric timestamp, oldest-entry restart
without a retained cursor, fresh budget context and reset counters/overdue age.
Failure metrics/errors retain the existing redaction boundary. SDK replies are
scripted, including repeated synthetic rows; these tests cannot prove actual
persistence/deletion, AWS runtime reuse or scheduled recovery. No production
source changes or deployment evidence result from this coverage.

## Private Lambda rejection wiring - local evidence, 2026-10-18

`tests/privateLambdaRejection.test.mjs` invokes the actual session/room exports,
constructors and verifier with explicit synthetic child environments, SDK send
interception and socket/HTTP/fetch guards. Eighty request assertions plus two
enclosing tests cover session path/method/query/body rejection, malformed or
absent credentials across signed session operations and every supported room
operation, and malformed JWT rejection before JWKS/network work. Room queries
and unknown paths reject early; known paths retain authentication-before-body
validation (including unsupported methods). No verified principal is injected.
Repeated requests share each imported module instance.

A valid synthetic secret-logout request reaches only the logout-budget
TransactWriteCommand; its controlled SDK failure yields the generic account
service-unavailable response, without exposing the synthetic error/cause. A
subsequent malformed request rejects without another send. All other requests
perform zero observed document/raw DynamoDB/Cognito sends and zero guarded
network calls. No private sentinel or handler stdout log output appears in reports.

These are local negative-boundary composition checks, not successful login,
authenticated room operations, live admission/revocation, AWS/JWKS reachability,
SDK retry, budget atomicity, DB/IAM or device evidence. They do not prove that
arbitrary non-Gateway event objects are accepted safely. Production source is
unchanged; cloud/provider/native/physical-device gates remain pending.

## Signed private Lambda gates - local evidence, 2026-10-19

`tests/privateLambdaSignedGates.test.mjs` invokes the actual session/room exports
with ephemeral synthetic RSA keys and the real Cognito JWT verifier. A test-only
wrapper around its factory initializes the verifier's JWKS cache; verification
and principal creation remain unchanged. Each isolated process has an explicit
synthetic environment, intercepted document/Cognito sends and denied raw
DynamoDB/socket/HTTP/fetch access. Fixed synthetic clock samples make deadlines
and budget windows deterministic; these tests do not measure elapsed time.

Bootstrap cases assert the verified-subject account budget precedes pilot
admission reads, and missing/blocked/expired/mismatched/held admission prevents
provider or registration work. Admitted requests reach exactly GetUser with the
signed access token; provider refusal, subject mismatch or outage prevents all
registration writes and returns a sanitized 401/503. Status and room cases assert
strongly consistent family/user reads, reject unknown/revoked/expired/mismatched
families and denied admission, and fail closed on registry outages. Room denial
occurs before malformed-body validation, room budget or room data access. Active
controls reach signed session status or room body validation. Subsequent denials
and recovery reuse the same handler/verifier without retaining authorization.
Signed wrong-client/scope and tampered-signature cases perform no SDK work.

Exact scripted command order, table/key scope, zero unexpected calls and absent
private error sentinels/stdout logs are checked. Three top-level tests plus 47
request assertions pass against unchanged production source. Synthetic replies
do not establish DynamoDB condition/transaction semantics, IAM, successful
bootstrap persistence, live Cognito/JWKS connectivity/revocation, SDK retries,
Apple deletion, deployed behavior or physical-device acceptance. All existing
rollout gates remain pending.

Signed bootstrap registration evidence (2026-10-19): the same signed-gate suite
now follows matching GetUser identity through the actual session export and
registerWithLogout adapter in 22 further request assertions. Positive new-family
and existing-binding controls check the admission condition, hashed family/logout
binding transaction and original family deadline. Conditional/transaction conflicts
retry with fresh reads; a revoked capability returned after a conflict denies
registration. Six conflicts exhaust the bounded retry loop; nonretryable
cancellation and read/write outages produce sanitized service-unavailable responses.
Revoked/mismatched capabilities, revoked families, changed logout binding and a
new lifecycle hold deny before writing. Controlled clock advancement during reads,
writes and a conflict rejects expired token/admission success; a live post-write
control returns the advanced server time. Subsequent successful and revoked
requests reuse the same handler/verifier. Exact SDK call order, transaction scope,
zero unexpected SDK/network calls and absent private error/stdout output pass.

Clock resets between synthetic scenarios deliberately isolate request deadlines;
clock advancement is injected at SDK boundaries and does not measure elapsed time.
Scripted reads/writes do not establish actual transaction conditions, persistence,
atomicity, concurrent logout, SDK retries, IAM or successful live login. Production
source remains unchanged. Existing DB/cloud/provider/native/device gates remain.

## Exported capability logout - local evidence, 2026-10-19

`tests/privateLambdaLogout.test.mjs` invokes the actual sessionLambda export in an
isolated process with an explicit synthetic environment and fixed clock. Exact
scripted document SDK expectations admit the shared logout budget before reading
only the hashed capability key. Unknown capabilities receive conditional tombstones;
live known capabilities atomically request a tombstone and a subject/logout-binding
conditioned family update. Expired capabilities do not update the family. Assertions
check table/key scope, conditions, deadlines, TTL and exact command ordering.

Twenty-two request scenarios cover missing/invalid bearer credentials, already
revoked capabilities, conditional/transaction conflict rereads, newly bound families,
six-attempt exhaustion, nonretryable cancellation, read/write failures, invalid
stored deadline, controlled post-read deadline advancement, denied/stale budgets,
Gateway-only source selection and subsequent warm success/idempotent responses.
Successful responses expose only `{ revoked: true }`. No account-budget, USER or
family reads, Cognito/raw DynamoDB sends, guarded socket/HTTP/fetch calls, private
error sentinels, raw capabilities or handler stdout output are observed.

Production source is unchanged; no defect reproduced. Scripted replies do not
prove persistence, real concurrent registration/logout, DynamoDB condition or
transaction semantics, SDK retries, IAM, elapsed-time behavior, provider revocation,
cloud deployment or device acceptance. Warm scenarios reuse one handler but receive
explicit scripted storage state; they do not prove persisted idempotency. Existing
DB/cloud/provider/native/physical-device gates remain pending.

## Exported signed session logout - local evidence, 2026-10-19

`tests/privateLambdaSignedGates.test.mjs` now exercises signed DELETE /v1/session
through the actual sessionLambda export and real cached-JWKS signature verifier.
Nineteen new request assertions check the exact isolated logout account/global
budget transaction followed by the hashed-family conditional revocation update.
The update permits an absent row or the verified subject, requests a revoked
state, and sets the revocation deadline/TTL. Repeated warm requests make the same
conditional update without requiring provider, admission, active-family or logout-
capability reads. There are no SDK reads in these scenarios.

Global/account quota refusals, budget outage and a permit crossing its window
prevent the family update. Conditional update refusal and storage outages produce
sanitized service errors without application retry. Wrong client/scope/issuer/token
purpose, expired signature claims, missing family and tampered signatures perform
no SDK work. A completed update can acknowledge revocation after token expiry
during that update; a subsequent request must verify its credentials and budget
again. Exact commands, conditions, values and response headers/body are checked;
Cognito/raw DynamoDB/network guards and private-output checks remain enabled.

Expanded suite PASS93 (five top-level plus 88 request assertions) on unchanged
production code. No defect reproduced. Scripted update replies do not prove unknown
or repeated-family persistence, real DB conditional semantics, atomicity, IAM,
SDK retries, provider revocation, elapsed-time behaviour or deployed/device results.
Warm scenarios share one handler/verifier but do not emulate durable storage.
Existing DB/cloud/provider/native/physical-device gates remain pending.

## Exported signed status post-I/O gates - local evidence, 2026-10-19

`tests/privateLambdaSignedGates.test.mjs` adds 27 signed GET /v1/session request
assertions through the actual sessionLambda export, real cached-JWKS verifier,
account budget and live registry adapter. Controlled completion of either strongly
consistent family/user read at one millisecond before, exactly at and one
millisecond after each token, family and pilot deadline checks live controls and
fail-closed boundaries. Both reads are requested and exact hashed keys/table scope
are checked. Lifecycle holds returned with delayed reads deny status. A family
read outage returns only the sanitized service-unavailable response.

The exact status-specific global/account budget transaction (600/60 limits) is
checked. Global/account quota refusal, budget outage and a permit crossing its
original window prevent registry reads. Warm recovery reuses one handler/verifier;
a subsequent held admission still denies access. Guards reject unexpected SDK,
provider, raw DynamoDB and socket/HTTP/fetch work; response bodies/headers and
absence of private error sentinels/stdout logs are asserted.

Expanded suite PASS121 (six top-level plus 115 request assertions) on unchanged
production source; no defect reproduced. Synthetic clock advancement and scripted
read state do not establish elapsed-time behavior, concurrent hold/read ordering,
DynamoDB read/transaction semantics, IAM, persistence, SDK retries, live provider
revocation, deployment or physical-device acceptance. Existing rollout gates remain.

## Exported signed room post-I/O gates - local evidence, 2026-10-19

`tests/privateLambdaSignedGates.test.mjs` adds 25 signed room requests through
the actual roomLambda export, real cached-JWKS verifier and live session registry
adapter. Controlled completion of either family/user read one millisecond before,
exactly at and one millisecond after token, family or pilot expiry checks the
composed authorization boundary. Live controls reach the deliberately malformed
body and return INVALID_BODY; expired requests return UNAUTHORIZED before body
validation. Exact strongly consistent hashed-key reads are asserted, with no room
budget, room data, provider or other SDK work permitted by the harness.

Returned lifecycle holds deny access even with otherwise live deadlines. Either
read outage produces a sanitized unauthorized response. Subsequent warm recovery,
newly held admission and recovery again reuse one handler/verifier. Explicit
synthetic child environments, raw SDK/network guards, exact response/header checks
and private error sentinel/stdout checks remain enabled. Expanded suite PASS147
(seven top-level plus 140 request assertions) on unchanged production source.

No production defect reproduced. Controlled clock samples and scripted replies
do not prove actual elapsed time, concurrent hold/read ordering, DynamoDB read
semantics, persistence, IAM, SDK retries, provider revocation, deployment or device
acceptance. The malformed-body controls deliberately stop before authorized room
operations; these scenarios establish the preceding authorization gate only.
Existing DB/cloud/provider/native/physical-device gates remain pending.

## Exported signed room-create budget composition - local evidence, 2026-10-19

`tests/privateLambdaSignedGates.test.mjs` adds 40 signed POST /v1/rooms requests
through the actual roomLambda export, real signature verifier, room budget and
live registry adapter. Empty JSON controls spend the create permit, recheck the
family/admission, then return INVALID_ROOM without accessing room storage. Exact
transaction table, create scope, hashed subject key, global/account limits 60/6,
conditions and TTL values are asserted. Global/account refusal returns 429;
budget outage and stale permit return sanitized 503 before renewed reads.

Token/family/pilot deadlines during budget I/O and either renewed registry read
are exercised at -1/0/+1 milliseconds. Expired credentials deny room validation;
token expiry before the renewed check prevents its reads. Newly revoked families
and lifecycle holds deny, while renewed-read failures return sanitized service
errors. Warm recovery, subsequent quota refusal and a new hold share one cached
handler/verifier. Exact response bodies/headers and SDK order are checked, with
unexpected room/provider/raw SDK/network work and private sentinel/stdout output
forbidden. The synthetic clock is anchored within a minute to avoid accidental
budget-window crossings in short deadline scenarios.

Expanded suite PASS188 (eight top-level plus 180 request assertions) on unchanged
production code; no defect reproduced. Scripted reads and transaction replies do
not prove durable state, concurrency, real DynamoDB semantics, IAM, SDK retries,
elapsed time, provider revocation, deployment or device acceptance. Controls stop
before valid room creation. DB/cloud/provider/native/device gates remain pending.

## Exported signed valid room-create composition - local evidence, 2026-10-19

`tests/privateLambdaSignedGates.test.mjs` adds 13 valid signed free-ride requests
through the actual roomLambda export, signature verifier, budget, registry,
room service and metadata store. Exact three-item metadata transaction asserts
conditional room creation plus family and admission checks (including absent
lifecycle hold), hashed keys, verified owner, initial non-sharing membership,
creation fingerprint and scheduled cleanup/TTL. Default twelve-hour and minimum
one-minute durations are covered; raw credentials and coordinates are forbidden.

Write outages, access denial and unexplained transaction cancellation return
sanitized 503. Conditional cancellation triggers fresh session checks: returned
revocation/hold denies before room read; matching retained creation acknowledges,
missing room returns 404 and differing fingerprint returns 409. Warm recovery
and subsequent failure use the same verifier/handler. Exact responses, SDK order,
network/raw-SDK guards and absent private sentinel/stdout output are checked.
Expanded signed suite PASS202 (nine top-level plus 193 request assertions),
installed Node22.22.0; production unchanged, no defect reproduced.

These are scripted command/reply assertions, not database execution, durable
creation, concurrent transaction ordering, IAM, SDK retry, cleanup, deployment,
provider or physical-device evidence. External acceptance gates remain pending.

## Exported signed metadata-only snapshot composition - local evidence, 2026-10-19

`tests/privateLambdaSignedGates.test.mjs` adds 39 signed GET requests through the
actual roomLambda export, real signature verifier, snapshot budget, location
service and snapshot store. Exact budget transaction checks the isolated snapshot
pool, limits and hashed verified-subject key. Exact consistent discovery and
five-item transactional read bind the room, viewer family/admission and two
non-sharing members' point keys; absent points produce a metadata-only roster.
The response excludes internal consent/session fields, invite and command data.

Coverage includes global/account quota refusal, budget outage/stale permit,
missing/ended/expired room or absent viewer at discovery and transactional read,
fresh viewer revocation/admission/hold rejection, and token/family/pilot deadlines
immediately before, at and after expiry during the atomic read. Read failures are
sanitized; revision churn requests rediscovery six times then returns ROOM_BUSY.
Warm-handler recovery and subsequent denial retain exact response/SDK order and
network/raw-SDK/private-output guards. Expanded suite PASS242 (10 top-level plus
232 request assertions), installed Node22.22.0. Production unchanged; no defect
reproduced.

Scripted SDK replies and clock samples do not establish DynamoDB transaction
semantics, concurrent membership ordering, elapsed-time/retry behavior, IAM,
persistence, deployment or physical-device behavior. Fixtures contain no fixes;
source-sharing grants and visible/stale point delivery need separate evidence.
DB/cloud/provider/native/device acceptance gates remain pending.

## Exported signed source-grant reads - local evidence, 2026-10-19

`tests/privateLambdaSignedGates.test.mjs` adds 25 real signed GET requests for
sharing rosters with absent points. Exact atomic reads cover viewer-only,
peer-only and combined sharing: viewer source reuses both viewer grant keys;
an alternate viewer device adds only its family key; peer sharing adds its own
family and admission keys. Internal device/session/consent fields remain absent
from the exact metadata-only response, including with missing/revoked/expired/
mismatched source grants, blocked admission or lifecycle holds. Controlled source
family/admission deadline samples return the roster without points. Shared viewer
family revocation and viewer holds still deny the request; alternate source grants
do not override them. Read outage sanitization and warm recovery remain covered.

Installed Node22.22.0 focused suite PASS268 (11 top-level plus 257 request
assertions), zero failures/skips. Production unchanged; no defect reproduced.
Absent-point fixtures establish requested grant composition and metadata privacy;
they cannot distinguish successful source authorization from point suppression,
or prove visible/stale-point delivery. Scripted replies/clock samples establish
no DynamoDB semantics, persistence, concurrency, IAM, retries, elapsed-time,
deployment, provider or physical-device behavior. External gates remain pending.

## Exported signed snapshot revision recovery - local evidence, 2026-10-19

`tests/privateLambdaSignedGates.test.mjs` adds 20 real signed GET requests through
the exported room handler. Per-discovery scripted replies first return a different
atomic room revision, then allow rediscovery with changed sharing/device grants.
Exact transaction assertions cover adding/removing peer source grants, adding/
removing an alternate viewer family while deduplicating admission, and replacing
a peer family key. Success returns the new revision and sanitized sharing roster.
Retry viewer revocation, absent/blocked/expired/mismatched admission or family,
lifecycle hold, viewer removal, token/family/pilot deadline and read outage fail
closed. A subsequent warm request succeeds without retained retry state. Budget
work occurs once per request; exact SDK order and network/raw-SDK/private-output
guards remain enforced. Installed Node22 focused suite PASS289 (12 top-level plus
277 request assertions), zero failures/skips. Production unchanged; no defect
reproduced.

Absent-point fixtures establish rebuilt grant reads and metadata privacy, not
visible-location authorization. Scripted replies/clock samples establish no real
DynamoDB transaction/concurrency, persistence, IAM, retries, elapsed-time,
deployment, provider, native or physical-device behavior. External gates remain
pending.
