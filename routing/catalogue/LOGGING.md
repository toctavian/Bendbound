# Routing logs

The live EC2 catalogue API, Valhalla engine and Caddy HTTPS proxy send stdout and
stderr to Amazon CloudWatch Logs in **eu-west-2**, log group
**`/bendbound/routing/london`**, with **14-day retention**.

[Open the log group](https://eu-west-2.console.aws.amazon.com/cloudwatch/home?region=eu-west-2#logsV2:log-groups/log-group/$252Fbendbound$252Frouting$252Flondon).
In CloudWatch → Logs Insights, select this group and a time range covering the
incident. Three saved queries are available:

- **Bendbound/Failed requests**: API failures, settings, timing and diagnostics.
- **Bendbound/Find request reference**: replace `PASTE_REFERENCE_HERE` with the
  reference from the app error, then run to see API and proxy records together.
- **Bendbound/Route latency and failures**: request counts and average/p95
  latency grouped by response status and five-minute window.

Queries are stored in [log-queries.json](ec2/log-queries.json). Through AWS MCP,
`logs.FilterLogEvents` can also retrieve a reference using `logGroupName` above
and `filterPattern` set to a quoted reference string. `logs.StartQuery` /
`logs.GetQueryResults` run the saved query text programmatically.

## Records and references

The API emits JSON `server.started`, `request.started` and `request.completed`
events. Each request gets a fresh server-generated UUID in `X-Request-Id`;
caller-supplied request IDs are ignored. Errors include the same `requestId` in
their JSON response and append `Reference: <uuid>.` to the existing message.
Current TestFlight builds display that message without another app release.

Completion records contain method, known endpoint, HTTP status, elapsed
milliseconds and error code. Successful round trips add compact planner metrics
including measured distance, attempts, repeated-road measurements, catalogue
coverage and selected road section. Routing failures include the submitted
distance, direction, riding style, motorway preference, **exact failed start
coordinate**, and bounded candidate/fallback policy diagnostics. This is enough
to reproduce the GPS start rather than guessing from a postcode. Successful
start coordinates and point-to-point locations are not recorded.

Failed round trips also record `startRoads.roads`: the **actual starts of routed
candidates**, captured from engine response geometry, including repairs and
fallback attempts. Each entry includes:

- `names`, `osmWayId`, `osmWayUrl` and `engineEdgeId` to identify the road even
  when it is an unnamed access road.
- `requestedStart` and `snappedStart`, with `snapDistanceMetres` and
  `departureBearing` to distinguish nearby roads and opposite departures.
- `attempts` listing the engine-call numbers that used that start.
- `identityStatus` and `nameSource` indicating how the identity was obtained.

`snapDistanceMetres` measures from the original GPS `input.center`. A repair's
`requestedStart` may already be a snapped point, which is recorded separately.

An `edge_walk` identity comes from matching up to the first 150 m of the actual
Valhalla route, using exact edge walking rather than a nearest-road guess. If
lookup fails, `identityStatus: unavailable` preserves the snapped point and
route-maneuver names without asserting a way ID. If no engine call produced a
path, `status: no_routed_start` reports failed calls and `candidates` from the
engine's locate operation; these are explicitly `candidate_only`.

For reproduction, copy the logged **`input`** into a POST to `/round-trip` with
the existing pilot credential. Keep its original GPS `center`; substituting
the snapped point can change road correlation. Use `osmWayUrl` to inspect the
reported start road, and compare the new reference's snapped points, IDs and
departure directions with the original. Use the same deployed map/service
version when investigating a regression. Search-time budgets and engine load
can change the chosen candidates, so replaying an input does not guarantee an
identical outcome.

Up to eight distinct departure shapes are captured per request, with bounded
attempt lists and `omittedStarts` when the cap is reached. Identity lookups happen
only after a round-trip failure and share a two-second deadline. Successful
searches perform no extra engine lookup and still omit start coordinates/roads.

API logging uses explicit field allowlists. It excludes bearer tokens, request
headers, IP addresses, arbitrary body fields, error messages/stacks, complete
routes, road geometries and catalogue source URLs. OSM way inspection links are
generated from the verified numeric road IDs. Caddy access/runtime logs filter request
headers, URI/query, peer/client address, TLS details and response headers; access
events retain status, timing and the API response's request ID. Proxy 401s that
never reach the API can be found by status/time; they have no API request ID.
Engine logs record its own operations without app credentials. Diagnostics are
capped at 40 entries per array and three levels of nesting.

Client disconnects record status `499` / `CLIENT_DISCONNECTED` and cancel the
planner. API rate limiting, busy responses, validation failures and dependency
faults are also recorded. A started request with no completion can indicate a
process restart; inspect adjacent startup/proxy/engine events.

## Deployment and operation

Use this wrapper for **all EC2 Compose operations**, including API rebuilds,
so future deployments retain the CloudWatch logging overlay:

```bash
cd /opt/bendbound/routing
bash catalogue/compose-aws.sh up -d --build --no-deps api
bash catalogue/compose-aws.sh logs --tail 100 api
```

The EC2 prepare script uses the wrapper too. Local development continues to use
`catalogue/compose.yml` by itself; it requires no AWS logging credentials.
The overlay sends API, engine and proxy logs to distinct container-name/ID
streams. Postgres and Neo4j retain their existing local Docker logs.

CloudFormation owns the log group and scoped EC2-role permission to create
streams and write events only in this group. Docker obtains temporary credentials
from the instance profile; no AWS keys are added to containers or app settings.
The deployed [logging-template.json](ec2/logging-template.json) and current
[template.json](ec2/template.json) pin the running AMI, avoiding incidental EC2
replacement during this logging update. The group is retained if the stack is
deleted, while its events still expire after 14 days.

Use the current template for later infrastructure updates; `logging-template`
is the historical logging deployment snapshot. The pilot now keeps Neo4j on
demand and uses the smaller host described in [OPTIMISATIONS.md](OPTIMISATIONS.md).
Completion logs include `cache.status`/`cache.ageMs`; cached replies retain the
original planner timing, while `durationMs` measures their current latency.

Delivery uses Docker's `awslogs` driver with a 4 MiB nonblocking buffer, so a slow
logging service does not stall route generation. Events can be lost if that
buffer fills during an outage. Docker's local log cache remains available via
the wrapper's `logs` command. CloudWatch ingestion/storage and Logs Insights
scans incur usage-based charges; existing host cost estimates exclude those.

Deployment proof, smoke-test references and delivered CloudWatch events are in
[logging-verification.json](ec2/logging-verification.json). The verification
uses public synthetic coordinates, not a rider's location history.

[Start-road verification](ec2/start-road-verification.json) records a live failed
loop starting on Freshfield Bank (OSM way 27863688), resolved with exact edge
walking, and the successful E14 south regression check.

References: [Docker awslogs driver](https://docs.docker.com/engine/logging/drivers/awslogs/),
[CloudFormation log groups](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-loggroup.html),
[Caddy access-log filters](https://caddyserver.com/docs/caddyfile/directives/log).
