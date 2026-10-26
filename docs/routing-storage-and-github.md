# Routing build storage and automatic ratings backup

## Local files needed by the 06:00 job

Keep `routing/.data/uk-20261020/graph/ratings.sqlite` at its original path:
it is the immutable national baseline bound into saved review contexts. Keep
`routing/.data/research/`: ledger, cumulative source/contribution registers,
reviews, publication receipts, recovery references and the three latest published
databases. The research job does not need map extracts, Valhalla tiles or the
intermediate `ratings.work.sqlite`. AWS serves its own deployed graph.

## NAS archive — complete, 25 October 2026

The mounted share is `smb://192.168.1.247/home` at `/Volumes/home`.
Archive target: `/Volumes/home/Bendbound/routing-builds/2026-10-25`.

`python3 routing/catalogue/research/archive_build.py` moves only explicitly listed
build artifacts: old London map/engines and UK map/Valhalla/API build context and
working database, API image and rating-source build exports. It holds the daily-job lock, copies and hashes every file,
then verifies every destination again before removing any local file. All source
checksums are rechecked before removal. A missing NAS mount fails closed.
Interrupted copies can be resumed with the same command. No research identity,
credentials, ledger or baseline is moved. Local/NAS `archive-manifest.json` records
are stored as `research/build-archive.json` and the destination's manifest.

To rebuild locally, copy the relevant paths from the NAS back under `routing/.data`
and compare their SHA256 values with the manifest. Daily work needs no NAS mount.

## GitHub publication

The existing Mac 06:00 job now invokes `sync_github.py` after successful AWS
publication. It uses Git's existing credential helper and pushes only to the
`ratings-data` branch at `toctavian/Bendbound`. No GitHub Actions runner, AWS
credentials on GitHub or extra model call is required. The Mac must still be on
and signed in for the existing morning research job.

The branch contains `ratings.jsonl.gz`, a complete compact per-section rating and
evidence overlay; `latest.json`, which binds its checksum to the exact deployed
database and graph; and an attribution/format README. Geometry, map extracts,
raw agent logs, rider data, secrets and the full SQLite database are excluded.
Use this overlay only with its matching graph version; it is not a route engine.

A separate ignored checkout under `research/github-checkout` prevents staging
developer changes. Pushes never force-overwrite remote commits. Retries are
idempotent; failed GitHub publication leaves successful AWS deployment intact
and records `github-sync-error.json`. Success is verified against the remote
branch head and recorded in `github-sync.json`.

Retry GitHub alone without rerunning research, review or AWS deployment:

```sh
python3 routing/catalogue/research/sync_github.py
```

25 October: first real push verified at commit
`a4a48f565e1b2aebc0d9c9b26b227375e6ee70d5`, 141,445 sections, approximately
2.1 MB compressed. Published database SHA256:
`8fde15bde74bca958015469ffc5ebb98228d39242b5bbb28c365a0dd02735fa1`.
GitHub CLI login was unnecessary: the existing Git credential helper could push.

Final archive result: **10,798,488,339 bytes across 1,408 files** copied,
SHA256-verified and removed locally. NAS and local manifests agree. The original
national baseline SHA256 remains
`05478fee42d89429a2e12ad804c04828dbe73043a72d9ae4ebe38ad25ae7895f`;
ledger quick_check returned ok. Post-move scheduler dry-run finds the same local
baseline and AWS publication configuration. Approximately3.5GiB of baseline and
research state remain, plus small deployment/verification reports. Mac data-volume
free space increased from16GiB to26GiB. Four GitHub sync tests and five existing
runner tests passed; Expo lint/typecheck passed. No new research/model/AWS run
was triggered by this storage change.
