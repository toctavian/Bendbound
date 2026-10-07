# Deploy the routing pilot to EC2

**Client policy update, 2026-10-07 — pending app release:** The self-hosted app now
uses the server's `planner.valid: true` decision and checks response integrity
only. Distance, overlap, closure and snapping limits are no longer repeated in
the client. One new app build is required; future compatible server policy
changes do not require another build. This client works with the existing API
contract. The shared-access server deployment below remains pending.

**Shared-access update, 2026-10-07 — local only:** The app and API now allow a
continuous start/finish access section of up to 500 m one way, also capped at 5%
of the full route one way. Both traversals count toward the route distance;
repeats elsewhere remain invalid. Local checks from the reported start passed
40 km Winding searches north/east/south (37.361 / 35.093 / 38.917 km), with
257 m of shared access. West still exhausted the search budget. All three
successful results also passed the app's then-current independent validation with manoeuvres.
122 app tests, 11 routing tests, lint and typecheck passed. Deployment is pending:
AWS MCP returned `Unknown tool: aws___run_script` on both attempts; no remote
files were changed. Copy the updated `service/engine.mjs`, `service/geometry.mjs`
and `service/planner.mjs`, restart the API, and verify live routes when MCP is
available again. A new TestFlight build is also required for the app validator.
See [the shared-access policy](../routing/README.md#shared-startfinish-access).

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
