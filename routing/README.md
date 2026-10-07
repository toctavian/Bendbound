# Self-hosted routing pilot

Valhalla 3.9.0 provides the app's motorcycle routes. GraphHopper 11.1 is a
benchmark service only. Both import the exact same OSM PBF. Engine images are
pinned by digest. The app's MapLibre renderer and map tiles are independent.

The default extract covers **Greater London only**. Do not use it as a UK-wide
service. The extract boundary affects loop availability, particularly long rides.
This pilot adds bounded loop search and repairs spur detours before recalculating
legal directions. It still validates overlap geometrically; it is not the full
physical-road-ID planner proposed in `docs/routing-engine-plan.md`. Fast/winding/
twisty currently change candidate shape; dedicated curvature weighting remains
future work. A failed search does not prove that no legal loop exists.

## Local setup

Requirements: Node 22+, Docker with Compose, about 6 GB available RAM during both
imports. The measured London pilot used about 600 MB for graphs/PBF/JAR, plus
container images and the container VM. Do not download all Europe on this Mac.

```sh
npm run routing:prepare -- --graphhopper
docker compose -f routing/compose.yml up -d valhalla api
docker compose -f routing/compose.yml logs -f valhalla
curl http://127.0.0.1:8088/health
```

On this Mac, the runtime is the `bendbound` Colima profile. Start it with
`colima start bendbound`; Homebrew installed the standalone `docker-compose`
command, which can replace `docker compose` in these examples. Stop the runtime
when not needed with `colima stop bendbound` (keeps the graphs).

For an iOS simulator, set `EXPO_PUBLIC_ROUTING_URL=http://127.0.0.1:8088` in a
local `.env` and restart Metro. For a physical phone, use the EC2 HTTPS hostname.
The phone's localhost is not the Mac. The settings are compiled into the JS bundle;
rebuild the distributed bundle/archive after changing them. The deployed pilot is
`https://api.bendboundapp.com` and accepts a shared bearer token on Wi-Fi or mobile
data. This Mac's ignored `.env` contains `EXPO_PUBLIC_ROUTING_URL` and
`EXPO_PUBLIC_ROUTING_TOKEN`; the app sends the token in its Authorization header.
The shared token is extractable from the bundle and is only a pilot access control.
For EAS builds, configure both values in the selected cloud build environment.
Existing TestFlight builds need a new build; none was submitted by this deployment.
See [EC2 access and limits](ec2/README.md).

Once configured, both standard and round trips use the private service. A private
service error is surfaced to the rider; there is no silent public-provider fallback.
With the URL unset, existing public routing remains available for rollback.

## Benchmark

Start Valhalla and verify it before starting GraphHopper:

```sh
docker compose -f routing/compose.yml --profile benchmark up -d graphhopper
docker compose -f routing/compose.yml logs -f graphhopper
curl http://127.0.0.1:8989/info
npm run routing:benchmark
```

The harness alternates engine order, performs requests sequentially, allows 24
candidate calls / 25 seconds per case, and applies the SAME distance, closure,
start-proximity and overlap checks to both engines. It saves raw attempts, engine
versions and the map SHA-256 in `routing/results/`; failures are retained. Engine
readiness failures abort the run. `--smoke` runs the first two cases.

The fixture suite is a pilot feasibility check, not a national benchmark. It uses
three London starts, 20/40 km, all three app styles and motorway avoidance on/off. GraphHopper's bundled
motorcycle profile uses `car_access`, so its results are not proof of equivalent
motorcycle legality. Neither engine is certified for true winding-road quality by
this test (GraphHopper uses the same bundled profile for all three styles).
Validate road access, bridge/stacked-road identity, motorway endpoints,
direction preference, larger distances and rural starts before a general release.

## Map updates and recovery

`routing/.data/map/manifest.json` records the source and hash. The downloader does
not silently replace a working extract. For a new region or snapshot, stop the
services, move `.data/map`, `.data/valhalla` and `.data/graphhopper` aside together,
then prepare/import a fresh set. Keep the previous set until health and benchmark
checks pass; rollback consists of restoring that set. Valhalla refuses a changed
PBF alongside an existing graph. Never combine fresh input with an old GH cache.

Set `OSM_URL` before `routing:prepare` to choose another Geofabrik extract. Increase
RAM/storage and container memory limits before importing a larger region. The
pilot does not import elevation, live traffic or a timezone database.

## Checks

```sh
npm run routing:test
node --test tests/self-hosted-routing.test.cjs
python3 automation/test_usage.py
npm run lint
npm run typecheck
```

Server geometry is generated from the app's helpers. After editing those helpers,
run `node routing/build-geometry.cjs`; the test command detects stale generated code.

See [EC2 deployment](../docs/routing-ec2.md) and
[five-hour continuation](../automation/README.md).

## Shared start/finish access

Round trips may retrace one continuous departure section at the very end of the
ride: at most 500 m one way, and at most 5% of the full route geometry one way
(10% for both traversals). The full engine distance, including both traversals,
must remain strictly within 10 km of the requested distance. Repeats elsewhere,
extra traversals of the access road, and ordinary out-and-back routes are rejected.

The server validates this policy using the generated geometry helpers. `planner.sharedAccessKm`
is the one-way access length; `overlapRatio` and `repeatedKm` still include that
permitted repeat. `remainingRepeatedRatio` must be zero. Repair retains the access
and reroutes the repaired loop through Valhalla to obtain fresh legal manoeuvres;
it does not splice navigation geometry. This is a geometry check, not a proof of
graph-edge disjointness or that a particular access road is unavoidable.

After changing these geometry helpers, regenerate `service/geometry.mjs` with
`node routing/build-geometry.cjs` and update the API service files.

## Server-owned routing policy

For the self-hosted `/round-trip` endpoint, the app requires an explicit
`planner.valid: true` response and checks data integrity: valid summaries,
decodable geographic coordinates, connected legs and usable manoeuvre indices.
Distance tolerance, road reuse, shared-access limits, loop closure and snapping
distance belong to the server. The app does not recalculate those decisions.
Server errors remain visible; the client does not retry rejected routes through
a public provider. Direct public-provider routing, when no self-hosted URL is
configured, retains its local policy checks.

One app release is needed to remove the old client policy checks. Subsequent
server policy changes do not require an app release as long as the response
contract remains compatible. The deployed API already returns `planner.valid`.
The shared-access server update is still pending deployment; existing TestFlight
binaries still enforce zero repeats everywhere.
