# Deploy the routing pilot to EC2

**Active deployment, 2026-10-21:** The [UK routing graph and ratings](uk-routing-expansion.md)
serve the existing API hostname using Valhalla and a SQLite rating overlay on the
existing t3.medium/64 GiB disk. PostGIS/Neo4j data and the London deployment are
preserved for rollback. [Deployment and verification](../routing/catalogue/ec2/deployment.json).
The older London build instructions below are retained as historical background;
use the UK handoff for current operation and rollback.

**Bounded road reuse, 2026-10-07 — deployed:** Physical segments may be ridden
twice, with additional repeated distance capped at 10%. Repetition is penalised
in scoring and cannot inflate unique section quality. The reported 60 km north
request now returns 63.158 km with 2.93% repetition and a maximum of two passes.
All five public pilot fixtures, actual app parsing, 63 relevant tests, lint and
typecheck passed. [Policy and verification](../routing/catalogue/ROAD_REUSE.md).

**Pilot optimisations, 2026-10-07 — deployed:** The catalogue host now uses
`t3.medium` (4 GiB) with bounded exact-request and road-query caching, cached
catalogue counts, and early rejection of too-short candidates. Neo4j data is
preserved and available on demand; routine routing uses PostGIS/Valhalla.
The fixed monthly baseline is approximately $46.03 before tax, transfer and
logging usage, including the old retained disk and hosted zone. See
[behaviour, graph startup and verification](../routing/catalogue/OPTIMISATIONS.md).

**Server logging, 2026-10-07 — deployed:** Structured request/failure logs and
API, engine and HTTPS proxy output are delivered to CloudWatch Logs in eu-west-2,
group `/bendbound/routing/london`, retained for 14 days. API errors include a
reference ID; failed round trips record exact starts/settings and bounded policy
diagnostics. Use `bash catalogue/compose-aws.sh` for EC2 rebuilds to retain the
logging overlay. [Find logs and debug a reference](../routing/catalogue/LOGGING.md).

**E14 loop availability fix, 2026-10-07 — deployed:** Catalogue exploration now
retains policy-valid loops that miss the suggested section, reserving more time
for ordinary-loop search and skipping redundant search after success. Selected
sections still require verified full traversal. Live HTTPS Winding/40 km tests
from the E14 3TA postcode fixture returned 38.917 km south (9.788 s) and 44.289 km
west (7.792 s). Greenwich, Dorking and Ashdown regression checks also passed;
all five responses passed the actual app parser and shared-access validator.
11 catalogue tests, 25 legacy/app tests, lint and typecheck passed.
[Verification](../routing/catalogue/ec2/e14-verification.json).
The reported TestFlight error confirmed server rejection, but its exact phone
GPS coordinate was unavailable; these results do not reproduce that precise
request. Round trips use the current GPS location rather than a postcode centre.

**Client policy update, 2026-10-07 — pending app release:** The self-hosted app now
uses the server's `planner.valid: true` decision and checks response integrity
only. Distance, overlap, closure and snapping limits are no longer repeated in
the client. One new app build is required; future compatible server policy
changes do not require another build. This client works with the existing API
contract. The shared-access server update below is deployed and verified.

**Shared-access update, 2026-10-07 — deployed:** The latest local API service
files were deployed through AWS MCP/SSM to the London instance. File SHA-256
checks matched, the API was recreated, and health, standard-route and 20 km loop
smoke checks passed. Live HTTPS 40 km Winding searches from the reported start
passed north/east/south (37.361 / 35.093 / 38.917 km), each with 257 m of shared
access and zero remaining repeated ratio. West still returns HTTP 422
`NO_MATCH` within the search budget. Missing credentials still return HTTP 401.
11 routing tests, 14 app integration/shared-access tests, lint and typecheck
passed locally. The previous service is backed up on the instance; checksums,
SSM command ID, backup path and live results are recorded in
[shared-access-deployment.json](../routing/ec2/shared-access-deployment.json).
Existing TestFlight binaries still enforce their compiled client policy; an app
release is required to use the server-owned validator described above.

**Deployment status, 2026-10-06:** Valhalla 3.9.0 is serving HTTPS at
`https://api.bendboundapp.com` on
`i-0bd903e525ebce321` in London (`eu-west-2`), managed by the
`bendbound-routing-london` CloudFormation stack. The Greater London health,
standard-route and validated round-trip checks pass. This deployment uses
`t4g.small` (2 GiB RAM), 16 GiB encrypted gp3 and 2 GiB swap, about **$18.86/month**
if left running (before tax/charged transfer, plus Route 53/domain costs).
The pilot accepts a shared bearer token from any network, including mobile data,
with request limits. Administration uses SSM. The local ignored `.env` now has
the URL/token, and the app sends the token; an existing TestFlight build needs
to be rebuilt with these settings. See the
[live deployment record and access instructions](../routing/ec2/README.md).

Use an ordinary EC2 instance for these persistent services. Lambda functions are
short-lived and cannot rely on state surviving between invocations; putting the
whole engine there adds graph-loading and lifetime complications. A future Lambda
API can call an engine on EC2, but is unnecessary for this pilot.
[AWS Lambda limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).

## 1. Create the pilot host

Suggested starting configuration, to be measured rather than treated as a sizing
guarantee: Ubuntu 24.04 ARM64, `t4g.large` (8 GB RAM), 30 GB encrypted gp3 storage,
London AWS region. This is for the **London extract** and light testing. A larger
England/UK import needs more memory/storage and increased Compose memory limits.
For the smaller Valhalla-only deployment, see the
[EC2 deployment files](../routing/ec2/README.md). That configuration uses
`t4g.small`, 16 GiB gp3 storage and 2 GiB swap, with only TCP 80/443 open and
Systems Manager for administration. The 8 GB suggestion above remains useful when
running both engines together; do not run the GraphHopper benchmark on the small
host alongside Valhalla.

The stack owns Elastic IP `16.60.63.241` and the Route 53 A record for
`api.bendboundapp.com`. TCP 80/443 permit certificate issuance and HTTPS;
Caddy requires the pilot bearer token before forwarding requests to the API.
SSH is closed; use SSM on the deployed host. If following the manual SSH copy
example below on a different host, allow SSH only from your own IP.
Keep 8002, 8088, 8989 and 8990 closed in the security group. No AWS keys belong in
the app. [EC2 security groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html).

## 2. Install Docker and copy the service

On EC2:

```sh
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
mkdir -p ~/bendbound/routing
```

From your Mac, in the roams repository (replace the key and hostname):

```sh
rsync -av --exclude '.data' --exclude '.tools' --exclude 'results' \
  -e 'ssh -i /path/to/key.pem' routing/ ubuntu@EC2_HOST:~/bendbound/routing/
```

Only the service files are needed on EC2. Generated `service/geometry.mjs` is
already included; no Expo dependencies, mobile app source or Xcode are required.

## 3. Download London data and start Valhalla

On EC2:

```sh
cd ~/bendbound
sudo docker run --rm -v "$PWD/routing:/work" -w /work node:22-alpine node prepare.mjs
sudo docker compose -f routing/compose.yml up -d valhalla api
sudo docker compose -f routing/compose.yml logs -f valhalla
```

Stop following logs with Ctrl-C after import completes; this does not stop the
engine. Confirm readiness and a real round trip:

```sh
curl --fail http://127.0.0.1:8088/health
curl --fail http://127.0.0.1:8088/round-trip \
  -H 'Content-Type: application/json' \
  -d '{"center":{"latitude":51.481,"longitude":-0.009},"targetKm":20,"direction":90,"profile":"winding","avoidMotorways":true}'
```

The health response should say `ready`, and the route response should include
`planner.valid: true`, `trip.legs` and manoeuvres. If startup fails, inspect logs
and disk/memory before rebuilding; do not delete the graph as a first response.

## 4. Enable HTTPS for the phone

DNS and HTTPS are already configured on the deployed instance. Its protected
`/opt/bendbound/routing/.env` contains `ROUTING_HOSTNAME=api.bendboundapp.com` and
the generated `ROUTING_API_TOKEN`. To start/reconfigure the proxy through SSM:

```sh
cd /opt/bendbound
sudo docker compose --env-file routing/.env \
  -f routing/compose.yml -f routing/compose.small.yml \
  -f routing/compose.ec2.yml up -d
```

Caddy requests/renews TLS certificates automatically and forwards permitted
requests to the API. Its certificate state persists under `.data/caddy`.
[Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

Wi-Fi and mobile data both work. All HTTPS API endpoints, including `/health`,
require `Authorization: Bearer <pilot-token>`; missing/incorrect tokens return
JSON HTTP 401. The API permits 30 requests per client IP and 120 total per
60-second window, with at most two requests in flight. Excess requests return
429; rate-limit responses include `Retry-After`. Caddy overwrites the client-IP
header so callers cannot bypass per-IP limits with forwarded headers.

The shared pilot token is extractable from the app bundle. It limits casual
access, but is not individual user authentication. Replace it with user
authentication for a broader production rollout. No AWS credentials enter the app.

On this Mac, the ignored `roams/.env` is already configured. The required values
for a new build are:

```dotenv
EXPO_PUBLIC_ROUTING_URL=https://api.bendboundapp.com
EXPO_PUBLIC_ROUTING_TOKEN=<same pilot token as the server>
```

Restart Metro/rebuild the bundle. For EAS cloud builds, configure both values in
the selected EAS build environment; the ignored local `.env` is not a reliable
way to pass them to the cloud builder. No TestFlight build was submitted by this
deployment. Test standard/round trips, turn arrows and manoeuvres after rebuilding.
The URL and token are public bundle configuration. Leaving the URL empty restores
the existing provider path. See [Expo environment variables](https://docs.expo.dev/guides/environment-variables/).

## 5. Run the same GraphHopper benchmark on EC2

```sh
cd ~/bendbound
sudo docker run --rm -v "$PWD/routing:/work" -w /work node:22-alpine node prepare.mjs --graphhopper
sudo docker compose -f routing/compose.yml --profile benchmark up -d graphhopper
sudo docker compose -f routing/compose.yml logs -f graphhopper
curl --fail http://127.0.0.1:8989/info
sudo docker run --rm --network host -v "$PWD/routing:/work" -w /work node:22-alpine node benchmark.mjs
```

Results are in `routing/results/latest.json`. After comparison:

```sh
sudo docker compose -f routing/compose.yml stop graphhopper
```

This keeps the app on Valhalla and frees the benchmark engine's memory. Set an AWS
budget alert and stop the EC2 instance when not testing; attached disks/public IPs
can still incur charges. Back up the map manifest and service config. Map upgrades
should use a fresh graph set, with health/benchmark checks before switching over.


### Directional area deployment — 8 October 2026

The catalogue API now accepts `radiusKm` for a buffered 120° cone, filters full
PostGIS sections before its shortlist limit, and validates every route vertex
against that area. Existing clients without the field retain the prior policy.
The deployment remains on the t3.medium instance with CloudWatch logging and
Neo4j on demand. No map or graph import was changed.

Five live cone requests passed, covering all four headings and two radii.
E14 3TA south / 40 km succeeds with radius 25 km, returning 38.917 km in 10.35 s;
radius 20 km was too tight for the tested road access. Existing pilot gates also
passed. The rollback source archive is
`/opt/bendbound/cone-routing-backup-20261008.tgz`.

See [directional area policy](../routing/catalogue/DIRECTIONAL_AREA.md) and
[deployment verification](../routing/catalogue/ec2/directional-area-verification.json).
The map UI still needs a new TestFlight build; no build has been submitted.


### Cone-angle correction and internal-detour cleanup — 8 October 2026

The second planning slider selects the cone angle (10–180°); reach scales with
half the ride distance, capped at 100 km for current pilot coverage. The API
accepts `coneAngleDegrees` and remains compatible with previous radius clients.

The confirmed client request at 16:15 BST returned 47.267 km with 2.672 km
repeated. The planner had stopped after fully traversing a short geometry-rated
section. Accepted loops now receive cleanup of internal spurs and side circuits
with doubled connectors, legal rerouting, and comparison with clean alternatives.
Clean valid loops win over a higher road score with internal backtracking. The
physical two-pass / 10% allowance remains a fallback; road identity and distance
checks are unchanged.

Live recreations return 38.920 km with the phone's current protocol and 39.258 km
with the new angle protocol. Both have zero detected internal repetition and
0.342 km common access. These checks took about 16 seconds. All five existing
pilot-route checks and three angle checks passed. The revised slider needs an
app rebuild. See [verification](../routing/catalogue/ec2/angle-excursion-verification.json).

### Valhalla graph ratings experiment — 8 October 2026

The active London API now uses the Valhalla graph for road identity, geometry,
spatial catalogue searches and route-reuse validation. Motorcycle ratings and
recommendation provenance are attached through a compressed overlay tied to the
SHA-256 of the existing tile archive. Native edge and shortcut cost factors make
ratings influence motorcycle pathfinding. Directions and the ordered edge path
come from one native protobuf route calculation; PostGIS and trace matching no
longer verify generated loops.

PostGIS is stopped temporarily. Its volume, original catalogue adapter and source
metadata export are retained. Neo4j remains preserved for future work. The cone,
distance bounds, twice-per-segment rule and 10% repeated-distance allowance remain
active. CloudWatch distinguishes the main planner from the fallback and records
whether the fallback was attempted, including when the main candidate wins.

The AWS wrapper enables this backend when `.data/graph/enabled` exists and retains
CloudWatch logging. Operational and rollback details are in
`routing/catalogue/graph/README.md`; the runtime backup is
`/opt/bendbound/valhalla-graph-backup-20261008.tgz`. The API retains its 512 MB limit
with a 320 MB Node heap, and the native graph bridge has a 256 MB limit with a
64 MB tile cache. The app's existing radius protocol and the new angle protocol
are both supported by this server change.
