# Self-hosted routing progress — 5 October 2026

## Completed

- Installed a separate `bendbound` Colima runtime (3 CPUs, 6 GB RAM); no existing
  app/Xcode build or archive was deleted.
- Built and ran Valhalla 3.9.0 against the Greater London OSM extract.
- Implemented one app-facing API, strict geometry/distance validation, bounded
  loop search, repeated-road exclusion attempts and spur removal followed by
  legal rerouting. Configured hard motorway exclusions on the private engine.
- Added optional app integration for standard trips and round trips, preserving
  multi-stop batches and navigation instruction indices. Service failures do not
  silently switch back to a public provider.
- Removed the pre-route scenic POI request; preview highlights still load along
  the completed route.
- Imported GraphHopper 11.1 from the same PBF and ran the 36-case comparison.
- Verified the real app routing functions against the local API: a 19.071 km
  round trip had zero detected overlap, 1,346 geometry points and 51 manoeuvres;
  a two-stop standard trip was 7.633 km with 12 manoeuvres.
- Added EC2/HTTPS deployment files and instructions in `docs/routing-ec2.md`.
- Installed `com.bendbound.continue-work` to check usage/pending work every
  18,000 seconds. The read-only usage request succeeds. A dry run skips the
  persisted interrupted thread, as intended; no extra model turn was launched.

## Benchmark

Measured locally in a 3-vCPU / 6-GB container VM on this Mac, with sequential
requests and alternating engine order. Three starts (Greenwich, Richmond,
Enfield), 20/40 km, motorway avoidance on/off, all three app style selections.
Both engines had 24 attempts and a 25-second budget per case.

| Engine | Valid loops | Median search latency | p95 search latency |
|---|---:|---:|---:|
| Valhalla + Bendbound loop planner | 33/36 | 431 ms | 1,568 ms |
| GraphHopper stock round-trip + retry/validation | 36/36 | 145 ms | 303 ms |

Maximum accepted distance error was 9.754 km for Valhalla and 7.522 km for
GraphHopper. Every accepted route passed the same zero-overlap geometry check,
closure/start-proximity check and strict less-than-10-km distance check.
These timings include failures as well as successes and exclude graph import.

Valhalla failed Greenwich 40 km with motorway avoidance for winding/twisty and
Enfield 40 km with motorway avoidance for fast. These are bounded-search failures,
not proven impossibility. GraphHopper is promising but not automatically enabled
for the app. Its stock motorcycle profile uses car access; all three style inputs
use that same stock profile. This benchmark does not prove equivalent legal
motorcycle access, genuine curvature preference or national coverage.

The raw reproducible report, including per-case results, failed attempts, actual
engine versions, and the PBF hash, is in
[`routing-benchmark-2026-10-05.json`](routing-benchmark-2026-10-05.json).
It is a synthetic public-location fixture set, not rider location history.

## Deployment handoff

The user will deploy to EC2 using the instructions. No AWS resources or paid
services were created. An EC2 hostname has not been supplied, so no private URL
has been enabled in the phone app yet. This local graph covers London only.
Waiting for that hostname/deployment is an external dependency, not an unfinished
local coding task for the five-hour job to retry.

## Limits of this pilot

- The validator still uses geometry, not physical road IDs; stacked roads can
  require additional handling. A strict loop cannot always exist at a dead-end start.
- Stock Valhalla's hard exclusions permit excluded features at endpoints; check
  motorway starts before treating this as a production-wide absolute guarantee.
- Fast/winding/twisty affect the Valhalla candidate shape. Dedicated curvature
  costing, precise segment bans during graph search, elevation/traffic/timezones,
  rural/large-distance benchmarks and public app authentication are further work,
  not claimed complete by this pilot.
- The existing curve-count UI remains an estimate, not measured engine curvature.
- No native dependencies changed. No new archive or production deployment made.

## Continuation policy

Final verification confirmed on 6 October: lint and TypeScript passed; all 114
app tests, 7 routing service tests and 7 usage-check tests passed. Compose and
Caddy configurations validated. The pilot work item is now marked done; EC2
activation is blocked on deployment/hostname. Valhalla's local health check
still reports ready.

The scheduled checks actually fired at 03:24 and 08:24 on 6 October. Usage was
available, but both CLI resume attempts failed because the original thread already
had an active writer in another Codex process. Thus scheduling and usage reads are
verified, but automatic continuation of an IDE-owned thread is NOT complete.
Do not treat the LaunchAgent's exit code 0 as proof that a continuation succeeded;
inspect `.state/checks.log` and `.state/last-run.log`. Do not terminate the user's
IDE session or start a competing writer to work around this.

`automation/.state/continuation.json` is the machine-readable work list. Mark the
pilot item done after verification. Keep EC2 activation blocked until deployment
details arrive. Only new user-authorised follow-up work should become pending;
do not invent new tasks or repeatedly run a completed benchmark.
