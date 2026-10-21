# UK motorcycle road catalogue and route selection

Research date: 2026-10-07. This is a proposed plan; no application, server or AWS configuration is changed by it.

## Recommendation

Build a Bendbound catalogue of specific enjoyable road sections, backed by PostgreSQL/PostGIS. Explore licensing existing rider-rated data from Best Biking Roads first, while independently preparing a small catalogue from rider submissions and original editorial work. Add OSM-derived curvature as a separate quality signal. Keep Valhalla responsible for legal routing and manoeuvres.

An existing curated database is useful only if its licence permits Bendbound to ingest, retain, derive scores from and display its data. A downloadable GPX or a publicly reachable JSON endpoint does not establish those rights. No confirmed public, commercially reusable UK rider-popularity dataset or supported commercial API was identified in this research.

## Current implementation

- `src/utils/pois.ts` provides Overpass nearby and scenic POI queries. `fetchScenicPois` currently has no caller in `src/`.
- `src/utils/routes.ts:calculateRoundTrip` can use supplied POIs as anchors on its public-provider path. Its self-hosted path sends only the start, requested distance, direction, profile and motorway preference.
- `routing/service/planner.mjs` currently generates geometric loop candidates and returns the first valid route. It has no road-popularity catalogue and no measured road-quality ranking. Profiles affect candidate shape.
- `src/utils/routePois.ts` fetches highlights near an already calculated route. This remains useful for fuel, cafes and viewpoints, independent of road selection.
- The AWS engine covers Greater London only. It cannot validate or navigate most nationally famous riding roads. Catalogue coverage and routable map coverage must be tracked separately.

## Existing sources to evaluate

| Source | Verified value | Proposed use | Outstanding question |
| --- | --- | --- | --- |
| [Best Biking Roads](https://www.bestbikingroads.com/) | UK road/ride entries with overall and attribute ratings; examples include corners, scenery and surface | First licensing/partnership candidate for community-rated recommendations | Supported export/API, coverage, rating counts and dates, commercial reuse and price |
| [Motorcycle Diaries](https://motorcycle-diaries.com/en/faq) | Curated road sections, community favourites and GPX downloads | Second licensing candidate; section-level format fits this design | UK coverage and whether favourite/rating aggregates and geometries can be licensed |
| [Bennetts BikeSocial](https://www.bennetts.co.uk/bikesocial/news-and-views/features/travel/what-are-the-best-motorcycle-routes-in-the-uk) | Editorial UK recommendations and GPX route links | Discovery and validation references; possible editorial partnership | Commercial reuse of route geometry and editorial data |
| [Adventure Bike Rider](https://www.adventurebikerider.com/article/uk-route-the-three-moors-and-meals-way/) | Published UK rides with GPX download links | Another editorial/partnership source | Reuse rights and extracting recommended sections from whole rides |
| [RoadCurvature](https://github.com/adamfranco/curvature) | OSM-based per-road curvature computation and downloadable rendered data | Objective discovery signal where rider evidence is sparse | Data licence, coverage/freshness and deployment compatibility; repository software is GPLv3-or-later |
| Bendbound rider submissions | Original favourites, section ratings and optional submitted GPX | Long-term first-party popularity evidence | Submission permission, moderation and sufficient regional coverage |

Best Biking Roads is the strongest observed fit for “most liked”; curated editorial roads and mathematically curved roads are different evidence categories. Keep these distinctions in the product. Motorcycle Diaries' [terms](https://motorcycle-diaries.com/es/node/40) describe protected content and limited use rights, so do not treat its GPX downloads as an open database.

For each potential supplier, request a sample containing geometry, road identity, rating scale, counts, dates, direction, source IDs and usage terms. Evaluate deduplication, stale records, regional gaps, ability to store/cache data and whether the service can keep operating after a partnership ends. This plan does not contact suppliers.

## Build the catalogue

Start with 50–100 independently verified sections in one pilot region. London outskirts and adjacent counties are operationally practical, but require extending the engine extract. Expand to England, Wales, Scotland and Northern Ireland after validating the pipeline. Do not describe Great Britain-only coverage as UK coverage.

Store the enjoyable stretch of a road, with explicit start/end junctions and full line geometry. A road number, midpoint or entire touring GPX is insufficient: different parts of the same road can vary substantially in quality.

Suggested records:

- `road_sections`: stable Bendbound ID, name/ref, full geometry, length, direction suitability, region, surface/access information, review state and dates.
- `section_network_matches`: ordered OSM ways/partial-way offsets and directed Valhalla edges, matching confidence and engine graph version. IDs can change across imports; rematch on map updates.
- `sources` and `section_evidence`: source URL/ID, permission status, source type, rating/count/date if available, editorial verification and evidence confidence.
- `section_features`: curvature per kilometre, bend-radius distribution, junction burden, urban proportion and surface confidence, with feature algorithm version.
- `section_feedback`: unique rider rating/favourite, date and direction where relevant. Keep private ride traces separate; only explicit shared submissions contribute to the catalogue.

Import GPX only with appropriate reuse permission. Map-match approved geometry, split full rides into coherent stretches, merge duplicates by actual road overlap and preserve distinct directions where necessary. Human-review uncertain matches, restrictions, discontinuities and mismatches around bridges or parallel roads. Valhalla's [map-matching API](https://valhalla.github.io/valhalla/api/map-matching/api-reference/) can return road/edge attributes and OSM way identifiers; confirm the fields available in the deployed 3.9.0 engine before implementing the importer.

Use scheduled regional OSM extracts for geometry and features rather than live Overpass calls during planning. Record the snapshot and checksum. Plan attribution and derived-data handling against [OSM's ODbL terms](https://www.openstreetmap.org/copyright); track independently authored ratings and their provenance separately.

## Popularity and riding quality

Maintain separate popularity, editorial confidence and measured riding-quality scores. Initially label roads “recommended” or “curated”; “most liked” requires actual comparable rider feedback.

Use a Bayesian/shrinkage rating so one five-star review does not outrank hundreds of strong reviews automatically. Record sample size, recency and source reliability. Do not combine raw stars from different providers without calibration, or treat unknown review counts as large samples. Repeated publication of the same list should not create independent votes.

Tune route ranking through rider evaluation. Winding should favour sustained sweeping bends; twisty should favour tighter bend sequences. Surface suitability, town/junction burden and connector distance also matter. Curvature alone must not make unsuitable roads attractive. Score kilometres actually traversed on recommended sections, with a cap on repeated reward and a penalty for excessive connector travel. Missing catalogue evidence should remain neutral rather than exclude ordinary roads.

## Search and database choice

Use PostGIS full-line spatial indexes for radius, map viewport, region polygon and route-corridor searches. Its [ST_DWithin](https://postgis.net/documentation/tips/st-dwithin/) supports indexed distance queries for geometry and geography. Match candidates using their whole road geometry; searching only centroids misses long roads crossing an area.

For “within 30 minutes”, use a broad spatial shortlist followed by Valhalla network travel-time checks. A circle is not a travel-time area, and geometric intersections are not necessarily accessible junctions. Connectivity must come from the routing graph, including legal direction and turns.

| Requirement | Proposed tool | Graph database benefit |
| --- | --- | --- |
| Roads in a radius, viewport, county or route corridor | PostGIS | Limited; these are spatial filtering tasks |
| Ratings, evidence, moderation and provenance | PostgreSQL tables | Relationships can be represented with ordinary joins initially |
| Legal paths, turn restrictions and manoeuvres | Valhalla | Already uses a road graph; a second database does not replace its routing engine |
| Similar-rider recommendations and multi-hop relationships among riders, roads and tours | PostgreSQL first; graph proof of concept if complexity warrants | Potentially useful later |
| Custom road-edge loop/topology research | Engine graph algorithms or a focused graph prototype | Potential value, but importing topology and keeping it synchronised is substantial work |

Neo4j has [point indexes](https://neo4j.com/docs/cypher-manual/current/indexes/search-performance-indexes/create-indexes/) for radius and bounding-box searches. Those built-in indexes operate on points; full-line/polygon queries require additional modelling or spatial tooling. My recommendation is PostGIS for area search and no graph database in the first release. Revisit a graph store only with concrete relationship queries that benchmark materially better than SQL, including operational cost and synchronisation overhead.

## Integrate with Bendbound routing

Proposed server pipeline: start/distance/direction → spatially shortlist suitable sections → check network reachability → generate candidates through selected sections → Valhalla routes and manoeuvres → existing hard validation → rank valid candidates → final route plus road-quality explanation → optional POI highlights.

Implement this in `routing/service/planner.mjs` with a catalogue module. Extend candidate generation to aim through entry, internal and exit points of a section, then verify that the returned route actually traverses the intended section in the intended order. Endpoints alone do not guarantee this. Keep generation bounded; evaluate a small pool of valid candidates instead of returning the first one, within the existing request/search budget.

Preserve distance, closure, motorway, snapping and shared-access checks as hard acceptance rules. Fame or popularity cannot override them. A failure to include a recommended road should produce another valid candidate or a normal valid loop with a clear quality explanation. A sparse catalogue must not prevent rides.

Return matched section IDs, included recommended kilometres, quality/confidence, catalogue version and score explanations as compatible additional response fields. Introduce a server feature flag and retain current candidate generation for rollback. Keep the public-provider behaviour explicit; prioritise the self-hosted path.

## Delivery sequence and gates

1. **Data feasibility, approximately 3–5 engineering days:** document provider options and permission requirements; inspect representative samples if available; choose the pilot region and define popularity semantics. External licensing discussions have unbounded elapsed time and are not included in this estimate. If access is unavailable, proceed with original submissions/editorial work and curvature discovery.
2. **Catalogue pilot, approximately 1–2 weeks:** build PostGIS schema/importer, collect 50–100 sections, map-match and review them, add spatial queries and provenance. Curation effort depends on available reviewers. Benchmark query latency and catalogue gaps.
3. **Planner experiment, approximately 1–2 weeks:** extend map coverage in a staging environment, add catalogue-guided candidates and post-route scoring, compare against the current planner using identical inputs. Keep expensive imports and processing away from the 2 GiB production host; measure storage/RAM before deciding regional versus national engine hosting.
4. **Rider validation and rollout, approximately 1 week plus ride time:** compare blinded route choices, correct poor matches, tune ranking, deploy behind a flag, then add favourites/ratings and wider regions.

These are preliminary effort estimates, not a committed schedule; the 50–100 section target is a pilot scope proposal, not a claim about an existing dataset.

Release gates: reviewed geometry and provenance for every enabled seed; no hard-policy regressions; recommended-road inclusion verified against the actual route; corridor queries and planning meet measured latency budgets; comparable starts/distances/directions show no material loss in route availability; rider comparison demonstrates an improvement in enjoyment. Test ordinary-road regions, inaccessible famous roads, short rides, parallel roads/bridges, unknown surface, stale mappings and map rebuilds.

First implementation slice: catalogue import plus “recommended roads near this start” in one routable region, then guided loop candidates and ranking. This validates data quality and area search before introducing a new database category or national routing infrastructure.
