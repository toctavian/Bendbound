# Group rides and accounts: current handoff

Updated 2026-10-22. This file replaces the accumulated implementation diary.
It contains the current state, remaining scope and instructions for continuing.
The [feasibility PDF](../output/pdf/bendbound-group-ride-feasibility-report.pdf)
is background research; this file governs the next work.

## Current position

22 October machine identity COMPLETE: the 06:00 Mac schedule now uses
`bendbound-research` via IAM Roles Anywhere and the official MCP. Two fresh
credential sessions, scoped S3 transfer/cleanup and fixed SSM server verification
passed without browser login. Full publisher no-change smoke passed separately;
live ratings unchanged. Generic shell/secrets/out-of-prefix access is denied by
IAM simulation. 39 research/security tests, lint/typecheck passed. Manual prompts
retain the existing `bendbound` browser login. Certificate expires 22 October 2027;
renew by September 2027. Evidence and maintenance:
[identity operations](routing-research-machine-identity.md). No identity work pending.

22 October research handoff: COMPLETE and ratings published at 10:51 BST.
20 pages parsed; 13 supported recommendations applied to 13 sections; seven pages
withheld (four unmapped, three disputed). No historical corrections needed today.
Active overlay has 128 guide-recommended sections. Remote checksum, five regional
routes and cone checks passed. 33 research tests, lint/typecheck passed.
User-approved standing rules now use one reviewer, automatically publish supported
items and historical corrections, quarantine disputed items and log every delta.
No second review/model run was used to release today's already-reviewed subset.
06:00 Mac schedule verified. Initial publication used browser AWS renewal; the
subsequent machine-identity setup above removes that dependency for scheduled
publication. No batch work remains pending. Exact live checksum,
receipts, rollback and rules: [UK routing handoff](uk-routing-expansion.md).

22 October mapping rule: daily research/review now checks available publisher
maps and GPX to identify exact road sections. Existing unresolved pages may be
followed up without counting them as new or duplicating credits. Source URLs and
matching rationale are retained; full tracks are not redistributed. Prompt/policy
change only; no additional research or rating publication was run for this rule.

Routing backend update21October: UK graph and ratings deployed and public HTTPS
verified on the existing instance/disk. No app rebuild required. Deployment evidence,
rollback and local daily-research publication status: [UK routing handoff](uk-routing-expansion.md).
Group/account acceptance scope below is unchanged.

Octavian reports successful native Apple sign-in on the physical iPhone (screenshot
shows an active account). This establishes the first login UI/session result;
refresh/logout/deletion and two-phone sharing acceptance are still pending.
The screenshot showed an **account**, not an existing riding group.

On 2026-10-20, Octavian requested group creation **after route generation**, beside
Add / edit stops and Share route. Implemented that route-preview Group ride button
and modal: signed-out Apple account panel; editable rider name; signed-in Send invite;
actual private lobby creation, host/member roster, refresh, profile update, end/leave.
Profile keeps account/security management; its old unavailable Group rides row was
removed. Profile identity is dynamic rather than hardcoded Octavian.

Apple FULL_NAME is now requested, retained as display-only metadata through pilot
approval and applied after verified Cognito identity. Existing authorizations may
not return a name; enter/save a rider name once. The saved display name survives
refresh and subsequent login, bound to the verified subject. A name never becomes
the authentication ID or confers approval. Real name auto-delivery still needs device
acceptance; do not revoke the user's Apple authorization merely to obtain a name.

**The lobby API is deployed; live location sharing remains disabled.** Room stack
`bendbound-group-pilot-rooms` UPDATE_COMPLETE, EnableServices=true, LobbyOnly=true.
Endpoint: `https://9mwgvao1zk.execute-api.eu-west-2.amazonaws.com`.
Anonymous/invalid-bearer create/read/invite/start401 + no-store verified. Authenticated
start/sharing/fix operations are blocked in lobby-only mode; no coordinate adapter
is constructed. Three room/cleanup functions Active/Successful with matching artifact
hashes. IAM simulation denies room-role USER grant writes/deletes. Actual empty room
cleanup invocation succeeded. Physical create/invite/join still needs validation.

Invites use `bendbound://group/<id>#invite=<capability>&route=<shareId>` and the native
share sheet. Tokens stay in the fragment/in-memory state and POST bodies, never in
HTTP query strings or saved lobby state. Recipients explicitly sign in, join, then
open the invited route. Existing app installation and pilot approval required.
The optional route share is a separate90-day planning link; it is **not** an
immutable authorised room route snapshot. Server routeSnapshotId stays null; riders
navigate independently. New host invites replace the prior token; invites expire
within one hour, rooms within12 hours, at most10 riders. No automatic GPS sharing.

## Preferred iOS workflow

21 October archive preparation: repaired `Missing package product 'MapLibre'` by
resolving workspace Swift packages with Xcode. Pinned MapLibre6.31.0 checkout and
device XCFramework restored; Release `-showBuildSettings` succeeds. Lint/typecheck
pass. No native references or package versions changed. 22 October recheck: Xcode Organizer shows build10 archived on21 October and
uploaded to Apple at14:23. Separate App Store validation and physical group
acceptance were not established by this recheck.

Always use local Xcode for builds, Run, archives and distribution. No new EAS build
was started. Local `.env` enables the account pilot and includes the separate public
lobby endpoint. Metro is running on8081 and serves the new iOS bundle; relaunch/reload
the app to receive it. Xcode Debug requires Metro on the reachable Mac; Archive
embeds JS. Existing dependency/path and React Debug binary repairs remain in place.
Do not regenerate native projects or switch workflows merely for these JS changes.

First tester's one-day approval expires **2026-10-21 12:06:41 Europe/London**.
Read-only review verified active mappings and grant after explicit authorization;
no user identifiers or request capabilities are saved here. Login recovery that
worked is recorded in personal/project AGENTS.md. No new tester approval or expiry
extension was applied in this session.

## Next work, in order

1. **Environment and access restored (2026-10-19).** AWS login and configured MCP
   resource calls verified; localhost DynamoDB runs here. Reuse that connection.
   If AWS access fails, renew/check login FIRST per global/repository AGENTS.md,
   then retry MCP; do not diagnose a missing connector before authentication.
   AWS CLI login may restore authentication; resource operations must use MCP.
2. **Database validation completed locally on 2026-10-19: 115/115 PASS.**
   Do not repeat this step without relevant changes or a failure. For future changes,
   use Node >=22.13.0 and run
   the existing DynamoDB integration suites in a listener-enabled environment.
   Resolve actual failures before rollout. Verify transaction/concurrency, cleanup
   and IAM assumptions; fake-client tests do not establish these. If the environment
   prevents this, record the concrete blocker and required environment, then stop
   that task instead of adding more simulated cases.
3. **Finish P01/A01–A07/B01 for a private prototype.** The native Apple → Cognito
   bridge, controlled enrollment and provider recovery/cleanup are deployed.
   Account self-deletion intake/purge orchestration is deployed. Prove signed
   login/refresh/logout and Apple deletion/revocation proof. Follow [the native handoff](group-native-apple.md);
   the deployed hosted provider does not implement this bridge. Apple identifiers and signing key
   are configured; do not recreate them. London Lambda capacity is now 1000;
   verified again via AWS MCP GetAccountSettings on 22 October 2026 after the
   support confirmation (975 unreserved, 25 allocated to reservations).
   The old quota block is cleared; 1001 is not required for the current prototype. Room/location storage exists; its group services
   are disabled. Prove real
   login, verified identity, refresh, logout, server revocation and the Apple
   deletion/revocation path. Keep pilot admission closed except for explicitly
   approved testers. Do not expose unfinished deletion/lifecycle handlers.
4. **Validate the route-preview lobby and prove the smallest P02/P04 slice.**
   First test create/invite/join/refresh/end/leave and rider-name persistence on iPhone.
   Lobby-only mode must stay enabled until the live-sharing acceptance gates pass.
   Then produce a signed iOS build;
   connect two approved users; publish a recent authenticated fix and display it on
   the other phone. Wire GPS recording/sharing ownership without breaking recording.
   Verify locked-screen credential access, 30–60 minutes of sharing, interruption,
   reconnect and battery impact. Record actual device/build/backend evidence.
   A minimal private test screen is sufficient; the full group UI comes later.
5. **After P01/P02 pass, finish live transport and peer map UX.** Implement remaining
   B/M tasks below, including selected motorcycle markers, using the proven path.
   Complete privacy/operational acceptance before a capped TestFlight pilot.

**Stop rule:** choose one delivery step and state its acceptance condition before
editing. Add tests for that change or a reproduced defect. Do not invent another
coverage matrix merely because access/device work is blocked. If the next step
needs unavailable access or user/device interaction, leave a concise blocked
handoff naming the dependency and owner. Do not repeatedly resume the same block.

## Delivery gates at a glance

- [x] Native Apple/Cognito bridge and controlled tester enrollment deployed.
- [x] Encrypted provider exchange journal/private revocation deployed.
- [x] Self-deletion hold/outbox, status receipts, account purge and scheduler deployed.
- [x] Room/point storage and private lobby API deployed; live-sharing operations disabled.
- [x] Account deletion UI and protected receipt implemented; iOS bundle exported.
- [x] Private EAS project/profile prepared; credentials/server files excluded.
- [x] Signed iPhone pilot build finished; IPA signature, bundle identity and native Apple entitlement verified for one registered phone.
- [x] Physical Xcode installation, native pending reference and subsequent sign-in reported by Octavian.
- [x] First real tester approved for one day; independent active-grant review passed.
- [x] Native login/account activation reported on iPhone.
- [x] Route-preview lobby/invite client implemented; backend deployed with lobby-only guard.
- [ ] Physical lobby create/invite/join/name persistence proof.
- [ ] Remaining P01 refresh/logout/deletion proof on the iPhone.
- [ ] Two-iPhone P02/P04 prototype and locked-screen/battery proof.
- [ ] Remaining room/transport/map UX and privacy/operational release acceptance.

## What already exists locally

| Area | Existing implementation / starting points | Evidence limits |
| --- | --- | --- |
| Account client | `src/services/auth/`: native Apple sheet/client, Cognito refresh, SecureStore session management, group session client, provider revocation; `src/components/AccountPanel.tsx`, `src/app/auth/`, `src/hooks/useAccountSignOutRecovery.ts` | Native client and Apple verification/code-exchange helpers local; Server bridge deployed; controlled enrollment and signed login/deletion pending |
| Logout recovery | Durable pending intent, revocation-only capability and launch/foreground retry | See [logout contract](group-account-logout.md); cloud/device proof pending |
| Identity and sessions | `services/group-rides/src/authorizer.mjs`, `providerProbe.mjs`, `sessionRegistry.mjs`, session API/Lambda | Session API deployed; live unauthenticated denials verified, authenticated lifecycle proof pending |
| Private rooms and locations | `rooms.mjs`, `roomStore.mjs`, `roomApi.mjs`, `roomLambda.mjs`, `locations.mjs`, `locationStore.mjs` | Room/invite/sharing/epoch rules, atomic latest-point write/snapshot foundations; DynamoDB Local suites pass, cloud IAM and end-to-end delivery pending |
| Abuse and cleanup | Account/logout/room budgets; cleanup stores/workers/Lambdas | Local code/tests exist; trusted ingress, production limits and cleanup/retention proof remain open |
| Lifecycle orchestration | Atomic deletion hold/outbox, receipt API, scheduled account worker with embedded hold-bound room coordinator, account/Cognito purge and independent Apple cleanup | Deployed; real user deletion/provider proof, notifications, operator recovery and metadata-retention policy/sweeper remain pending |
| Upload and clocks | `src/services/groupUpload.ts`, `src/utils/groups/` | Utilities exist; continuous real GPS/sharing and measured device timing not proved |
| Infrastructure | `services/group-rides/infra/`, `package-lambda.mjs` | Identity/session/artifact stacks deployed; uploaded code checksum verified; room/progress storage + deletion services and lobby API deployed; live sharing disabled; actual capacity 1000 |
| Map/recording reuse | `RideMap.tsx`, `MotorcycleGlyph.tsx`, `src/data/motorcycles.ts`, `rideTracking.ts`, `rideStore.ts` | Existing local rider artwork and recorder; full peer map integration unfinished |

## Constraints that must survive implementation

- iOS-first; private invite-only groups, at most 10 riders; suggested room limit
  12 hours. Android group launch, chat, public discovery, guest accounts, permanent
  peer tracks and collaborative editing are outside this release.
- Use the native Apple sheet, as confirmed by Octavian on 2026-10-19. Exchange
  verified Apple authorization on the server for Cognito sessions; the bridge is
  deployed, with native user acceptance still pending. See [native delivery contract](group-native-apple.md). Do not
  substitute a raw native Apple token for a Cognito user-pool session. Derive
  identity from verified issuer/audience/signature/purpose/expiry and provider
  subject, never a client-supplied user ID or email match.
- Keep ordinary planning, local recordings, tours and settings usable without an
  account. Sign-in/out must not upload or delete local data implicitly.
- Shared routing tokens do not authenticate users. Server secrets belong in
  Secrets Manager, never `EXPO_PUBLIC_*`. Never log secrets, invite capabilities,
  provider material or rider coordinates.
- Preserve explicit server-owned pilot approval: missing, blocked or expired
  USER grants deny access. Runtime session roles cannot grant approval. Preserve
  live session, membership, sharing-consent, source/viewer and lifecycle-hold checks.
- Account withdrawal/logout/deletion must not revive old families or membership.
  Preserve hold-incarnation fencing across retries; terminal traversal alone must
  not release a hold or acknowledge deletion. Confirm physical purge, provider
  revocation and orphan reconciliation before declaring lifecycle completion.
- Each rider controls sharing. Recording and sharing consume one GPS producer
  independently. Send only the newest recent fix; never replay a recording backlog
  or relabel an old capture as fresh using receipt time. Preserve epoch/sequence,
  clock-skew and wire-age checks.
- Store latest peer location only. Stop/leave/end must revoke access and trigger
  cleanup; target missed-coordinate purge within 15 minutes and ended-room metadata
  expiry within 24 hours. TTL alone is not timely physical-deletion evidence.
- Use a fixed versioned route snapshot or free ride; each rider navigates
  independently. Do not snap peers to the local route or animate stale movement.
- P01/P02 evidence gates live location sharing and full peer map integration. The explicitly requested route-preview lobby can operate separately. Simulator, mocks and Expo Go cannot
  prove locked-screen reliability. Consult matching Expo SDK 57 docs before native
  API changes. Do not weaken privacy/security gates to get a demo working.

## Remaining task checklist

All entries remain pending until their full acceptance is evidenced. Local code
in the table above is partial implementation, not a reason to rebuild it.

| Phase | Pending tasks |
| --- | --- |
| Prototype | P01 live identity/refresh/logout/Apple deletion; P02 authenticated two-device locked-screen sharing; P03 final protocol including clock/route semantics; P04 keychain/background/cold-launch/battery decisions |
| Accounts | A01 Apple configuration and signed login UX; A02 provider/token verification; A03 secure storage/refresh/reuse/revocation; A04 HTTP/WebSocket authorisation; A05 complete logout; A06 account deletion and provider lifecycle; A07 secrets/IAM; A08 local-data preservation |
| Backend | B01 isolated deployment; B02 room lifecycle/roles/idempotency; B03 secure invites and immutable route; B04 publication/read/recipient authorisation; B05 WebSocket registry/snapshot/deltas/reconnect; B06 payload/fix/clock/epoch/sequence validation; B07 physical retention/cleanup/backups; B08 heartbeat/connection cleanup/room expiry |
| App | M01 independent GPS consumers; M02 foreground transport/background HTTPS; M03 room/lobby/consent/host controls; M04 invite links/QR; M05 selected `motorcycleType` markers and updates; M06 peer motion/Fit group/member details; M07 freshness states; M08 honest cold-launch/reconnect/foreground-only behaviour |
| Release | S01 privacy/consent/DPIA screening; S02 redaction/encryption/data policy; S03 measured abuse/resource limits; S04 monitoring/rotation/recovery; S05 security/lifecycle/regression evidence; S06 signed capped TestFlight pilot/rollback; S07 measured freshness/battery/errors/spend |

M07 provisional targets: moving upload every 5 seconds; fresh <=20 seconds,
stale >20 seconds, offline >=60 seconds; hide the point after 5 minutes while
retaining roster membership. Measure before changing these targets. Initial
hosting preference is separate London API Gateway HTTP/WebSocket + Lambda +
DynamoDB; do not assume existing EC2 capacity or unused free-tier allowances.

## Acceptance evidence still needed

Every row is pending end-to-end evidence. Existing unit tests may cover parts.

| ID | Required result |
| --- | --- |
| T01 | Invalid/expired/wrong-provider tokens and nonce/code replays rejected |
| T02 | Refresh reuse and revoked sessions cannot retain HTTP/socket location access |
| T03 | Wrong user/room, invite-only and removed-member requests cannot access peers |
| T04 | Expired/revoked invites rejected; redemption abuse limited |
| T05 | Old capture/replay/late sequence/new device/skew cannot replace or freshen a fix |
| T06 | Selected motorcycle artwork/headings work with map rotation and identical bikes |
| T07 | 2/5/10 devices tested; measured remote age, provisional p95 <10 seconds |
| T08 | 30–60 minute screen lock, permissions, force-quit and battery measured on iPhones |
| T09 | Signal loss/reconnect produces honest stale/offline states and fresh recovery |
| T10 | Recording/sharing controls independent; offline leave/end/expiry enforce access |
| T11 | Logout/deletion/provider revocation remove access, points and required tokens |
| T12 | Restart/load/cleanup failure tested; routing isolated; resource limits/alerts work |
| T13 | Relevant tests/lint/typecheck pass; local tours preserved; signed physical build proved |

## Verification baseline and commands

Last implementation evidence recorded on 2026-10-19 (increment 97):
Node 22.22.0 backend suite PASS2185 (including subtests), focused signed suite
PASS289, root app suite PASS234, lint/typecheck PASS. Latest changes were tests
and documentation; no production defect was reproduced. These counts are a
historical baseline, not newly executed checks or DB/cloud/device acceptance.
Current database evidence (manual continuation, 2026-10-19): **115 integration
tests PASS, zero failures/skips**, against checksum-verified DynamoDB Local 3.3.1
with Java 17 and Node22.22.0. Command below with `--test-concurrency=2`, endpoint
`http://127.0.0.1:59416`, synthetic credentials/data; about 13.2 seconds, direct
exit 0. All ten existing integration files executed. An independent ListTables
check confirmed zero remaining tables; emulator stopped afterwards. Log:
`/tmp/bendbound-group-dynamo-manual-20261019.log`. Vendor ZIP SHA256:
`5b0d17dd3b4e929db64a9f624a3f96eaf0961e3cf4acece00091656aec5fc7ed`.
This clears the previous localhost-execution blocker for the current source.
It does not prove actual AWS IAM, index lag, runtime limits or provider/device
behaviour. No production defect reproduced; no new tests or backend edits.

From repo root, using Node >=22.13.0 for the backend:

```sh
# Relevant focused suite first; full backend once warranted by the change.
(cd services/group-rides && node --test --test-concurrency=2 tests/*.test.mjs)
npm test
npm run lint
npm run typecheck

# Only with the documented localhost emulator running and synthetic credentials.
(cd services/group-rides && GROUP_DYNAMO_LOCAL_ENDPOINT=http://127.0.0.1:<port> node --test --test-concurrency=2 integration/*.dynamo.mjs)
```

Follow deployment instructions for emulator setup/cleanup and rebuilding artifacts.
Do not repeatedly rerun passing suites without a change, failure or unresolved
concern. Rebuild and inspect the Lambda archive before a future authorised rollout.
Cloud IAM, migration, ingress trust, scheduler/read budgets, lifecycle cleanup and
provider deletion must be verified in the actual deployment environment.

## Supporting documents

- [Native Apple implementation and exact remaining bridge work](group-native-apple.md)
- [Account/provider setup](group-accounts-setup.md)
- [Logout recovery and outstanding lifecycle gates](group-account-logout.md)
- [Deployed account deletion, receipts, retention limits and signed pilot steps](group-account-deletion.md)
- [Pilot admission and operator responsibilities](group-pilot-admission.md)
- [Protocol, clock and location contracts](group-rides-protocol.md)
- [Database validation, infrastructure and rollout](group-rides-deployment.md)

These contain implementation detail and historical evidence. Use their applicable
contracts; do not treat an old suggested test candidate as the current priority.

## Session handoff — replace this section after each work session

2026-10-20: route-preview Group ride lobby and display-name repair implemented.

- App: `GroupRidePanel.tsx`, `services/groups/client.ts` and `lobby.ts`,
  `app/group/[id].tsx`, `useAccount.ts`, map preview/modal and hidden tab route;
  account name request/cache/editor and session display-metadata update; dynamic
  profile header. Existing local planning, recordings/settings preserved.
- Server: roomApi lobby-only guard after authentication; metadata read avoids point
  storage; roomLambda defaults to lobby-only; rooms template has LobbyOnly parameter.
  Existing fixed-route rejection remains intact. No native dependency change.
- Deployment: stack UPDATE_COMPLETE, no storage replacements; artifact SHA256
  `f1b70660142ce3bc8a51ffd86a27b6b7f765c64a85ede08ac7fc893ee3f4b401`,
  S3 key `deployments/group-rides/<sha>/sessions.zip`, version
  `Rn8GopyD3wTQR3U.hjbThv6BTwkTiod0`. Exact endpoint/state in deployment manifest.
  Native auth/session/deletion stacks unchanged. Alarm destinations still need an
  operator destination; existing account-deletion recovery/retention work remains.
- Checks: app248/248; backend2204/2204; signed backend subset289/289; lint/typecheck;
  iOS/Hermes export `/tmp/bendbound-group-lobby-ios-export`; local Metro HTTP200
  bundle contains the lobby UI/endpoint. Live denial routes401/no-store, function
  code hashes/guard, IAM grant-write denials and room-cleanup invocation verified.
  No real group, invite, join, refresh, logout or deletion was executed as a tester
  by the agent. Synthetic tests are not physical/background sharing evidence.
- Next user action: relaunch app → generate route → Group ride → save rider name if
  Apple omitted it → Send invite. Confirm host roster/options; invite a separately
  approved tester with the app installed. Recipient opens link → Apple login if
  needed → Join group → Open invited route. Confirm names and motorcycle choice,
  refresh roster, end/leave, expired/replaced invitation handling and restart recovery.
- Keep live-sharing operations disabled until P01/P02 physical gates pass. Later:
  real location publisher/transport/peer map markers, Apple lifecycle notifications,
  operational recovery/retention and release/privacy acceptance.
- No secret/provider material or request IDs saved here. `.secrets.env` untouched;
  `.env` gained only a public lobby endpoint. Hourly automation remains removed.
  No verified allowance snapshot is available; maintain durable checkpoints.


### 2026-10-20 — Brand-preserving interface refinement

- User requested the installed Impeccable, Emil design-engineering and Taste Skill
  patterns while retaining the approved logo and overall palette. Acceptance:
  update native task hierarchy, type, spacing and controls; preserve application
  behaviour; pass lint/typecheck and relevant existing tests; inspect native renders.
- Added `DESIGN.md`. Updated `src/theme.ts`, shared `ui.tsx`, destination search,
  standard planner, map marker text sizing, and Map / Tours / Profile / Bike screens.
  Existing colour values and logo assets are unchanged. Removed Profile's synthetic
  activity bars; real recorded-ride totals remain. Native switches, labelled loading
  states, 44pt minimum controls and larger sentence-case labels replace custom or
  undersized controls. Cached tab content now remeasures on font-scale changes.
- Existing test harnesses in bike-settings, place-search and tour-recording now load
  the real theme; screen mocks supply window dimensions. Relevant suites: 68/68
  PASS. Typecheck and Expo lint PASS; Taste source scan 0 FAIL / 0 WARN.
- Local Xcode Debug simulator build succeeded. Inspected iPhone 16 Pro and iPhone
  16e (iOS 18.6): Map, Tours, saved cards, Profile and planner; verified scrolling to
  round-trip actions on 16e. Checked accessibility-large text on Map and Tours,
  corrected cached text clipping, then restored the original large text category.
  Screenshots and detailed limits: `output/design-review/`.
- No cloud deployment, account sign-in/logout/deletion, group operation, physical
  device recording or live sharing was performed. P01/P02 and all physical group
  acceptance gates remain pending. Existing prior deployment state remains in force.
- Resume: review the updated UI through the existing Metro/Xcode workflow; check
  physical touch/recording and account/group acceptance separately. No new native
  library, signing configuration or native project generation was required.


### 2026-10-20 — Promotional website deployment

- User requested a simple one-page app promotion using the established app design,
  deployed through AWS MCP to Lambda. Confirmed domain: `bendboundapp.com`.
- Source is isolated in `website/`: public HTML/CSS/JS and approved logo / actual
  simulator screenshots, Lambda handler, four HTTP/security tests, MCP transport,
  package/deploy/verification scripts and CloudFormation template. Native app source
  and group/account behaviour were not changed. Early-beta status is explicit;
  no public download URL was supplied, so the CTA opens the feature tour / project.
- AWS login recovery succeeded. Chat AWS wrapper still returned Unknown tool;
  the same configured MCP was used via its existing stdio connection method.
  Actual Route53 / ACM / S3 / CloudFormation / CloudFront / Lambda access verified.
  No AWS CLI resource-operation bypass was used.
- Deployed stack `bendbound-website` in eu-west-2: CREATE_COMPLETE. Lambda
  `bendbound-website` Active/Successful; CloudFront `E12GWLMW2DYJQV` Deployed,
  `d3twv41ghc49ef.cloudfront.net`. ACM certificate in us-east-1 issued; apex and
  www A/AAAA aliases installed. Existing API A record remains unchanged.
- Public checks: HTTPS 200 for HTML/CSS/JS/map/robots/sitemap, HTTP-to-HTTPS and
  www-to-apex redirects, 404 handling, security headers; unsigned Lambda URL403.
  Direct deployed Lambda invocation200 and code hash matched the packaged artifact.
  Lambda URL uses AWS_IAM with CloudFront OAC and distribution-scoped permissions.
- Browser checks at1440/768/390: no layout FAILs; mouse/keyboard feature tour passed;
  independent design reviewer ship. Four handler tests, root lint/typecheck and JS
  syntax/source scan pass. Screenshot-only / restrained-motion allowances recorded.
- Default Mac DNS retained the initial negative lookup at launch; authoritative DNS
  and public1.1.1.1 resolve correctly. Public verification used1.1.1.1 with full TLS
  certificate/hostname validation; no system DNS settings were changed. Some cached
  resolvers may need time to refresh. Exact source/artifact/deployment and smoke
  evidence: `website/deployment.json`, `website/verification.json`, `website/README.md`.
- No app build, account/group operation, live sharing or phone acceptance was
  performed. P01/P02 gates and existing backend state remain unchanged. Resume app
  work from the earlier native handoff; website updates use `website/scripts/deploy.py`.


### 2026-10-22 — AWS and phone availability recheck

- Acceptance: verify deployed stack/function state, lobby guard, anonymous/invalid
  bearer boundaries and current pilot admission; establish physical-phone availability
  before claiming any device acceptance. Read-only AWS resource operations used the
  configured official MCP. Normal Bendbound London browser login completed; actual
  MCP resource reads succeeded. No rollout, grant change or account deletion performed.
- All five identity/session/native-Apple/room/deletion stacks UPDATE_COMPLETE. All
  ten group Lambda functions Active/Successful; code digests match the saved manifest.
  Room stack EnableServices=true, LobbyOnly=true; room Lambda GROUP_LOBBY_ONLY=true.
  London capacity remains 1000, 975 unreserved. AlarmTopicArn remains empty.
- Strongly consistent USER-grant scan completed: one active-state row, no lifecycle
  hold, but pilot deadline expired 21 October 2026 at 12:06:41 BST. The state label
  does not confer access past expiry. No extension applied; explicit tester renewal
  authorization is needed before authenticated lobby testing. No identifiers saved.
- Live HTTP: missing/invalid bearer create/read/start/session requests returned
  401 with no-store. Deletion malformed body returned 400/no-store; valid synthetic
  receipt body with missing/invalid bearer returned 401/no-store. An initial probe
  used the wrong deletion path and returned Gateway404; corrected to the documented
  POST /v1/account/deletion. These checks establish rejection only, not a completed
  authenticated lifecycle, real deletion, cleanup or live sharing.
- Device tooling reported a paired physical iPhone16 over localNetwork, Bendbound
  1.1.0 build10 installed, and a successful launch. Octavian then clarified the phone
  is not connected: do not count these tool reports as current device availability
  or acceptance. Device Hub observed only simulator UI; no physical app UI, account,
  lobby or GPS acceptance was performed. Physical checks remain pending.
- Xcode Organizer shows build10 archived on21 October and Uploaded to Apple at14:23;
  this supersedes the older claim that no complete archive exists. It does not prove
  TestFlight availability or group/device acceptance.
- Checks: root Expo lint and TypeScript typecheck PASS; documentation only changed.
- Resume: connect/unlock the physical phone and provide a usable physical screen
  surface; obtain explicit approval for the intended tester's expired grant renewal,
  then perform P01 and lobby create/invite/join/name persistence on real phones.
  Keep live sharing disabled; a second approved physical iPhone is still required.


### 2026-10-25 — Routing storage and automatic GitHub ratings backup

- User requested moving routing build scratch to NAS192.168.1.247 while preserving
  daily research, plus automatic GitHub updates. No group/account behavior changed.
- Added archive_build.py: explicit build-only allowlist, daily lock, NAS mount
  check, per-file SHA256 and final destination verification before local removal.
  NAS archive destination `/Volumes/home/Bendbound/routing-builds/2026-10-25`.
  Transfer COMPLETE: 10,798,488,339bytes /1,408files SHA256-verified and removed
  locally. Both manifests match; original baseline checksum unchanged, ledger
  quick_check ok and scheduler dry-run PASS. Baseline/research remain local;
  data-volume free space increased16GiB to26GiB. Exact manifest:
  `routing/.data/research/build-archive.json`.
- Added sync_github.py, hooked after successful AWS daily publication. Separate
  ignored checkout pushes only compact per-section ratings/metadata/README to
  `ratings-data`; no app worktree staging or force pushes. Real GitHub push and
  idempotent retry verified at a4a48f565e1b2aebc0d9c9b26b227375e6ee70d5.
  141,445 sections in2.1MB gzip; AWS database SHA recorded in public manifest.
- Four new GitHub tests (real temporary Git remote, deterministic export,
  rejection of unpublished/tampered data and AWS-before-Git ordering) and five
  runner tests PASS. Expo lint/typecheck PASS. No new model or AWS run triggered.
- Details/resume: docs/routing-storage-and-github.md. GitHub-only retry is
  `python3 routing/catalogue/research/sync_github.py`. No gh CLI login needed;
  existing Git credential helper successfully pushed. Physical group checks remain
  pending; live sharing state unchanged.


### 2026-10-26 — BrowserStack trial preparation

- Octavian selected BrowserStack for remote real-iPhone group testing. Acceptance
  for this step: two simultaneous real iPhones install the existing TestFlight
  build and complete native Apple sign-in, before lobby create/invite/join tests.
- Local Xcode archive 1.1.0 build10 verified: com.octavian.bendbound, native
  Apple sign-in entitlement Default, embedded JS bundle containing lobby UI,
  configured lobby endpoint and native Apple endpoint. No rebuild needed from
  these checks. Current TestFlight availability remains unverified.
- BrowserStack connector is not available among exposed tools. Computer-use
  inventory reports no browser/app surfaces and native-pipe startup failure;
  opening App Live in the in-app browser also reports unavailable. No device
  session, app upload, login, purchase or subscription was performed.
- Dependency/owner: Octavian opens https://app-live.browserstack.com/ and signs
  in or creates a trial, then confirms the device dashboard. Browser control must
  be restored for agent-driven sessions; otherwise user operates the UI with
  agent guidance. Terms/payment decisions remain with Octavian.
- Resume: select two iPhones with independent sessions (no mirrored interactions),
  install Bendbound build10 through TestFlight, validate native Apple sign-in
  using dedicated test accounts. Match and explicitly approve any intended test
  identities via the existing controlled enrollment workflow before group access.
  The last recorded grant expired21October; no renewal was applied today.
- Keep lobby-only mode enabled. All physical P01/P02/P04 checks remain pending;
  no cloud test is counted as successful device acceptance. No source code,
  account grants or deployment configuration changed.


### 2026-10-26 — Browser control restored; BrowserStack trial limits verified

- Chrome control now works; App Live is signed in. Install via TestFlight is
  selectable and real iPhones are listed. No device session was started.
- App Store Connect now directly verifies build10 is Testing and assigned to
  Internal/Friends. This supersedes the earlier unverified TestFlight availability.
- App Live explicitly limits each free-trial device to two minutes, insufficient
  for the planned account/lobby/background acceptance session. Subscription page
  viewed only: month-to-month Individual49USD, Team175USD, TeamPro289USD;
  comparison lists multi-device testing under TeamPro. No subscription, payment,
  tester invitation, grant change, build upload or Apple login was performed.
- Resume with Octavian's plan/budget decision and two dedicated test identities.
  Keep lobby-only enabled; P01/P02/P04 physical acceptance remains pending.


### 2026-10-26 — Free BrowserStack real-iPhone attempt

- Octavian authorized the free trial smoke test and will perform the longer
  screen-lock/battery measurements on his own phone. No paid plan authorized.
- Started a real iPhone15, iOS17.3, through App Live Install via TestFlight.
  Observed TestFlight launch and its native Apple ID sign-in sheet. Contrary to
  the dashboard's generic two-minute limit, this session explicitly provides a
  five-minute PRO trial and offers one complimentary multi-device session.
  Neither offer is counted as proof of successful two-device testing.
- TestFlight has no signed-in test identity yet. Requested Octavian enter a
  suitable test Apple account directly on the remote device, not in chat.
  Bendbound installation/launch, native app Apple sign-in and lobby operations
  remain unverified; no credentials, account references or coordinates saved.
- Resume from the live BrowserStack tab after user sign-in; install build10 and
  check app launch/Apple sign-in before attempting invite/join. User interaction
  is the current dependency. No grant renewal, tester enrollment, cloud changes,
  subscription, purchase or app-source change performed. Live-sharing acceptance
  remains pending; personal-phone battery evidence and peer-delivery evidence
  will be recorded separately when available.


### 2026-10-26 — BrowserStack build10 launch PASS; native login blocked

- Octavian completed TestFlight login/installation directly. Verified TestFlight
  lists Bendbound1.1.0(10), then opened it on the real iPhone15/iOS17.3.
  First-launch TestFlight information completed; map and Profile screens rendered.
  Location permission was denied for this account-only smoke test; no recording,
  location publication or sharing acceptance is claimed.
- Profile shows Continue with Apple. Tapping it produces the native system alert
  requiring Apple ID sign-in in iOS Settings. The TestFlight/App Store account
  does not establish the device-level Apple identity needed by this flow.
- Tapping the alert's Settings opens BrowserStack's restricted settings controls,
  without an Apple ID sign-in control. BrowserStack's official FAQ says iCloud
  Settings support remains on its roadmap:
  https://www.browserstack.com/support/faq/app-live/features-app-live/my-app-requires-access-to-icloud-settings-can-i-test-this-on-app-live
  Do not assume buying the normal TeamPro plan resolves this restriction.
- Screenshot evidence (no credentials or rider coordinates):
  output/group-testing/browserstack-20261026-apple-settings.jpg.
  Ended session explicitly and verified return to dashboard. No paid plan,
  second device, complimentary multi-device activation, invitation, grant change
  or source code change. No app account authenticated and no group was created.
- P01/P02/P04 acceptance remains pending. Resume native login/group acceptance
  on phones permitting device-level Apple ID sign-in, or obtain explicit provider
  confirmation of that capability on dedicated devices before spending money.
  User-owned personal-phone screen-lock/battery work remains separate and pending.


### 2026-10-26 — README refresh and focused commit preparation

- Updated root README with build10 TestFlight/BrowserStack launch evidence,
  native Apple device-account blocker, private account/lobby state and remaining
  device/live-sharing gates. Added UK routing, daily reviewed AWS/GitHub ratings
  publication, completed NAS archive, website and current service/privacy details.
  Corrected stale no-account/demo-profile/backend/entry-point/ExpoGo claims.
- README local-link and whitespace checks PASS; Expo lint/typecheck PASS.
  No application or backend code changed during this documentation step.
- Prepared a focused README-only staged change. All pre-existing app, routing,
  website and tracker work remains unstaged; no commit or push performed.
  Suggested message: docs: refresh project status and testing notes.
