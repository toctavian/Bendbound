# Directional round-trip area

The round-trip screen previews a cone about the selected heading. Its opening
angle is adjustable from 10° to 180° (default 120°). Its geographic reach is half
the selected ride distance, capped at 100 km for the current pilot. The two
sliders select total riding distance and cone angle. The solid
boundary shows the requested area; a lighter dashed boundary shows the allowed
road-access margin: 15% of the radius, with a minimum of 1 km and maximum of 5 km.
The whole route must also remain inside the existing London 100 km pilot area.

The start field uses existing Photon address/place search. Choosing a result or
holding the map and selecting **Start from here** moves the cone to that point.
The location button restores GPS as the start. Creation uses the point shown in
the preview; a new GPS request cannot overwrite a selected address or pin.
On smaller screens, the planning controls scroll to leave room for the map.

## Request and policy

`POST /round-trip` accepts `coneAngleDegrees` and derives `radiusKm` from half
the target distance. The former numeric `radiusKm` field remains supported for
older clients. Starts, total
kilometres, heading, riding style and motorway preferences retain their existing
fields. Requests without either area field keep the legacy geographic search, so existing
TestFlight builds remain compatible. Clients requesting a radius require
`planner.insideCone === true` before accepting the response.

`src/utils/roundTripArea.ts` owns the cone, buffer and containment geometry.
`node routing/build-geometry.cjs` generates `routing/service/cone.mjs`, the server
copy. `--check` verifies both geometry generators remain synchronised.
The shared local projection forms a convex sector and a rounded convex buffer.
Checking all route vertices therefore also checks the straight segments joining
them; there is no sparse-geometry escape through the boundary.

PostGIS applies `ST_CoveredBy` to full stored road sections **before LIMIT**.
Sections crossing the buffered boundary are omitted, rather than truncated or
claimed as fully traversed. Ordinary-road search remains available inside the
same area. Catalogue waypoints use the requested heading; ordinary search
retains its riding-style and repair variants, but only sends waypoints inside the
buffered cone. Both paths cap waypoint reach at the selected radius,
and the final complete routed geometry is checked against the buffered boundary.
An unsuitable radius/distance combination returns an actionable `NO_MATCH`
instead of returning a ride in the opposite direction.

Distance, closure, start-snapping, motorcycle access, motorway exclusion and
physical road reuse remain enforced. The new response diagnostics include
`insideCone`, `coneRadiusKm` and `coneBufferKm`. CloudWatch logs these scalars and
the requested radius and cone angle; exact failed starts retain the existing privacy policy.
Successful-route caches include the canonical angle and radius as well as all existing
options. Nearby-road caches include the actual polygon.

## Validation and deployment

Local validation: app tests, catalogue tests, original routing tests, lint,
typecheck, generated-geometry drift check and iOS production bundle export.
Tests exercise live cone changes, heading/radius request propagation, selected
addresses and pins, unchanged custom starts, rejection of out-of-cone loops,
accepted-loop confirmation, bounded fallback waypoints and radius-specific
cache isolation.

**Deployed and verified on 8 October 2026** at
`https://api.bendboundapp.com`, on the existing t3.medium instance. AWS browser
login restored MCP access. All five cone requests passed complete geometry,
distance and reuse checks, across north/east/south/west headings and two radii.
CloudWatch records the cone parameters and acceptance metrics. Existing pilot
routes and legacy-client compatibility passed. See
[directional-area-verification.json](ec2/directional-area-verification.json).

The E14 3TA southbound 40 km fixture requires a 25 km radius (3.75 km margin),
returning 38.917 km inside that area. The 20 km radius returned `NO_MATCH` because
the tested routes leave its boundary. Keeping the existing riding-style search
and repairs, with every waypoint constrained to the buffered area, restored the
valid loop; forcing all ordinary shapes to the sector's outer angles did not.
The UI requires a new TestFlight build; none has been submitted.

For subsequent deployments, Deploy the updated `routing/service/cone.mjs` and catalogue service files into
`/opt/bendbound/routing`, preserving the host's private `.env`. Use the AWS
Compose wrapper so CloudWatch and graph-on-demand settings remain active:

```sh
cd /opt/bendbound/routing
bash catalogue/compose-aws.sh up -d --build --no-deps api
```

No map, PostGIS import or Neo4j rebuild is needed. Run the original `verify.py`
pilot gates, then run the new directional gate with Node 22:

```sh
node routing/catalogue/verify-cone.mjs \
  --base https://api.bendboundapp.com \
  --env-file .env \
  --output /tmp/bendbound-cone-live-verification.json
```

The gate checks public test starts, all four headings, two radii, every complete
route vertex, distance/reuse limits, invalid-radius rejection and legacy-client
compatibility. All checks passed against the deployed engine.
The generated iOS export is a local build check, not a submitted TestFlight build.


## Angle clarification and internal detours — 8 October 2026

The second slider now controls angle, as originally intended. The independent
radius control was an incorrect interpretation. The preview and backend share
one angle-aware geometry implementation; radius scales with half the ride
length, subject to pilot coverage. Tests and
[verify-angle.mjs](verify-angle.mjs) cover angle propagation and full-path bounds.

The confirmed 16:15 BST client request returned 47.267 km with 2.672 km repeated.
It chose the full 0.528 km Rick Roberts Way section, rated by geometry with zero
guide recommendations, and stopped before comparing cleaner alternatives.
Full-section traversal does not make the roads connecting it independent.

Accepted loops now receive internal-excursion cleanup too. Pure spurs and smaller
side circuits reached through a repeated connector can be removed while keeping
the main circuit. Repairs use legal engine navigation and 30 m snapping for
already-routed anchors. Candidate selection prioritises a valid clean loop over
a higher road score with internal reuse; the ordinary fallback searches past its
first accepted repeating loop. Existing distance, physical identity, maximum two
traversals and 10% repeat allowance remain enforced. The allowance remains a
fallback when no clean route is found within the search budget.

Normalising a finish snap within 20 m is used only to diagnose common access vs
internal repetition. Original geometry remains authoritative for road identity,
reuse and acceptance. A separate conservative cleanup preserves the main loop
when its snapped finish differs from its start; previously the general pruning
helper could collapse that loop. Established repairs for invalid/overlong
candidates remain available for route-search compatibility.

Live recreation of the reported request now returns 38.920 km for the current
radius client and 39.258 km for the angle client. Both have zero detected
internal repetition and about 0.342 km common access. These checks took about
16 seconds, reflecting additional search for a clean loop. The angle slider
requires a new app build. See
[angle and excursion verification](ec2/angle-excursion-verification.json).
