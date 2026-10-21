# Valhalla road ratings pilot

Valhalla 3.9.0 supplies the authoritative routing graph and all serving geometry.
`export.py` migrates rating metadata from the retained PostGIS catalogue onto
Valhalla's native edges. The initial migration uses OSM way identity and checks
that entire native edges belong to the source section. Unmapped sections are
reported, rather than silently assigned to neighbouring roads. Native geometry,
physical identities, directed edge IDs and metadata are stored in a compressed,
versioned rating overlay. PostGIS is not consulted by the active backend.

`bridge.py` reads edge geometry directly from the same graph tiles used by the
routing engine. The SHA-256 of the tile archive binds the rating overlay and
bridge to a specific graph build, including rebuilds of the same OSM extract.
A mismatch fails closed. No coordinates or request bodies are logged by the
bridge. Its network port is internal to Docker; it has a bounded tile cache.

Routes use Valhalla's protobuf API to retrieve directions and the original ordered
edge sequence in one calculation. This preserves repeated traversals that trace
matching can collapse. Opposing edges are grouped by their canonical native
geometry and OSM way ID. Fractions along each edge distinguish separate pieces
of a road. An additional native-path geometry guard checks overlap across graph
hierarchy representations. The existing distance, cone, London area, twice-per-
segment and 10% repeated-distance policies remain enforced.

Ratings use bounded cost discounts: up to 10% for fast, 20% for winding, and 25%
for twisty, applied to up to 32 shortlisted sections. The export maps ratings onto directed edge IDs at every hierarchy level and
the covered fractions of native shortcuts. Requests supply these compiled
factors directly through Valhalla's protobuf costing options. No runtime
geometry matching is needed to apply ratings. Restrictions are never overridden.

CloudWatch planner summaries expose `catalogueBackend`, `routeSource`,
`fallbackAttempted` and `ratingFactorsApplied`. `routeSource` describes the
returned candidate; `fallbackAttempted` also records an unsuccessful fallback.
Fallback diagnostics include the actual shared verifier's rejection, and repeated
identical engine requests are skipped.

## Migration and operation

1. Export section metadata, source links and OSM way IDs from the existing catalogue
   to JSON Lines. This is a one-time migration input, not a serving dependency.
2. With the pinned Valhalla container, run
   `valhalla_ways_to_edges -c /data/valhalla.json`.
3. Run `export.py --source ratings-source.jsonl --output /data/ratings.json.gz`.
4. Copy the overlay to `routing/.data/graph/ratings.json.gz`.
5. Build the API and run the additional `graph.compose.yml` services for preflight
   tests. Test the main planner with `allowFallback:false` as well as the combined
   planner. Do not accept an overall success as proof of main-planner success.
6. Create `routing/.data/graph/enabled` to enable the overlay in `compose-aws.sh`.
   Recreate the API, and stop PostGIS after health and route tests pass. Retain its
   volume, the Neo4j graph and the legacy adapter during this experiment.

Ratings do not carry across an arbitrary tile rebuild. Regenerate and test the
mapping before enabling a new graph. The original recommendation metadata stays
available in the retained database and migration export.

## Rollback

Remove `.data/graph/enabled`, restore the pre-migration runtime archive, rebuild
and start the API with PostGIS. Stop the graph bridge after traffic has recovered.
Do not delete either database volume or the original routing instance. The AWS
wrapper always retains the CloudWatch overlay.

The protobuf schema is generated from Valhalla's MIT-licensed 3.9.0 descriptors:
`node graph/build-schema.mjs /path/to/valhalla-3.9.0`. The upstream licence is
included beside this file. Keep the schema and image pinned together.

## Validation notes

The native cost check uses a single-edge route: a factor of 0.75 must reduce its
search cost by 25%. Valhalla's bidirectional path builder recalculates the returned
full-route cost without custom edge factors, so an unchanged cost summary for a
long route does not demonstrate that the search ignored the ratings. Overlapping
rating ranges are partitioned before submission so discounts remain bounded.

Validation pins all edges needed by the current candidate before updating its
bounded cross-request cache. This prevents a new lookup from evicting another
edge that the same candidate still needs. A regression test covers this failure
with a one-entry cache, and the live checks repeat routes after warming the cache
with requests from multiple parts of the pilot area.
