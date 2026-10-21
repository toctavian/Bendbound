# Motorcycle road catalogue

**UK release, 21 October 2026:** National graph and SQLite ratings are deployed
and publicly verified on the existing instance/disk. See the
[current handoff and rollback](../../docs/uk-routing-expansion.md) and
[deployment manifest](ec2/deployment.json). The 100 km search cap applies around
each ride start; serving coverage includes all four UK nations.

**Native backend introduced, 8 October 2026:** Valhalla supplies the road graph and serving
geometry, with ratings attached to native edges and shortcut ranges. PostGIS is
stopped temporarily and its data is preserved. Cone searches and reuse checks
use the native graph; directions and traversal identity come from one route
calculation. See [operation and rollback](graph/README.md) and the
[verification record](ec2/native-graph-verification.json).

The sections below document the retained PostGIS/Neo4j import and rollout baseline.

This service is deployed separately from the original routing pilot. The files
under `routing/service/` and the previous instance remain the rollback baseline.
The new API imports their engine, geometry, request limits and hard policy checks;
its candidate generator and catalogue are separate.

## Data and ratings

The service area is a 100 km geodesic radius from 51.5074, -0.1278 (central London).
The engine has a 130 km extract buffer so routing near the service boundary has
network context. Both accepted routes and submitted starts stay inside 100 km.
Input comes from Geofabrik's England OSM extract, not live Overpass requests.
`prepare.sh` keeps complete OSM ways during extraction and records a checksum.

PostGIS stores all imported drivable edges with their full line geometry and OSM
node topology. Eligible roads are merged into continuous sections by identity;
sections longer than 5 km are split. A section is a particular stretch, not the
entire A272 or other numbered road. Line geometry remains complete even though
the candidate generator passes a bounded set of through-points to Valhalla.

`features.py` computes original winding/twisty geometry features using 30 m
resampling and conservative road-class/surface factors. These are experimental
scores, not validated rider satisfaction or live road condition measurements.
Unknown surface is exposed as unknown; mapped unpaved roads receive no quality
score in this paved-road pilot. OSM omissions remain possible.

`evidence.json` contains a small, cited set of independently published guide
recommendations. One publisher counts once per road reference in a bounded region.
No third-party reviews, star ratings, photographs or GPX tracks are imported.
The recommendation count is not the number of riders who like a road.

The frequency score uses a conservative pseudo-count of two:
`frequencyRating = 1 + 4 * count / (count + 2)`.
No evidence yields a null frequency score; the road retains its geometry score.
With evidence, `rating = 0.7 * geometryQuality + 0.3 * frequencyRating`, bounded
to 0–5. Counts, component scores, source URLs and surface confidence are returned
so the result is explainable. No source counts are invented. Future rider ratings
have their own `section_feedback` table and are not populated by this import.

## Routing and full-section verification

The planner shortlists full lines using indexed PostGIS geography searches,
proposes diverse candidates through complete sections, routes using Valhalla,
and preserves the existing strict distance error `< 10 km`, closure, snapping
and motorway rules. Physical segments may be used twice, with additional repeated
distance capped at 10%; road ratings cannot override those limits.
[Road reuse policy, matching and verification](ROAD_REUSE.md).
It scores verified candidates and returns once a valid full-section route is
found. Catalogue exploration uses at most 7.5 seconds of the 25-second budget,
reserving time for ordinary-loop search. A valid candidate that misses the
suggested section remains available as an ordinary loop; another search or
engine failure cannot discard it. Fallback runs only when no valid loop exists.

Actual route geometries are map-matched through Valhalla `trace_attributes` to
OSM way IDs. PostGIS then measures traversed section length in a 12 m corridor
of that route, gated by matching OSM way identity. A guided candidate must cover
at least 98% of the chosen section. Other included sections expose their coverage
and are retained only at >=80%. This is a geometric/way-identity check, not a proof
that every lane-level directed edge or every metre of an entire named road was
traversed. Recommendations reward traversed length once per section.

## Graph database

Neo4j persists OSM junctions and directed `ROAD` relationships plus rated
`RoadSection` nodes and `TOUCHES` links. Shared OSM node IDs establish junctions;
line crossings do not. The graph and PostGIS catalogue use the same map checksum.
The graph includes connector roads, preserving topology for future multiple-route
generation in the same area. It is not currently the pathfinding engine: turn
restrictions, conditional access and manoeuvres remain Valhalla's responsibility.
Do not route directly on the Neo4j topology without adding those constraints.

The initial graph uses an offline CSV bulk import, followed by node constraints
and count/version checks. Completed raw-edge and section stages are recorded in
PostGIS so a retry does not discard imported geometry. A loaded-version marker
prevents repeating the offline graph replacement on the same dataset. Generated
CSV files and the importer environment are ignored by Git and Docker builds.

## API and checks

The original `/route`, `/round-trip` and `/health` contracts remain supported.
Health additionally reports catalogue and graph readiness. Protected
`GET /roads?lat=51.23&lon=-0.33&radiusKm=20` returns up to 100 evaluated road sections
with geometry, ratings and citations. Radius must be >0 and <=100 km.
The graph, PostgreSQL, raw engine and API ports bind only to host loopback;
HTTPS retains the existing pilot bearer token and request limits.

```sh
cd routing/catalogue
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
```

Build/import commands run on the new EC2 host via SSM. Use
`bash catalogue/compose-aws.sh` from
`/opt/bendbound/routing`. Inspect `/opt/bendbound/catalogue-build.log` and the
`bendbound-catalogue-build*` systemd units. Do not delete the old map or database as
a recovery step. A changed map requires a new versioned dataset and Neo4j remap.

The live API, engine and proxy log to CloudWatch in London with 14-day retention.
Error messages include a request reference that can be searched alongside policy
diagnostics. Use the EC2 wrapper above to preserve logging on subsequent builds.
[Log access, saved queries and operational details](LOGGING.md).

The old stack continues to own the stable Elastic IP and Route 53 name. Cutover
changes only its target instance through a CloudFormation parameter, and stops
the old EC2 after HTTPS verification. Rollback restarts the old instance and
sets that target parameter back. Certificate state is copied to the new host
without exposing private keys in deployment records. Neither stack is deleted.

OpenStreetMap data requires attribution and ODbL-compatible handling. The copied
OSM geometries and derived catalogue need their applicable data distribution
terms considered separately from Bendbound's independent source observations.
See https://www.openstreetmap.org/copyright.

## Current operating cost

AWS Price List API checked on 2026-10-07: London Linux `t3.medium` is
$0.0472/hour. At 730 hours, compute is $34.46; 64 GiB gp3 at $0.0928/GiB-month
is $5.94; the active public IPv4 is $3.65/month. Including the retained old
16 GiB disk ($1.48/month) and hosted zone ($0.50/month), the baseline is about
**$46.03/month**, down from about $80.49 on `t3.large`. This excludes tax,
transfer, DNS queries, domain renewal and CloudWatch ingestion/storage/query use.
CPU credits remain Standard, so exhausted credits throttle instead of generating
surplus-credit charges. Import speed and routing capacity must be measured.

Successful exact requests and nearby-road queries now use bounded caches.
Neo4j is retained on disk and started on demand. Cold-route and memory checks
passed on the smaller host. [Optimisation details](OPTIMISATIONS.md).

## Verified deployment, 2026-10-07

The stable `https://api.bendboundapp.com` endpoint now serves instance
`i-0c392dc16f7c9d857`. The previous `i-0bd903e525ebce321` is stopped, with its
service and map disk retained. Both stacks remain present. Standard CPU mode is
restored after the initial build's temporary Unlimited phase.

The catalogue contains 21,892 evaluated sections, including 126 with cited guide
recommendations, and 2,299,432 physical road edges. Neo4j stores 4,345,430 directed
road connections. The indexed 1 km PostGIS query executed in 2.333 ms in staging.
Public HTTPS requests passed for Greenwich 20 km (19.071 km), Dorking 40 km
(39.996 km) and an exact mapped B2026 start at Ashdown 60 km (57.644 km).
The Dorking candidate traversed 99.98% of its selected stored section. Ashdown
included 8.14 km of guide-recommended roads; its best candidate came from ordinary
loop generation and was evaluated using the same catalogue scoring.

Measured public round-trip requests took approximately 5.4–10.7 seconds with
Standard credits. These are smoke checks, not concurrent capacity measurements.
The original approximate Forest Row test coordinate returned `NO_MATCH`; it was
not accepted by weakening the shared-access policy. The rural smoke fixture uses
an actual mapped B2026 road endpoint instead.

[Resource IDs, checksums and rollback settings](ec2/deployment.json),
[public HTTPS checks](ec2/https-verification.json), and
[Standard CPU checks](ec2/standard-verification.json) record the deployment.

Directional cone planning and its pending deployment are documented in [DIRECTIONAL_AREA.md](DIRECTIONAL_AREA.md).

Rider animation and recorded-road display are documented in [ROAD_MATCHING.md](ROAD_MATCHING.md).
