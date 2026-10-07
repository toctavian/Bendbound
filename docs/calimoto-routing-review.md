# Calimoto public-repository review

Reviewed 5 October 2026, including all 12 public repositories returned by the
[organisation's repository listing](https://github.com/orgs/calimoto-GmbH/repositories).

## What is available

- [calimoto-logic](https://github.com/calimoto-GmbH/calimoto-logic) provides a
  shared coordinate abstraction between routing and map frameworks. Its small
  Java source tree contains coordinate collections/factories, distance and
  projection helpers, math wrappers, and time utilities. I did not find a routing
  graph search, winding-road scorer, or round-trip generator there.
- [CaloCoordinateUtil](https://github.com/calimoto-GmbH/calimoto-logic/blob/master/core/src/main/java/com/calimoto/logic/CaloCoordinateUtil.java)
  contains latitude projection and geographic distance calculations. Bendbound
  already has corresponding distance and geometry helpers; importing the Java
  package would not add a routing engine.
- [mapsforge-map-reader-ios](https://github.com/calimoto-GmbH/mapsforge-map-reader-ios),
  [mapsforge-calimoto](https://github.com/calimoto-GmbH/mapsforge-calimoto), and
  [VTM-calimoto-Version](https://github.com/calimoto-GmbH/VTM-calimoto-Version)
  concern map data, reading, and rendering. They suggest useful offline-map
  architecture, but do not provide the route-selection algorithm we need.
- The remaining repositories include geocoding, database, OSM data parsing and
  general application/deployment utilities. I found no public Calimoto routing
  API implementation or reusable winding-route engine in this organisation.

This review cannot establish what Calimoto uses in its private production code.
No source from these repositories was copied into Bendbound.

## Ideas for Bendbound

These are recommendations based on the review and our current code, not claims
about Calimoto's private routing algorithm.

1. Keep routing independent of map rendering. Maintain one canonical route
   geometry for turn arrows, progress, stops, POIs and route validation. Our
   MapLibre map can stay in place when the routing service changes.
2. Score actual road curvature. In `src/utils/routes.ts`, winding/twisty loop
   shapes differ, but the current Valhalla request chiefly adjusts motorway,
   toll and trail preferences. Trail preference is not a winding-road score, and
   the displayed curve estimate is currently derived from route distance/profile.
   A useful next improvement is curvature per kilometre from resampled road
   geometry, suppressing GPS/shape noise and sharp urban junctions. Use that
   score to compare routes, rather than treating more detours as more curves.
3. For stronger route selection, use a controlled routing backend with road-edge
   costs for curvature, surface/access suitability, road class and junctions.
   Repeated-road detection should use undirected road-edge identities when
   available; geometry overlap remains a fallback. This would improve on the
   current public-endpoint requests and geometric loop retries.
4. Put round-trip search behind one app request. Send start, target distance,
   tolerance, direction, stop order and preferences to that backend. It can run
   candidate searches internally and return the best valid route or an honest
   no-match response. One HTTP call does not imply one calculation, and strict
   distance/non-repetition requirements are not feasible for every road network.

The best next routing experiment is to measure candidate curvature and road
repetition on a fixed set of real rides before changing providers. Calimoto's
public code alone does not remove the need for that routing work.
