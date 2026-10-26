# Daily routing evidence review

This is the independent review policy for the requested daily motorcycle-route research. It describes acceptance criteria; it does not claim that a scheduler, ingestion job, review or deployment has run.

## Standing automation rules — approved22October2026

Octavian chose one independent review per morning, automatic publication of its
supported observations, and automatic evidence-backed corrections to older credits.
The code-readable policy is `research/single_review_rules.json`.

- A source attribution problem, wrong road stretch, uncertain ownership or inaccessible
  article affects only that observation: quarantine unresolved claims, reject known
  bad mappings, and give neither points. Keep their original evidence and reasons.
- Publish the supported subset after that one review; no researcher restart or second
  AI review is needed to remove disputed items. Review every original observation.
- Apply supported historical corrections automatically, including reducing/removing
  unsupported credits. Quarantine disputed corrections. Keep all original events and
  append exact signed compensating deltas.
- Whole-dataset failures still stop publication: hash/input mismatch, graph drift,
  accounting errors, incomplete cumulative review, invalid artifacts or failed routes.
- Fewer than20articles/observations never blocks supported updates. If nothing is
  supported and no correction is supported, report no change; never invent points.
- Formula and weights remain unchanged. Native road eligibility, access, geometry,
  graph IDs, route limits, publisher/syndication caps and rollback checks remain.
- Preserve `proposal.json` and the independent `review.json` exactly. The deterministic
  selector writes an application proposal and policy authorization, linking hashes
  to both originals. These derived files are not another AI review or an alteration
  of the reviewer's original verdict. Publisher recomputes the selection before use.

The new review contract has explicit integrity results and per-item dispositions,
instead of using a source dispute to veto a whole batch. Legacy held reviews require
an explicit, hash-bound, run-specific policy adoption record; they are never silently
relabelled as approved.

## Existing baseline

The checked-in `routing/catalogue/evidence.json` records three source entries, with `checkedAt: 2026-10-07`. Treat these as declared existing citations, not proof of historical crawl dates or individual rating changes. The original importer links a recommendation by exact road reference and complete section containment in its geographic scope. The UK geometry-only additions have no recommendation count and must retain that distinction.

The current importer computes `F(n) = 1 + 4n/(n+2)` and, when a section receives evidence, `R(q,n) = 0.7q + 0.3F(n)`. Without evidence, `R(q,0) = q`. Consequently, the first endorsement can **reduce** a good geometric score: `q=5, n=1` produces `R=4.2`, a delta of `-0.8`. Daily research must expose this behavior rather than label every mention as positive points. The implementation currently deduplicates `source_id`; it does not independently establish publisher or syndication identity.

## Two distinct jobs

1. Research at 06:00 Europe/London seeks up to 20 genuinely new eligible articles. A retry or repeat run on the same local date must not double-count evidence. Log shortfalls honestly; never pad the target with weak or duplicate pages. The timezone must follow daylight saving.
2. After research finishes, a separate reviewer evaluates the complete cumulative ledger, including earlier mornings. It receives source facts, scope decisions and score changes rather than trusting the research agent's conclusions. An empty or partially failed research run still gets a review record.

Only record identifiable motorcycle-road recommendations from accessible publisher, magazine or blog pages. A generic destination, venue, route directory or road name mentioned incidentally is insufficient. Preserve URL, title, publisher, retrieval time, relevant original factual road identification and content hash; do not copy reviews, photographs or GPX tracks. Respect access restrictions and site policies; a blocked page is a skipped candidate. The source index should distinguish candidate, fetched, rejected, duplicate, accepted, reviewed and applied states.

## Independence and road scope

- Count at most one active endorsement per independent editorial family and physical road section. Multiple articles by the same publisher may describe additional sections, but overlapping sections receive no extra count. Record publisher aliases and common editorial ownership where verified.
- A syndicated article, canonical URL variant, tracking-parameter variant, cached copy, translation or minor rewrite belongs to its original evidence family. Similarity is a review signal, not proof of independent authorship. Uncertain independence stays pending and contributes zero.
- Record exact road references plus named endpoints or a bounded route corridor from the page. Resolve ambiguity before assigning points. A road reference alone cannot justify rating the whole UK road; broad regional boxes remain provisional when the article identifies a narrower segment.
- Scope must map to the pinned graph's eligible native road geometry. Preserve graph checksum, stable source section ID, OSM way IDs and native physical-edge membership. Map-refresh transfers require a new explicit mapping event; do not carry old native IDs into a new graph.
- An article-to-road proposal is not an applied native-section endorsement. Keep proposed road references/corridors separate from `verifiedFullScope` decisions; only a reviewed complete mapping to the target section can affect a served rating. A generated research ledger alone does not update the graph overlay.
- Split evidence scope at real native edges where possible. If a native edge straddles an unverified boundary, leave it uncredited or map a defensible verified range; never widen the claim for convenience. Reject wrong road branches, similarly named roads, off-road/private roads and disconnected sections.
- Recommendations change desirability only. They cannot override motor-access rules, paved-road eligibility, turn restrictions, route-distance limits, road-reuse rules or native graph verification.

## Source maps and GPX — approved 22 October 2026

Check every article for a publisher-provided route map, embedded map link or GPX.
Use accessible maps and tracks to resolve exact roads before leaving a source
unmapped. Read GPX as coordinate data in memory and inspect maps visually; retain
factual road matches and provenance, rather than copying or redistributing full
tracks or map images. Respect access restrictions and treat downloads as untrusted.

Record the source article, map/GPX URL, actual retrieval time, format, hash or
revision limitations and matching method in the proposal's existing notes and
retrievalMethod fields. Each road reason must explain the route leg and complete
native-section match. The independent reviewer checks this evidence and records
its rationale in the existing decision reason. No schema or scoring change is needed.

A bounding rectangle only filters candidates. Check the full road geometry,
endpoints, turns, branches and carriageways against the source route. Sparse
waypoints, gaps, straight-line links and schematic maps do not prove all intervening
roads. Do not guess missing legs by routing between points. Conflicting text,
map or GPX evidence remains an item-level hold. A track establishes location;
it does not prove independent endorsement or justify extra weight.

Previously parsed unresolved sources can receive explicit map/GPX follow-up.
They do not count towards the 20 new pages and cannot earn duplicate credits.
Supported remapping or removal uses the existing reviewed, append-only correction
process. This rule does not claim that older pages have already been revisited.

## Append-only road-level accounting

Maintain immutable raw evidence and decision records. Every applied change records:

| Field | Required meaning |
| --- | --- |
| `eventId`, `runId`, `occurredAt`, `localDate` | Unique, retry-safe identity and real UTC timestamp; local date in Europe/London |
| `sourceId`, `canonicalUrl`, `contentHash` | Exact source revision supporting the change |
| `editorialFamilyId`, `evidenceFamilyId` | Publisher independence and syndication grouping, with rationale |
| `sectionId`, `sourceSectionId`, `graphVersion`, `physicalIds` | Affected verified geometry, not just a road label |
| `action`, `reason`, `supersedesEventId` | Acceptance, rejection, revocation, remapping or reweighting with explicit reason |
| `policyVersion`, `quality`, `countBefore`, `countAfter` | Inputs needed to reproduce the computation |
| `ratingBefore`, `ratingAfter`, `delta` | Actual marginal change; signed `delta = ratingAfter - ratingBefore` |
| `reviewId`, `reviewer`, `status`, `artifactVersion` | Independent review and whether the result is merely proposed, approved or actually served |

Do not store only totals. For each road section, baseline plus all applied deltas must reproduce the served rating. Use full precision internally and round only display values. Each source-to-section application has a unique idempotency key including evidence revision, graph version and policy version. A repeated mention within an existing family has delta zero, with a duplicate decision retained.

Snapshot existing scores and citations as an explicitly labelled imported baseline. Do not invent per-source historical deltas for the existing catalogue. When a formula changes, preserve all earlier events and append compensating/reweight events with old and new policy versions. Never edit an old morning's contribution to hide a correction. A withdrawn source requires reassessment of the remaining independent families, not simply deletion of its original delta: the formula is nonlinear.

If the implementation supports review weights in `[0,1]`, record the individual weight and rationale, deduplicate editorial families before forming the effective count, and compute signed deltas under the declared existing formula. Weight zero means no effective endorsement. A fractional weight is a confidence decision, not an extra source or rider vote. Preserve prior weights through append-only reweight events. Retaining the existing formula is an explicit compatibility choice; its possible negative first delta must remain visible until a separate policy migration is approved.

## Weight review and proposed correction

The reviewer must first recompute every cumulative section from accepted independent evidence. Raw citation count, social mentions, articles fetched per day and website traffic are not rider votes. Flag concentrated publishers, repeated routes, widening scopes, negative first-endorsement deltas, unexplained jumps and region-specific changes in the distribution.

A proposed monotonic alternative is `R(q,n) = q + (5-q) * w * n/(n+k)`, with `R(q,0)=q`, initial candidate `w=0.3`, `k=2`, and `q` constrained to `[0,5]`. It retains geometry, caps evidence influence at 30% of the remaining headroom and has diminishing returns. This is a candidate calibration, not a claim that it is deployed or empirically proven. Under it the nth independent family's marginal uplift is `(5-q)*w*k/((n+k)*(n-1+k))`. Changing weights is a versioned, independently reviewed batch decision; do not automatically retune from the same 20 daily articles or silently mix formulas.

Each review reports accepted, rejected, duplicate and pending sources; affected road sections and exact signed deltas; cumulative anomalies; previous versus proposed distributions; and a decision to approve unchanged, hold, or propose a versioned correction. Compare a fixed route benchmark before and after a proposed correction, including good uncited roads, cited straight roads, repeatedly cited roads and regions with sparse coverage. Failure to fetch or resolve an individual source quarantines that item; supported items can publish. Whole-dataset integrity failures leave the deployed ratings unchanged.

## Required checks before applying a batch

- **Idempotence:** replaying an identical run, article or redirect changes no score. Two overlapping articles from one publisher count once per section; two verified independent editorial families count twice. Syndicated copies count once.
- **Spatial correctness:** one narrow recommendation affects only its verified native geometry. Test a distant section of the same numbered road, a parallel carriageway/branch, a boundary-crossing edge and a graph-version mismatch.
- **Accounting:** replay the baseline and ledger to reproduce every affected rating. Deltas telescope correctly across several mornings, revocation and a policy migration; corrupted or missing events fail closed. Attribute source deltas in a deterministic order, since nonlinear marginal contributions depend on ordering.
- **Math:** test `n=0,1,2` and a large count, finite range `[0,5]`, monotonicity for any proposed additive policy, diminishing returns and the existing `q=5,n=1` negative-delta regression. Zero-quality or forbidden roads never become eligible from citations.
- **Independence:** the reviewer verifies all source-to-road scope assignments and cumulative changes; disputed, unverified or structurally invalid entries contribute zero. A failed reviewer cannot publish the researcher's provisional batch.
- **Release:** versioned metadata and ratings target exactly the same graph checksum. Validate the artifact and representative routes, retain a rollback artifact, and record actual activation separately from local generation. No heavy graph rebuild runs on the small AWS server.

If the cumulative evidence exceeds a single review's context, perform a complete deterministic ledger reconciliation and partition the substantive review into auditable road/source batches. Retain a review coverage manifest; do not claim that all prior points were reviewed when only a sample was inspected.
