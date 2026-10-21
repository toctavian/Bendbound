# Bounded road reuse

The catalogue planner now permits two traversals of a physical segment, counting
both directions together, with additional repeated distance capped at 10% of
the actual ride distance. All travel, including repetition, contributes to the
requested distance. The existing strict distance error `<10 km`, 20 m closure,
200 m start proximity, London area and engine access/motorway rules remain.

Valhalla trace attributes provide OSM way identity. The planner uses that
identity to associate **original routed geometry** with imported physical OSM
edges in PostGIS; it does not count an entire named road as one segment. Original
traversals are preserved even if map matching simplifies its returned shape.
Each physical edge's covered intervals are swept to measure additional distance
and maximum simultaneous traversal count. Disjoint portions remain distinct;
opposite directions overlap on the same undirected edge.

Matching uses the catalogue's existing 12 m corridor with exact OSM way identity
and endpoint projection. At least 98% of routed geometry must be accounted for,
with no more than 2% excess coverage. An additional way-identified geometry check
uses 0.5 m collinear overlap tolerance to catch third traversals or repetitions
in small portions that the imported-edge match misses. The more conservative
repeat distance/count from the two checks is enforced. This remains a geometric
OSM identity check, not lane-level attribution or live road-condition data.

If trace matching omits a short access section, the previously accepted strict
geometry subset is retained: no internal repetition, only short contiguous
start/finish access, and a separate geometry sweep proving at most two passes
and at most 10% additional distance. This is explicitly reported as
`identityVerification: strict-geometry-subset`; missing physical coverage is
not invented. A verified third traversal cannot be overridden by this fallback.

Only sub-centimetre numeric boundary spans are ignored. More than two passes or
more than 10% additional repeated distance fails acceptance. Candidate score
subtracts 100 times the repeated-distance ratio: a 5% repeated route loses five
points compared with otherwise equal road quality and distance. PostGIS quality
matching still counts each stored section's unique traversed length once, so
riding a highly rated section again cannot inflate its quality contribution.

Ordinary-loop fallback applies the same acceptance callback as guided routes.
The original service files and stopped legacy server retain their previous
policy. Restarting the catalogue API clears the successful-route cache when the
new policy is deployed.

Start/end snap differences no longer suppress allowed access-road reuse:
physical overlapping intervals count it even when endpoints differ by several
metres. `endpointGapMetres` is logged explicitly. `sharedAccessKm`,
`geometrySharedAccessKm`, `overlapRatio` and `remainingRepeatedRatio` remain
legacy geometric diagnostics, not the acceptance criterion. Clients should use
`planner.valid`; deployment checks enforce `roadUsePolicy`, `repeatedRatio`,
`maxTraversals` and `verifiedRatio`.
The strict geometry subset is identified separately rather than requiring
unavailable physical coverage for an already more restrictive accepted loop.

CloudWatch completion records include these new fields and the policy identifier
`physical-segments-twice-10-percent`. Failed requests retain their reference IDs,
start-road details and rejection diagnostics. Old error references retain the
original policy's outcome; new requests use this policy.

[Deployment and public checks](ec2/road-reuse-verification.json) include policy
unit tests and isolated PostGIS temporary-table checks for two/three traversals.
The reported Burrells Wharf Square 60 km north request was replayed from its
logged GPS input. Rider GPS coordinates are kept out of repository fixtures.
