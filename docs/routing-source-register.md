# Routing source register

Register prepared: **2026-10-20**. This records source evidence already present in the repository, not a new crawl or proof of current page availability.

The existing evidence file is [routing/catalogue/evidence.json](../routing/catalogue/evidence.json), with a shared **checkedAt date of 2026-10-07**. It records three pages and 18 source–road-reference associations across 15 distinct road references. There are no individual fetch timestamps, response hashes or archived extraction records for these historical entries. “Imported evidence” below means recorded and consumed by the importer; it does not claim a reproducible full-page parse.

## Existing imported evidence

| Source ID / publisher | Page | Recorded road references | Status / scope |
| --- | --- | --- | --- |
| `devitt-south-east` / Devitt | [South East biking routes](https://www.devittinsurance.com/guides/best-biking-routes/south-east/) | A272, A275, A29, A25, A248, A286, B1012, B1010, B1021, B1018, B1026, A414 | Imported evidence, checked 2026-10-07. Each reference has its own bounding rectangle in `evidence.json`; South East England only. |
| `js-south-east` / J&S Accessories | [Motorbike routes in South East England](https://jsaccessories.co.uk/blog/advice/motorbike-routes-in-south-east-england) | A272 | Imported evidence, checked 2026-10-07. Scope rectangle: west −1.35°, south 50.85°, east 0.30°, north 51.10°. |
| `wbab-south-east` / WeBuyAnyBike247 | [Top 5 motorcycle rides in the South East of England](https://webuyanybike247.com/blog/top-5-best-motorcycle-rides-in-the-south-east-of-england) | A272, A24, A25, A32, B2026 | Imported evidence, checked 2026-10-07. Each reference has its own bounding rectangle in `evidence.json`; South East England only. |

## How those entries currently affect roads

- The PostGIS importer matches the road reference exactly and requires the **entire section geometry** to be covered by its source rectangle (`ST_CoveredBy`). A road number alone is insufficient; these sources do not endorse every section of that numbered road nationwide.
- The existing manifest contains one page per publisher. The importer counts distinct **source IDs**, so future ingestion must enforce publisher-level deduplication explicitly before introducing multiple pages from one publisher. Reprinting the same recommendation is not independent corroboration.
- With `n` matching sources, the current frequency component is `1 + 4n/(n+2)`. With evidence, the section rating is `0.7 × geometry quality + 0.3 × frequency component`, bounded to 0–5. Without evidence, it remains the geometry score. These are guide mentions, not rider votes or measured satisfaction.
- A new mention is not a fixed number of points: its marginal effect depends on the previous source count and, for the first mention, the geometry quality. A low frequency component can also lower a high geometry score. An audit must record the actual before/after values and signed delta rather than assume every mention increases the score.
- `routing/catalogue/uk/rating-sources.py` preserves existing London source sections and gives newly generated UK sections `recommendationCount: 0` and `sources: []`. UK coverage expansion alone adds no website recommendations.
- Existing records retain source IDs/URLs and component scores. They do **not** contain a historical per-road, per-ingestion signed contribution ledger. Do not invent past individual deltas; any reconstructed baseline must be labelled as reconstructed.

## New discovery and parsing statuses

No additional URLs are asserted as successfully parsed by this register. Daily ingestion records must distinguish:

| Status | Meaning |
| --- | --- |
| Discovered | URL found; page content and route claims not yet verified. No rating effect. |
| Blocked / unavailable | Access refused, robots restrictions, paywall, timeout or another retrieval failure. Record the reason; no rating effect and no bypass. |
| Parsed, awaiting review | Accessible content yielded specific route evidence; extraction is stored with provenance but not approved. No published rating effect. |
| Approved / applied | Evidence passed route mapping, duplicate and weighting checks; individual road changes and publication version are recorded. |
| Rejected / duplicate | Ambiguous location, insufficient route specificity, syndicated material or repeated publisher endorsement. Record the reason; no new points. |

Discovery is not parsing; parsing is not publication. A daily target of 20 new pages must report shortfalls honestly rather than count inaccessible pages, duplicates or fabricated route evidence.

Store factual route references, geographical scope, concise original observations, timestamps and retrieval/extraction hashes where available. Do not copy articles, photographs, third-party star ratings or GPX tracks into the source register. Retain the existing map-data attribution and do not describe this small historical source set as nationwide editorial coverage.

## Daily additions

The [daily workflow](routing-daily-research.md) maintains the cumulative machine-readable
registry at `routing/.data/research/sources.jsonl`, and individual signed per-road
changes at `routing/.data/research/contributions.jsonl`. These files are generated
when the first reviewed batch has a valid national baseline; their absence today
does not imply the three historical manifest pages have been freshly parsed.
