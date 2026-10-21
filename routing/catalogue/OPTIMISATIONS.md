# Pilot optimisations

The EC2 pilot uses `t3.medium` (2 vCPUs, 4 GiB) after verification of the same
instance, 64 GiB map/database disk and stable API address. CPU credits remain
Standard. The original server and its disk remain available for rollback.

## Less repeated work

Successful round trips are cached for 60 seconds using the exact validated
GPS centre, distance, direction, style and motorway setting. There is no GPS
rounding or nearby-start reuse: that can select a different access road. Only
explicitly accepted routes are cached; failures are retried. The cache is an
LRU capped at 128 entries and 16 MiB. Each HTTP request still gets its own
reference ID and rate limiting; CloudWatch completions expose
`cache.status` (`hit`/`miss`) and `cache.ageMs` on hits. Cached planner elapsed
time describes the original generation; `durationMs` measures this request.

Exact nearby-road queries have a separate 60-second, 8 MiB cache. Health checks
still query live PostGIS version/readiness markers, but reuse expensive table
counts for 60 seconds, invalidating them when the graph version changes. Engine
health is checked live on every health request. Caches are in process memory
and clear on API restart. Restart the API after any map/catalogue or policy
change; the prepare script does so automatically.

Routes at least 10 km too short are rejected before expensive geometry/overlap
assessment and map matching. Overlong routes retain spur repair, which can
recover valid loops; a general early distance rejection would regress the
E14 west fixture. The earlier optimisations remain: stop on a verified full
section, retain valid ordinary loops, skip unnecessary fallback, and reserve
ordinary-loop search time within the 25-second budget. Hard route constraints
are unchanged.

## Connectivity graph on demand

The Neo4j database and imported 4.3 million directed connections remain on disk.
The EC2 Compose overlay puts the service behind the `graph` profile, and routine
route generation uses Valhalla/PostGIS without keeping Neo4j running. API health
reports `catalogue.connectivity.mode: on-demand` and
`status: prepared-on-demand`; it checks matching PostGIS import markers rather
than asserting that Neo4j is online. Local base Compose retains required/online
graph mode.

To use the preserved graph later:

```bash
cd /opt/bendbound/routing
bash catalogue/compose-aws.sh --profile graph up -d neo4j
# Run graph queries or the existing graph_ready.py verification after readiness.
bash catalogue/compose-aws.sh stop neo4j
```

To require live graph health on EC2, set `GRAPH_MODE=required` in the private
`catalogue/.env`, start Neo4j explicitly, and recreate the API. Revert it to
`on-demand` to use the cheaper operating mode. The import script starts Neo4j
explicitly and stops it after completion in on-demand mode.

Measured host memory before changes was about 1.9 GiB, including roughly
810 MiB for Neo4j. After stopping it, memory use fell to about 1.1 GiB on the
original host. Cold route, cache, concurrency and memory checks on the 4 GiB
host are recorded in [optimisation-verification.json](ec2/optimisation-verification.json).
These are bounded pilot checks, not a sustained-load capacity guarantee.

Keep the 64 GiB storage allocation; shrinking an EBS volume is not an in-place
cost optimisation. Large map/graph imports should temporarily use `t3.large`
or larger, then return to the verified pilot size. Change the stack's
`InstanceType` parameter using the current pinned-AMI template; resizing causes
a short restart. The original instance, volumes and Elastic IP are preserved.
