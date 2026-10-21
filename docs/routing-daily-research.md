# Daily motorcycle-route evidence

## Current state

Installed and verified macOS LaunchAgent **com.bendbound.route-research** for
**06:00 Europe/London daily**. The Mac timezone was verified as Europe/London;
calendar scheduling follows its daylight-saving changes. This runs locally via
the signed-in Codex CLI, using the existing configured model/effort (currently
GPT-6.1 Sol / medium). No API-key billing integration or hourly credit polling.
The former generic group-work autopilot is not installed or changed by this work.

**Baseline ready (21October):** the national ratings database is now built and
fully verified at `routing/.data/uk-20261020/graph/ratings.sqlite` (141,445sections,
~753MB). The21October06:00 attempt was blocked before it existed and remains
recorded as such; it has not been rerun. Future scheduled runs can use the database
without Docker. Reviewed updates are local artifacts; publication to AWS remains
pending UK release integration. See [current UK handoff](uk-routing-expansion.md).

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
   prior ledger, then writes a new ratings SQLite artifact. A rejected review or
   changed input retains current ratings. Publisher and syndication families count
   at most once per road section; retries add nothing twice. Complete section
   containment in the source-supported scope is mandatory. Native edge IDs,
   geometry, access, graph version and geometric quality remain unchanged.

Both CLI sessions run with read-only agent sandboxing. Only the deterministic
ledger driver writes ratings after review; neither agent can deploy or edit code.
Per-agent timeout is90minutes; a file lock prevents overlapping scheduled jobs.
Saved proposals/reviews are reused after interruptions, including a crash after
ledger commit. Same-day completed batches make no further model calls.

## Where to see the sources and individual points

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
- `routing/.data/research/latest-reviewed.json`: checksum and path of latest
  approved local artifact, explicitly marked deployment pending.

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
Production research, national-baseline integration and unattended06:00 execution
remain to be observed; synthetic fixture results are not claims of new road data.

Final checks:13 Python research/runner tests passed; routing catalogue78passed
with1existing skip; project lint/typecheck passed. LaunchAgent calendar descriptor
verified Hour6/Minute0, RunAtLoadfalse; no recurring agent run was triggered during
installation. An authenticated one-call worker output-format smoke test passed.
