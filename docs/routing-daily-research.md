# Daily motorcycle-route evidence

## Current state

25 October storage/GitHub update: the daily publisher now automatically pushes a
compact deployed ratings snapshot to the separate `ratings-data` GitHub branch
after successful AWS publication. Full build scratch was checksum-verified and moved to the NAS (10.8GB freed);
the baseline, research ledger and recent published databases remain local. See
[storage and automatic GitHub publication](routing-storage-and-github.md) for
archive verification state, retained paths, retry commands and evidence.

Installed and verified macOS LaunchAgent **com.bendbound.route-research** for
**06:00 Europe/London daily**. The Mac timezone was verified as Europe/London;
calendar scheduling follows its daylight-saving changes. This runs locally via
the signed-in Codex CLI, using the existing configured model/effort (currently
GPT-6.1 Sol / medium). No API-key billing integration or hourly credit polling.
The former generic group-work autopilot is not installed or changed by this work.

**Baseline ready (21October):** the national ratings database is now built and
fully verified at `routing/.data/uk-20261020/graph/ratings.sqlite` (141,445sections,
~753MB). The21October06:00 attempt was blocked before it existed and remains
recorded as such. A manual catch-up completed and published at16:11BST after
independent approval; see the completed-run evidence below. Scheduled runs use the database
without Docker. The national baseline is deployed. Reviewed updates can now publish from this Mac
through AWS MCP; the06:00 schedule includes `--publish`. See [current UK handoff](uk-routing-expansion.md).

## Maps and GPX for road identification

The researcher and independent reviewer must check publisher-provided maps/GPX
when available to resolve exact route legs and complete native road sections.
Record source links and matching evidence in existing notes/reasons; do not store
or redistribute full tracks. A rectangle or sparse waypoints alone cannot prove
coverage. Previously unmapped pages can receive explicit follow-up without being
counted as new pages or duplicate endorsements. See the [mapping rules](routing-rating-review-policy.md#source-maps-and-gpx--approved-22-october-2026).
This is enabled for subsequent research; no historical remapping is claimed here.

## Standing rules approved22October

One independent review runs each morning. Its supported observations publish
without another review; disputed sources/mappings go to a non-scoring queue.
Supported corrections to older citation credits apply automatically with exact
append-only deltas. The formula is unchanged. See the [standing policy](routing-rating-review-policy.md)
and `research/single_review_rules.json` for the approved choices.

Only typed dataset-integrity failures stop the whole batch: accounting mismatch,
graph drift, incomplete historical audit or input-binding mismatch. Native artifact
and public routing checks remain mandatory. Source uncertainty cannot veto unrelated
supported observations. Fewer than20pages is not a blocker; no supported changes
means a no-change result, without invented points or an unnecessary server restart.

Original `proposal.json`/`review.json` stay intact. `application-proposal.json` and
`application-authorization.json` are deterministic policy-derived views, not another
AI verdict. `selection.json` records each quarantined/rejected item and source-review
hash. The publisher recomputes the authorized selection before deploying it.

## What happens each morning

1. One research agent searches and reads up to20 previously unprocessed motorcycle
   route pages, checking up to60 candidates. Blogs, magazines and route publishers
   qualify when they recommend identifiable UK road stretches. Blocked/duplicate
   pages and vague destination lists do not fill the quota. Shortfalls are recorded.
2. After parsing finishes, a fresh independent reviewer checks today's observations
   and the **entire cumulative ledger** with code, plus source relevance and full
   native section scope. It approves/rejects each proposed observation, can reduce
   or increase earlier evidence weights with an explicit correction, and explains
   whether the weighting policy needs a versioned change. A failed/empty parse
   still gets a cumulative review when a valid baseline is available.
3. Deterministic code validates approval and hashes of the baseline, proposal and
   prior ledger, then writes a new ratings SQLite artifact. An integrity failure or
   changed input retains current ratings; item-level disputes are quarantined. Publisher and syndication families count
   at most once per road section; retries add nothing twice. Complete section
   containment in the source-supported scope is mandatory. Native edge IDs,
   geometry, access, graph version and geometric quality remain unchanged.

4. After selecting supported items, a deterministic publisher validates every section and every
   immutable native/RTree/membership table against the original national baseline.
   Only rating/evidence fields may differ. It streams the checksum-addressed artifact
   through S3 to the existing EC2 instance using the configured AWS MCP connection.
   Remote compare-and-swap prevents overwriting an unexpected rating version.
   The actual native consumer is checked before activation; only the API restarts.
   Public five-region routes and a strict-cone round trip must pass, or the old
   overlay is restored and the API restarted. No graph rebuild or EC2 upgrade.

Both CLI sessions run with read-only agent sandboxing. Only the deterministic
ledger driver writes ratings after review; neither agent can deploy or edit code. Publication belongs only to the deterministic driver.
Per-agent timeout is90minutes; a file lock prevents overlapping scheduled jobs.
Saved proposals/reviews are reused after interruptions, including a crash after
ledger commit. Same-day completed batches make no further model calls.

## Where to see the sources and individual points

`processed-pages.jsonl` retains every parsed URL, including held/unmapped candidates,
so later runs do not count them as new. Unmapped pages are retained in each run
outside its scoring proposal; they receive no invented observations or points.

- [Existing source register](routing-source-register.md): all three historical
  pages currently recorded in `evidence.json`, with honest provenance limits.
- [Review and weighting policy](routing-rating-review-policy.md).
- `routing/.data/research/sources.jsonl`: cumulative parsed-page registry, URL,
  publisher, retrieval time/method, optional actual retrieved-text hash, notes.
- `routing/.data/research/contributions.jsonl`: **each signed per-road change**,
  source URL, native section ID, publisher, prior/new evidence weights, exact
  rating delta, rationale, run and policy version. Before/after are retained for
  auditing; the delta is the individual change, not the accumulated total.
- `routing/.data/research/ledger.sqlite`: immutable observations and append-only
  contribution/correction events. Historical source deltas are explicitly unknown
  (`null`); they are never invented from current totals.
- `routing/.data/research/runs/YYYY-MM-DD/`: proposal, full-history export/audit,
  independent review, agent logs, status and approved output `ratings.sqlite`.
- `routing/.data/research/latest-reviewed.json`: checksum and path of the latest
  approved artifact, with separate actual publication status.

- `remote-published.json`: last confirmed remote artifact checksum and SSM command.
- Each run's `publication-validation.json`, `publication.json`: full-graph comparison
  summary and actual cloud activation receipt. `publication-error.json` reports a
  failed/blocked publish separately from a completed research/review run.
- `publication-attempt.json`: durable SSM command reference for recovery if the Mac
  disconnects while publication runs. Subsequent publication resumes it first.

Runtime data is git-ignored with the rest of `.data`. Preserve/back up this ledger
when publishing; it is the durable record, not disposable map-build scratch.
Existing signed deltas are never rewritten: reweighting appends compensating
changes with a reason. Raw independent recommendation counts are separate from
fractional `weightedEvidenceCount` used in the frequency formula.

The existing formula is retained for compatibility: `F(n)=1+4n/(n+2)` and
`R=0.7*quality+0.3*F(n)` for positive weighted evidence; otherwise `R=quality`.
A first citation can lower a good geometry rating. These negative deltas are
visible and reviewable. A reviewer may propose a monotonic alternative, but must
not silently switch formulas each morning.

## Operation

Keep the Mac powered on, logged in, online and awake for an on-time06:00 run.
Calendar jobs missed during sleep can run on wake; this is not an always-on cloud
job. Codex CLI ChatGPT sign-in and account allowance must remain available.
If sign-in expires or allowance is exhausted, status/logs record failure and
current ratings remain intact. Agent sessions consume the account allowance.
Scheduled publication now uses the verified `bendbound-research` certificate
identity, obtaining fresh temporary credentials through AWS MCP without daily
browser sign-in. Machine credential failures retry that identity and stop safely;
they never fall back to admin access. Manual prompts retain `bendbound` and the
normal London `aws login` browser flow. See [identity operations](routing-research-machine-identity.md)
for permissions, live evidence and annual certificate renewal. Sign-in
links/codes/credentials are never recorded. MCP configuration parsing uses
Homebrew Python3.11+; the scheduler itself can continue on system Python3.9.
`caffeinate -i` prevents idle sleep during the job; the Mac must still be awake at06:00.

Only the newest three published DB artifacts are kept locally and remotely; all
proposals, source URLs, reviews, individual deltas and receipts remain. EC2 also
retains a hard link to the original national baseline for rollback. Temporary S3
transfer objects are removed after successful publication.

```sh
# Show setup and available baseline without calling a model
python3 routing/catalogue/research/run_daily.py --dry-run

# Run once manually after the national baseline is ready
python3 routing/catalogue/research/run_daily.py

# Check registration (does not start agents)
launchctl print gui/$(id -u)/com.bendbound.route-research

# Stop this schedule
launchctl bootout gui/$(id -u)/com.bendbound.route-research

# Reinstall/re-enable this specific schedule
python3 routing/catalogue/research/install_schedule.py
```

Do not publish artifacts until the driver exits successfully and all native route
benchmarks pass. The graph and ratings must share a version; rebasing the ledger
onto a different baseline needs explicit migration rather than dropping history.

## Validation

Real authenticated Codex worker smoke test passed. Deterministic fixture tests
exercise the two-agent sequence, failure review, exact signed changes, independent
publisher/syndication caps, scope rejection, historical provenance, compact native
geometry, hash drift rejection, empty/corrections-only batches and crash recovery.
Production research, national-baseline integration and the 22 October scheduled
06:00 research/review are now observed. Publication completed after AWS browser
renewal; this does not establish indefinitely unattended authentication.

Final checks:13 Python research/runner tests passed; routing catalogue78passed
with1existing skip; project lint/typecheck passed. LaunchAgent calendar descriptor
verified Hour6/Minute0, RunAtLoadfalse; no recurring agent run was triggered during
installation. An authenticated one-call worker output-format smoke test passed.

## Retry a completed review's publication without rerunning agents

```sh
/opt/homebrew/bin/python3 routing/catalogue/research/publish_reviewed.py
# Or run today's full workflow idempotently, including publication:
/usr/bin/python3 routing/catalogue/research/run_daily.py --publish
```

Dataset-integrity holds never publish. Item-level holds are quarantined while the supported subset proceeds under the standing rules. A failed publication retains the approved local
artifact. Do not delete a pending publication-attempt reference or overwrite the
remote checksum to bypass a conflict; inspect its SSM outcome and reconcile it.
21October's original blocked06:00 status is retained as `status.failed-6am.json`.
A manual catch-up was started21October; read the current run's status/receipts for
its actual completion and publication outcome, rather than assuming success.

## 21 October completed catch-up (earlier usage limit resolved)

The interrupted review was resumed after allowance reset. A complete fresh review
approved16source pages/16observations and31historical correction events. Four
unresolved pages remain outside scoring.44sections changed;47individual deltas
are recorded. Publication succeeded at15:11:28UTC via AWS MCP SSM
`0b416b75-43ca-468a-a1ab-b97495aa9909`; independent checksum/public-route verification
`02634ec4-c41d-4655-ac03-7ef5a6952f2d` succeeded. Active SHA256 is
`49274572a8569d184e68c9a53d717706508b55e5cefb39d26e1986395bed40bc`.

No21October work remains pending. Its original06:00 failure, first held review and
usage-limit interruption are retained as historical evidence. The Mac06:00 schedule
continues with review-gated publication. Check remote-published.json and each run's
publication receipt, not old failure logs, for current state.

## 22 October completed under the standing policy

20 new pages parsed; 13 supported observations published to 13 sections at
10:51 BST. Four unmapped pages and three disputed observations remain non-scoring.
No historical corrections were required. The original held review is unchanged;
an explicit hash-bound adoption of today's saved review enabled the supported
subset without another researcher or reviewer call. Future reviews emit typed
per-item decisions directly. Exact original and derived files remain in the run.

Remote active checksum and public route reports independently verified; 128 sections
have guide recommendations. Publication SSM `ea1b05e6-e6a0-4d4e-b816-2d971fb84644`
and verification `9de0fc60-6dd4-46c0-9ea9-0ee5e1ba43b4` succeeded. See the
[UK handoff](uk-routing-expansion.md) for active hash and rollback.
33 research tests passed; lint/typecheck passed. No arithmetic or ledger-chain
mismatches. LaunchAgent remains 06:00 Europe/London with `--publish`. Mac availability,
model allowance and valid AWS authentication remain operational dependencies;
source uncertainty alone no longer blocks unrelated supported recommendations.
