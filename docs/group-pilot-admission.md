# Private group pilot admission

Identity/session/native bridge and controlled enrollment are now deployed
(2026-10-19). First real tester approved on2026-10-20 with explicit user
authorization; active mappings/grant verified read-only, expiry2026-10-21
12:06:41 Europe/London. Local account preview enabled; live sharing and physical
account lifecycle acceptance remain pending. See the [native enrollment workflow](group-native-apple.md)
for the manual MCP operator review/approval command. Follow
[the shared tracker](group-rides-implementation.md) and
[deployment preparation](group-rides-deployment.md).

## Server-owned approval

Valid Cognito identity, a room invite or an enabled app preview does not confer
pilot access. Every participant needs a matching, active, unexpired USER record
in the existing encrypted session table. Its field contract is:

| Field | Meaning |
| --- | --- |
| pk | `USER#` followed by SHA-256 of the verified Cognito subject; use `userKey(subject)` from the registry |
| subject | That same verified Cognito subject |
| state | `active`; a blocked or other status denies participation |
| pilotExpiresAt | Finite Unix-millisecond approval deadline, strictly after server request time |
| lifecycleHold | Must be absent; any present value denies admission, even with active approval |

Missing/legacy/malformed records deny access. Email, nickname, motorcycle choice,
body IDs and room invitations cannot create approval. There is no wildcard or
public-mode environment fallback. The grant is shared by session and room runtimes,
so independent deployment stacks cannot maintain conflicting environment allowlists.

Only a trusted operator/provider-lifecycle workflow with separate AWS authority
may create or change USER records. The app has no approval endpoint and no AWS
credentials. The session runtime's prepared IAM policy allows reads/conditions but
limits PutItem/UpdateItem to SESSION# and LOGOUT# partition keys, with an explicit
LeadingKeys-present condition. The room runtime can only read/check this table;
cleanup cannot read/write it. The registry's internal blockUser helper is for a
separately authorised lifecycle/operator context; it is not a public session API
and is no longer writable under the session Lambda role.

This follows [AWS's DynamoDB condition-key model](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html)
and [item permissions for transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).
CloudFormation schema validation and local policy assertions do not prove actual
AWS IAM enforcement; test using the deployed execution roles before the pilot.

## Enforcement and withdrawal

Bootstrap verifies the JWT before looking up its subject. Non-approved accounts
are denied before a Cognito GetUser probe or session/capability writes. Registration
then atomically checks approval again with the family/capability write, closing a
withdrawal between preflight and persistence. Refresh registration cannot self-enrol.

Session status and private room authorisation require current approval. Room
creation and mutations also condition on the verified actor's live family/account
approval in the same DynamoDB transaction as metadata and any point deletions.
The storage adapter requires both registry and actor; it has no unconditional
Put fallback. Conflicts retry through live service checks. Successful duplicate
creation rechecks the principal rather than treating a rejected transaction as
proof of continued access.

Location publication atomically checks the current approval with room revision,
consent, epoch/family and point version. Snapshots atomically read approval for
both the viewer and each sharing source. An unapproved viewer receives no snapshot;
a withdrawn/expired source has fix null. Strong reads and transactions are used;
there is no approval cache in a warm Lambda. Deadline comparisons use server
request time; cloud clock/network latency still needs validation.

Withdraw ordinary pilot participation by setting pilotExpiresAt to zero or deleting an
unheld USER grant. Both operator writes must atomically require hold absence;
never delete or replace a lifecycle-held row. A blocked USER status also denies participation. For explicit in-flight withdrawal use
zero, deletion or blocked state, rather than an operator-clock "now" deadline: an
operation already stamped with an earlier server request time can precede that
new timestamp. Natural scheduled expiry is checked against server request/read time. This denies further protected
operations and hides source points, but does not yet delete memberships or every
physical coordinate immediately. Existing point cleanup is the fallback, with
cloud retention unproven. Reapproval can resume an otherwise active unexpired
family; it never revives a family already tombstoned by logout/revocation. For
permanent removal use session/account revocation and the future lifecycle purge
workflow, not only a temporary pilot deadline change.

Sign-out remains available after withdrawal. Signed DELETE `/v1/session` verifies
its bearer proof without requiring admission; the revocation-only secret endpoint
also remains usable. Neither path grants room access. Native socket teardown and
account-wide room/point purge remain separate implementation tasks.

## Operator and release steps

1. Finish the supported Apple/Cognito identity setup. Identify each intended tester
   by their actual Cognito subject from the trusted provider/operator workflow;
   never approve an account solely by matching email or a client-supplied ID. A
   first Apple login may create a Cognito user while group bootstrap is denied.
   Pilot onboarding/identity matching must be resolved with the operator before
   distributing configured builds. Do not ask riders to paste access/refresh or
   logout secrets into chat/logs.
2. Through authorised AWS MCP, inspect the exact target account/region/session
   table and prepare a USER grant with its verified key/subject, active status and
   explicit expiry. Do not overwrite a blocked/tombstoned user as routine enrolment;
   resolve lifecycle state first. The write itself must condition on hold absence
   and a matching-subject active row (or an absent row), for example
   `attribute_not_exists(pk) OR (subject = :subject AND #state = :active AND attribute_not_exists(lifecycleHold))`.
   A preflight read alone cannot prevent a lifecycle hold racing the grant.
   Never delete or overwrite a hold to enrol/reapprove a tester. The internal
   non-expiring hold currently has no release path; event coalescing, retention
   policy and real DB/IAM enforcement remain pending. First authorized grant and read-only verification completed2026-10-20; see tracker.
3. Keep grants under operator control. If TTL is configured on a USER row, document
   its retention separately; logical pilot expiry is independent of TTL and cannot
   be extended by physical deletion. Missing rows deny access.
4. Deploy matching session/room artifacts and restricted roles. Verify that neither
   runtime role can modify USER records, and that both read the same table. A new
   deployment with no USER grants denies everyone, deliberately. Existing prototype
   records without pilotExpiresAt need explicit operator admission before use.
5. Live-test approved/unapproved/blocked/expired users; withdrawal during register,
   create/join/profile/end, publication and snapshot; source hiding and continuing
   sign-out; role permissions, failure/latency and clock behaviour. Local DynamoDB
   tests cover these transaction races using synthetic fixtures only.
6. Implement edge/per-source and per-account abuse controls before exposure. Pilot
   admission is authorisation, not rate limiting. Anonymous unknown-secret logout
   requests still allocate bounded-lived tombstones; admission cannot be required
   there without breaking sign-out for removed pilots. Current route throttles
   alone do not settle this cost/abuse gate. No public launch claim is made.
