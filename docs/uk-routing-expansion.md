# UK routing expansion — active handoff

## Current state — deployed and publicly verified, 21 October 2026

UK graph and national ratings are LIVE at https://api.bendboundapp.com.
No graph or database build remains outstanding. The existing t3.medium/4GiB RAM
and64GiB gp3 disk are unchanged. Legacy rollback instance remains stopped.
No app rebuild is required for this backend release.

- Graph SHA256 `8cc789c4ceb36866622af1a26b787f9b5515c40537b569b9beebcc069a93acd2`,
  2,872,217,600bytes,1341tiles; source Geofabrik united-kingdom-261018.osm.pbf.
- Ratings SHA256 `05478fee42d89429a2e12ad804c04828dbe73043a72d9ae4ebe38ad25ae7895f`,
  752,939,008bytes.141,445rated sections,1,035,781physical edges,
  1,036,593memberships,134guide-recommended sections;173unmapped source sections,
  zero lost guide-recommended sections. All original scores/citations preserved.
- API image `bendbound-routing-api:uk-20261020`, amd64,
  SHA `e6ac53017287993a8cfcbc104233b40263c51c820400cce4fec64bb98dc17019`.
  25deployed public source files match local checksums exactly.
- Server stage `/opt/bendbound/routing/.data/uk-20261020`;
  `.data/uk-current` points there, `.data/uk-enabled` selects UK compose override.
  Use `catalogue/compose-aws.sh` for subsequent operations; preserve these markers.
- Public authenticated HTTPS tests passed for London, Lake District, Wales,
  Highlands and Northern Ireland. Route times0.07–0.38seconds in release smoke.
  Strict120° cone round-trip18.137km passed in10.88seconds, insideCone true,
  maxTraversals2, repeated3.73% (<10%), native identity verified >99.9999%.
  Existing100km per-search maximum and road-reuse gates remain unchanged.
- Full-country integrity/source/native/RTree/shortcut checks passed locally.
  Independent actual SQLite consumer/native bridge checked all five regions on EC2
  under256MiB,128MiB RSS. No OOM events. Engine/bridge healthy; API ready.
  Post-cutover available RAM2867MiB,39GiB disk free. Observed service memory
  API92MiB, engine89MiB, bridge24MiB, Caddy13MiB (snapshot, not peak guarantee).
- 78Node catalogue tests PASS/1existing skip;24Python tests PASS in build recovery;
  lint/typecheck PASS. Public unauthenticated health correctly returns401.
- Local Colima is stopped; CPU-heavy work was performed on the Mac. Remote staging
  containers/network removed. Existing London graph/overlay, old API image,
  Postgres/Neo4j data, route shares and fuel services/secrets preserved.

### Evidence and rollback

Deployment manifest: `routing/catalogue/ec2/deployment.json` (`ukDeployment`).
Local ignored reports/artifacts: `routing/.data/uk-20261020/`;
`graph/ec2-public-verification.json`, `deployment-manifest.json`,
`deployment-evidence.json`, local full verification and memory reports.
EC2 reports: same stage's `graph/ec2-{consumer,staging,public}-verification.json`.
Finished runtime artifacts also retained in the existing S3 artifacts bucket,
content-addressed under `uk-routing/20261021/<sha>/`; no secrets or PBF uploaded.

SSM commands all Success:
- Preflight `b171a7b1-31dc-4b2a-b8f9-49e9c6282835`.
- Image/config `47b40142-bafc-47da-804e-919c0dd3a558`.
- Ratings `1e6f6c39-f1d9-4278-8607-dcfa9a5f50b2`.
- Graph `3dc3d8dd-19e9-4626-9a77-b446a062431f`.
- Isolated national staging `8e17fa13-7194-4999-bd9d-d4f78e76bddc`.
- Guarded activation/public verification `a35c07fa-7566-4b97-a01f-8c9d9e34ce47`.
- Source parity/health/cleanup `7b57ab2d-d992-43d3-9864-790d4412814e`.

Fast rollback, via AWS MCP SSM on the existing active instance:
`sudo bash /opt/bendbound/routing/.data/uk-rollback-20261021/rollback.sh`.
Script syntax and original image presence verified; it removes UK activation,
restores wrapper/bridge and restarts the preserved London image/graph without
building. Original API image SHA4281f711bec193a6baf7aadb3a38f5034b40188caa5fcdcf56291b714839bed4.
Do not execute rollback unless needed; this successful release remains live.

### Next work

UK baseline deployment is complete. Do not rebuild it or repeat completed smoke
checks absent new changes/failures. Daily06:00 research now has its completed local
national baseline;21October's run remains historically blocked, not retroactively
successful. Reviewed daily overlays are still local: their safe publication to the
live SQLite overlay needs separate integration. See `docs/routing-daily-research.md`.
Preserve local source/ledger/completed artifacts and resumable ratings.work.sqlite.
AWS authentication recovery: normal `aws login --profile bendbound --region eu-west-2`
browser flow, then verify actual MCP access. Never save sign-in links or credentials.

Earlier progress entries below are historical, not current build status.

Updated 2026-10-20. User authorised national coverage on the **existing** t3.medium,
4GB RAM /64GiB gp3 instance, at3–4 requests/day. They then explicitly requested
**all CPU-heavy preparation on this Mac**, uploading the results to AWS afterwards.
No instance/storage increase or temporary AWS build instance is authorised/needed.

## Current live state

London service remains live at https://api.bendboundapp.com on
`i-0c392dc16f7c9d857`, eu-west-2; instance/root volume unchanged. Original graph,
rating overlay, databases and route shares preserved. Around44GiB free on EC2.
An initial staging download was started remotely, then the user changed the build
location: stopped the remote build shell/container and removed temporary8GiB swap.
Remote stage: `/opt/bendbound/routing/.data/uk-20261020`; contains an incomplete
map download. Do not resume heavy work there.

## Local preparation

Colima `bendbound` started with6GiB RAM/3CPUs, existing14GiB VM disk; pinned
Valhalla3.9.0 image supports native arm64. Stopped three idle local legacy routing
containers to free memory; volumes preserved. Mac initially had19GiB free.
Removed11 old Bendbound Xcode archives,14 temporary exports/IPA/build archives
and old DerivedData (~4.3GiB before cleanup). Latest Xcode archive2026-10-12,
source, reports, signing material and current lobby export preserved. Xcode may
recreate DerivedData. No source/credential cleanup was attempted.

- Source: Geofabrik `united-kingdom-261018.osm.pbf`, ~2.1GiB; MD5 matched provider.
- Local stage: `routing/.data/uk-20261020`, ignored by Git.
- Graph: **RESTARTED locally with separate parsing and enhancement processes; not complete.** Started with
  `bash routing/catalogue/uk/build-local.sh`, Docker container
  `bendbound-uk-local-build` (2CPU limit,5GiB memory, native ARM). Log
  `/tmp/bendbound-uk-local-build.log`. Graph build one worker/64MiB tile cache;
  status marker `GRAPH_READY` only after tiles/extract/way mapping complete.
- Rating source generation runs on native Mac Python3.12/osmium4.3.1 via
  `rating-sources.py`, log `/tmp/bendbound-uk-local-ratings.log`. It retains the
  actual existing London source sections/citations and adds eligible UK OSM way
  pieces with the existing geometric scorer. New sections claim **zero** online
  recommendations, no invented popularity. No new PostGIS/Neo4j import required.
- Existing London rating source copied through private S3 public-map metadata
  staging object `uk-routing/20261020/london-ratings-source.jsonl.gz` in the existing
  group artifacts bucket. No credentials or rider data included.
- Local coverage-policy changes prepared, not deployed: `ROUTING_COVERAGE=uk` uses
  the Geofabrik extraction polygon including NI. Default remains London, preserving
  rollback/tests. Country coverage is separate from the per-ride100km search cone.

## Next steps

1. Check both local processes/logs and disk/RAM; keep at least4GiB free, stop staging
   if necessary. Never delete the live/rollback graphs to make space. Confirm actual
   exit codes; a marker/log line alone is not success.
2. Once graph+source ready, use pinned container locally to run
   `catalogue/graph/export.py --source <ratings-source.jsonl> --output <ratings.sqlite>`
   against staged `/data/valhalla.json`. Bind by tile archive SHA256. Inspect section
   counts/coverage, unmapped cited sections and resulting API memory requirements.
3. Run local national health/routes/round trips and matching/native identity checks.
   Tune bounded caches/API heap/concurrency for4GB EC2. Test England/Wales/Scotland/NI
   and London regression; report quality limits honestly. No false nationwide guide
   popularity. Geographic filter, direction/cone/reuse restrictions stay enforced.
4. Transfer only finished graph/overlay and reviewed server/coverage config via
   AWS MCP/presigned S3/SSM; checksums first. Use a separate graph directory and a
   reversible Compose override. Keep the live London graph/service until staging
   tests pass. Never replace route-share/fuel data or credentials.
5. Cut over after tests, verify public routes across all four nations and resources;
   leave simple rollback instructions and update deployment manifest/this note.
   Keep allocated EC2/EBS size unchanged. Clean only this task's temporary transfers,
   incomplete downloads and build scratch after successful validation.

AWS auth-first rule applies; normal fresh London `aws login --profile bendbound
--region eu-west-2`, then retry actual MCP. No local SDK/CLI resource-operation
fallback. Do not save sign-in URLs/codes. No verified credit-allowance snapshot;
maintain this checkpoint rather than claiming allowance monitoring.

## App build cleanup and current checkpoint (20 October)

Removed 11 older Bendbound Xcode archives, 14 old temporary build/export artifacts,
and most of the old Bendbound DerivedData (about 4.3GB). Kept the newest archive
from 12 October, the latest group-lobby export, source and signing material. Xcode
is recreating its small active DerivedData directory; leave that alone. About
7.9GiB free at this checkpoint while the UK graph build is growing.

Local UK graph build remains active in `bendbound-uk-local-build` (exec session
99433), building 776 tiles after parsing/topology. Rating-source extraction remains
in session 20343. Disk watchdog session 19086 stops this graph container below
4GiB free. Logs: `/tmp/bendbound-uk-local-build.log` and
`/tmp/bendbound-uk-local-ratings.log`. Check actual process/container state first.

An indexed SQLite ratings adapter and exporter have been drafted to avoid loading
the whole national ratings JSON into EC2 RAM. Review
`catalogue/service/graph-catalogue-sqlite.mjs` and `catalogue/graph/export.py`;
regression test session 30920 writes `/tmp/bendbound-uk-sqlite-regression.log`.
Add a real SQLite adapter test before deployment. The prepared amd64 API image
needs refreshing with these latest sources before saving/uploading. None of the
UK graph/SQLite changes have been deployed; London remains live.

## Latest check — local disk guard stopped the build

The watchdog created `PAUSED_LOW_DISK` when local free space fell below4GiB.
The auto-removed build container no longer exists. `GRAPH_READY` and `tiles.tar`
are absent; the build stopped during graph enhancement, so this is not a usable
finished graph. Stage currently occupies about12GiB, with about4GiB Mac disk free.
Do not restart unchanged or claim it is still running. Inspect disk usage and find
sufficient safe temporary space (or external storage) before resuming/rebuilding.
Preserve input map, completed rating source and current partial graph for review.
Rating source finished:21,892 retained cited sections plus116,672 new geometry
sections. No UK deployment has occurred.

## Additional disk cleanup

At the user's request, removed npm download cache, temporary Xcode output
`/private/tmp/bendbound-design-build`, CocoaPods download cache, uv cache,
Homebrew cache and Colima download cache. Recovered7.57GiB net;15.72GiB free
afterward. Installed dependencies, VM disk, UK source/partial graph, signing
files and newest archive preserved. Build remains stopped; inspect partial-stage
resume support and disk requirements before restarting.

## Latest restart — staged build and additional cache cleanup

The first restart hit the disk guard again: Mac virtual memory occupied about13GiB
in addition to graph scratch. Cleared disposable Spotify media/browser caches,
Chrome cache/code cache and Xcode shared module cache. Chrome was running and
recreated a small cache folder; no cookies/accounts or application settings removed.
After deletion settled (including discarded incomplete graph) the Mac had26GiB free.

Changed the inner build to run `--end build`, then `--start enhance` in a fresh
process. This releases parsing memory before enhancement. The first phase saves
OSM metadata and creates `valhalla/parsed.complete`. A later retry uses `--start
build --end build` from those complete parsing files, first removing every partial
tile level, then runs enhancement anew. Never continue directly on partially
enhanced tiles. Valhalla3.9.0 help and pinned upstream `src/mjolnir/util.cc` were
checked for stage support and metadata persistence. Current first parse has no
checkpoint until that phase exits successfully.

Active build exec session20123, disk watcher70697. Same Docker container/log paths.
Actual startup confirmed in `valhalla_build_admins`. Keep4GiB disk floor; noAWS
changes. SQLite adapter tests added: routing catalogue78PASS/1existingSKIP,
including real read-only SQLite/native-edge/radius/cone/membership checks. Lint
and typecheck passed before build-script changes; shell syntax checks passed.

Local amd64 API image refreshed with latest public service JS/JSON:
`bendbound-routing-api:uk-20261020`, image
`sha256:9c3db33e9effc21594ba9fcf86048586eb3e7028af9ec846da140fa2a0d11738`.
Container smoke check confirmed Node22.23.3, native SQLite and RTREE support on
amd64. UK Compose override names this image with `pull_policy: never`; load the
finished image on EC2 and use `up --no-build` (no EC2 CPU-heavy image build).
Lint/typecheck passed again. Graph still parsing;26GiB free at this checkpoint.

## Latest recovery — tile-cache ceiling

The staged build finished enhancement (8,071seconds), hierarchy and level1
shortcuts, then aborted on level0 with `TileCacheLRU: tile size is bigger than
max cache size`. Largest observed level0 tile76,155,704bytes exceeded64MiB.
No final archive/GRAPH_READY was produced. Mac still had15GiB free.

Raised mjolnir max_cache_size to512MiB in the build recipe and current staged
config. Restarted via parsed.complete checkpoint, rebuilding all tile levels
from complete parsing data before enhancement; do not rerun shortcuts on top
of partially shortcut-modified tiles. No PBF parsing/download repeated.
Active exec build99079, watchdog61297. Same log/container. Build remains local,
5GiB container cap,4GiB disk guard. National coverage has not been deployed.

## Graph completed; national ratings export started

Build99079 exited0; `GRAPH_READY` and `build.complete` present, tiles.tar
2,872,217,600bytes,1,341tiles. Native way index finished5,503,541ways.
This proves local graph preparation only; not deployment acceptance.

Started national SQLite ratings export locally in Docker
`bendbound-uk-ratings-export` (5GiB cap), exec session recorded by current tool,
log `/tmp/bendbound-uk-ratings-export.log`. Exporter cache512MiB; source preserved.
Bridge cache now configurable via GRAPH_TILE_CACHE_MB, default64 for London,
UK override128 to handle the76MB tile while retaining256MiB container cap;
verify actual RSS under national traffic before deploy. Export/bridge changes
need final checks and bridge file transfer. Current free disk18GiB.

## Ratings export failed — current blocker

Export exec22656 exited137 and left no ratings.sqlite. It is not running.
Graph archive is complete, but the national ratings exporter needs bounded-memory
processing before UK deployment can proceed; do not simply repeat the same5GiB
export. New daily research job depends on the completed national ratings database
and records a blocked status without agent calls until that file is available.
See docs/routing-daily-research.md for the separate06:00 workflow.

## 21 October — confirmed export OOM and bounded-memory recovery

VM kernel dmesg confirms memory-cgroup OOM killed PythonPID3804, anonymousRSS
5,219,208KiB, matching the previous5GiB export cap and exit137. The completed
graph remains intact. Mac16GiB RAM, DockerVM6GiB, hostswap~11GiB used; noAWS
resource changes or graph rebuild. Raising VM/RAM alone would increase pressure.

New `graph/export_sqlite.py` streams the source file and stores nationwide way
geometry, native-edge IDs, segment membership and shortcut ranges in SQLite.
Only wanted way identifiers plus one source/way/shortcut are held in Python;
native cache512MiB, SQLite cache32MiB. Current exporterdispatch uses this path
for `.sqlite` output; legacy gzip path retained. Exact regression tests compare
old/new ratings, native physical hashes/IDs and shortcut fractions;5tests passed.

`uk/build-ratings.py` starts retained container `bendbound-uk-ratings-export-v2`
with5GiB memory cap, no container swap,2CPU limit; existing VM stays6GiB.
Active exec session3514. Graph/source mounts read-only. Input hashes bind the
resumable `graph/ratings.work.sqlite` to the exact source/graph/exporter.
Output is only atomically published after integrity/native-identity checks.
Do not edit the exporter while it runs; changed code invalidates its checkpoint.

Logs/resources/status live in `.data/uk-20261020/graph/export.log`,
`resources.jsonl`, `export-status.json`. Launcher checks disk15seconds, stops below
4GiB headroom, and retains OOM/exit diagnostics. Initial free disk~12.6GiB.
`RATINGS_READY` is created only after actual successful exit and DB validation.
Still needs real full-country completion, memory measurement, and API/native
road/shortcut checks. National deployment and daily research remain pending.

### Recovery checkpoint and expanded checks

A1002-section regression exposed a SQLite WAL truncation lock while a streaming
SELECT cursor was active during finalization. Replaced that cursor with1000-row
materialized batches, then checkpointed after cursor completion. Full fixture
suite now8PASS: exact legacy-compatible ratings/identities/shortcut fractions,
failed/resumed export, source drift, checkpoint republish, multi-batch finalization,
native edge geometry preserved when joining adjacent sections,25m scope exclusion.

Stopped the first optimized run deliberately (notOOM; retainedState.OOMKilledfalse),
backed up ratings.work.sqlite to ratings.pre-checkpoint-fix.sqlite, and migrated
only its exporter fingerprint for this verified finalization-only code change.
Source/graph hashes unchanged; saved stage=ways. Migration evidence is
graph/checkpoint-upgrade.json. Do not generally bypass fingerprint mismatches.

Current build exec19018 resumed the completed~2.55million way scan; containername
unchanged. Reads/writes remain bounded. Last progress~3.7million ways, peakRSS
~1.2GiB (includes mapped graph pages), cgroup~3.8GiB including reclaimable file
cache; Mac11GiB free. Independent whole-DB verification script prepared at
uk/verify-ratings.py; run after build exits successfully. Do not mark ready yet.
