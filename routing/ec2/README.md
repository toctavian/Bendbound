# EC2 routing pilot

Deployed and verified through AWS MCP on **2026-10-06** in **eu-west-2 (London)**.
Stack: `bendbound-routing-london`; instance: `i-0bd903e525ebce321`.
[Open the instance](https://eu-west-2.console.aws.amazon.com/ec2/home?region=eu-west-2#InstanceDetails:instanceId=i-0bd903e525ebce321).
The instance is left running. See [deployment.json](deployment.json) for resource
IDs, map checksum, costs and recorded smoke-test results. HTTPS is live at
**https://api.bendboundapp.com**, backed by Elastic IP **16.60.63.241** and Route 53
zone `Z07131531TX895IIR7J1N`. The certificate is issued by Let's Encrypt and Caddy
renews it automatically. [HTTPS verification](https-verification.json) records
successful real routes, token rejection and request-limit checks.

Valhalla 3.9.0 reports `ready`. A standard 8.234 km route returned 9 manoeuvres;
the guide's round trip returned a valid 19.071 km loop, 51 manoeuvres and zero
repeated distance. The final warm requests took 0.056 s and 0.852 s respectively.
After testing, Valhalla used 170 MiB and the API 85 MiB; the host had 1247 MiB RAM
available and 8.3 GiB disk free, with 21 MiB swap used. Both containers had zero
restarts and no OOM kills. These are smoke-test observations, not load-test
capacity guarantees from the initial private deployment. After enabling HTTPS,
lint, typecheck, 10 routing tests and 5 app integration tests passed locally.

This deployment uses the Greater London extract and runs Valhalla plus the Node
API. `template.json` provisions one Ubuntu 24.04 ARM64 `t4g.small` (2 vCPU, 2 GiB
RAM), a 16 GiB encrypted gp3 root disk, an SSM instance role, and a security group
with **only TCP 80/443 inbound** in an existing public subnet. An Elastic IP and
DNS A record keep the hostname stable across instance stop/start. There is no
load balancer, NAT gateway or SSH key. The raw API/engine ports stay on loopback
and closed in the security group. IMDSv2 is required and containers cannot reach instance
credentials through the metadata hop limit.

CPU credits use Standard mode, so sustained CPU load is throttled after credits
are exhausted instead of incurring surplus-credit charges. This is for light
pilot use. `compose.small.yml` limits Valhalla to 1400 MiB RAM and permits swap;
the host has 2 GiB swap for import headroom. API memory remains capped at 256 MiB;
Caddy is capped at 128 MiB.
Docker logs rotate. Do not run GraphHopper on this host alongside Valhalla.

## Provisioning and service files

Use AWS MCP `run_script` with CloudFormation `CreateStack`, region `eu-west-2`,
stack name `bendbound-routing-london`, the contents of `template.json`,
`CAPABILITY_IAM`, and `VpcId` / `SubnetId` parameters for an existing public subnet.
Also provide `HostedZoneId` and `RoutingHostname` for the existing public zone.
The template embeds `cloud-init.sh`; keep its `UserData` copy synchronized when
editing the script. Cloud-init installs Docker/Compose, configures swap, starts
SSM, and creates `/opt/bendbound/host-ready` after successful setup.

After the instance is online in SSM, transfer only `compose.yml`,
`compose.small.yml`, `compose.ec2.yml`, `Caddyfile`, `prepare.mjs`, `valhalla/`,
`service/`, `ec2/start.sh` and `ec2/smoke.py` into `/opt/bendbound/routing`. The deployment uses
an archive carried in an SSM `AWS-RunShellScript` command, so no S3 bucket or SSH
access is needed. Do not transfer `.env`, app source, `.data`, `.tools` or results.
Run `bash /opt/bendbound/routing/ec2/start.sh` as root through SSM after cloud-init
completes. This downloads the map, imports the graph and starts both services.
For HTTPS, create a separate mode-600 server `routing/.env` containing
`ROUTING_HOSTNAME` and a randomly generated `ROUTING_API_TOKEN`, then start with
all three Compose files and `--env-file routing/.env` as below.

## Phone and TestFlight access

The pilot works from **any network**, including mobile data. All HTTPS endpoints
require a shared bearer token. The app now reads `EXPO_PUBLIC_ROUTING_TOKEN` and
adds the `Authorization` header; this Mac's ignored `.env` contains that token and
`EXPO_PUBLIC_ROUTING_URL=https://api.bendboundapp.com`. Do not commit the token.
It is still visible in a compiled app, so this pilot mechanism is not individual
user authentication. The server copy is in `/opt/bendbound/routing/.env`.

Missing or incorrect tokens return JSON 401. Requests with valid tokens are
limited to 30 per client IP and 120 total per 60-second window, with at most two
requests in flight. Rate-limited requests return 429 and `Retry-After`. Caddy
overwrites the client-IP header and accepts bodies up to 64 KB. Token values are
not logged. Clients on the same NAT/mobile egress IP share the per-IP quota.

Existing TestFlight binaries do not acquire this configuration automatically.
Build and submit a new version with both environment values present. For EAS,
set them in the build's selected EAS environment because the local `.env` is
ignored by Git. No TestFlight build was submitted in this deployment.

To rotate the pilot token, generate a new random value, update the server `.env`,
recreate Caddy using the Compose command below, and rebuild the app with the same
new value. Existing builds using the old token will receive 401.

## Access and operations

Open EC2 → instance → Connect → Session Manager, or use an AWS-authorized local
CLI with the Session Manager plugin for a tunnel:

```sh
aws ssm start-session --region eu-west-2 --target i-0bd903e525ebce321 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8088"],"localPortNumber":["18088"]}'
```

From your Mac while the tunnel runs:

```sh
curl --fail http://127.0.0.1:18088/health
curl --fail http://127.0.0.1:18088/round-trip \
  -H 'Content-Type: application/json' \
  -d '{"center":{"latitude":51.481,"longitude":-0.009},"targetKm":20,"direction":90,"profile":"winding","avoidMotorways":true}'
```

This administrative tunnel bypasses the Caddy token check; SSM itself requires
AWS authorization. For normal phone/simulator use, use the HTTPS URL configured
in `.env`. Persist networking changes in the CloudFormation template.

On the instance, inspect services with:

```sh
cd /opt/bendbound
sudo docker compose --env-file routing/.env -f routing/compose.yml -f routing/compose.small.yml -f routing/compose.ec2.yml ps
sudo docker compose --env-file routing/.env -f routing/compose.yml -f routing/compose.small.yml -f routing/compose.ec2.yml logs --tail 100
sudo docker stats --no-stream
free -h
df -h /
```

Containers restart automatically after Docker or instance restart. Graphs persist
on the root disk under `/opt/bendbound/routing/.data`. The map manifest records
the input URL and checksum. Stop the instance when unused to stop compute
charges; its addresses and graph remain. The Elastic IP continues to
incur IPv4 charges while the instance is stopped.
Deleting the CloudFormation stack terminates the instance **and deletes its root
disk and routing data**; preserve any desired snapshot/configuration first.

## Cost

AWS Price List API checked on 2026-10-06 for London: compute $0.0188/hour, gp3
$0.0928/GiB-month. One public IPv4 costs $0.005/hour. At 730 running hours, the
baseline estimate is **$18.86/month** ($13.72 compute + $1.48 disk + $3.65 IPv4),
before tax and any charged data transfer; credits/free-tier benefits are excluded.
A stopped instance retains about **$5.13/month** of disk plus Elastic IP cost.
Route 53 hosted-zone/query charges and annual domain registration are additional.
Configure a budget
alert to a notification address you control if running it continuously.

Sources: [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/),
[EBS pricing](https://aws.amazon.com/ebs/pricing/), and
[public IPv4 pricing](https://aws.amazon.com/vpc/pricing/).
