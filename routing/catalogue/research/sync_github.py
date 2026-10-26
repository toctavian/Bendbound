#!/usr/bin/env python3
"""Publish compact, deployed ratings to a dedicated Git branch without touching app work."""
import argparse
import fcntl
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parents[3]
REMOTE = 'https://github.com/toctavian/Bendbound.git'
BRANCH = 'ratings-data'
FIELDS = ('rating', 'recommendationCount', 'weightedEvidenceCount', 'frequencyRating', 'ratingBasis', 'sources')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def git(directory, *args, check=True):
    return subprocess.run(['git', '-C', str(directory), *args], check=check,
                          capture_output=True, text=True, timeout=180)


def export(state, destination):
    latest = json.loads((state / 'latest-reviewed.json').read_text())
    published = json.loads((state / 'remote-published.json').read_text())
    day = latest['runId']
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
        raise ValueError('Invalid run ID')
    run = state / 'runs' / day
    status = json.loads((run / 'status.json').read_text())
    receipt = json.loads((run / 'publication.json').read_text())
    artifact = (run / 'ratings.sqlite').resolve()
    if (status.get('status') != 'complete' or latest.get('deployment') != 'published'
            or published.get('status') not in {'published', 'already-published'}
            or receipt.get('sha256') != latest['sha256']
            or published.get('runId') != day or published.get('sha256') != latest['sha256']
            or Path(latest['artifact']).resolve() != artifact or digest(artifact) != latest['sha256']):
        raise ValueError('Only the latest successfully deployed, checksum-matched ratings may sync')
    destination.mkdir(parents=True, exist_ok=True)
    snapshot = destination / 'ratings.jsonl.gz'
    with sqlite3.connect(artifact.as_uri() + '?mode=ro', uri=True) as db:
        summary = json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0])
        if summary['graphVersion'] != published['graphVersion']:
            raise ValueError('Graph identity differs from deployment receipt')
        count = 0
        # mtime=0 and filename='' make retries byte-identical.
        with snapshot.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as stream:
            for section_id, value in db.execute('SELECT id,value FROM sections ORDER BY id'):
                section = json.loads(value)
                row = {'id': section_id, **{key: section[key] for key in FIELDS if key in section}}
                stream.write((json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n').encode())
                count += 1
    if count != summary['sections']:
        raise ValueError('Incomplete rating snapshot')
    manifest = {'schemaVersion': 1, 'runId': day, 'publishedAt': published['publishedAt'],
                'graphVersion': summary['graphVersion'], 'databaseSha256': latest['sha256'],
                'snapshotSha256': digest(snapshot), 'sections': count,
                'recommendedSections': summary['recommendedSections'],
                'format': 'gzip JSONL, one section per line; rating/evidence only; no geometry'}
    (destination / 'latest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (destination / 'README.md').write_text('''# Bendbound daily ratings

Automatically updated after the independent review and successful AWS publication.
`latest.json` identifies the deployed graph/database and checksums `ratings.jsonl.gz`.
The snapshot contains every section's rating and evidence fields, ordered by ID.
It is a compact overlay, not a standalone routing database. Apply only to the exact
graph version in the manifest. The full baseline and build are archived separately.

Unchanged publications do not create commits. The job uses a separate checkout and
never stages app source, credentials, rider data, raw agent logs or map extracts.
Road identities derive from OpenStreetMap (https://www.openstreetmap.org/copyright).
Publisher citations appear in the sources fields; no articles or tracks are copied.
''')
    return manifest


def sync(state, remote=REMOTE):
    work = state / 'github-checkout'
    work.mkdir(parents=True, exist_ok=True)
    git(work, 'init', '-q')
    git(work, 'config', 'user.name', 'Bendbound ratings bot')
    git(work, 'config', 'user.email', 'ratings-bot@users.noreply.github.com')
    if git(work, 'remote', 'get-url', 'origin', check=False).returncode:
        git(work, 'remote', 'add', 'origin', remote)
    elif git(work, 'remote', 'get-url', 'origin').stdout.strip() != remote:
        raise ValueError('Unexpected sync checkout origin')
    refs = git(work, 'ls-remote', '--heads', 'origin', 'refs/heads/' + BRANCH).stdout.strip()
    if refs:
        git(work, 'fetch', '--depth=1', 'origin', BRANCH)
        git(work, 'checkout', '-B', BRANCH, 'FETCH_HEAD')
        git(work, 'reset', '--hard', 'FETCH_HEAD')
    elif git(work, 'rev-parse', '--verify', 'HEAD', check=False).returncode:
        git(work, 'checkout', '--orphan', BRANCH)
    manifest = export(state, work)
    git(work, 'add', '--', 'README.md', 'latest.json', 'ratings.jsonl.gz')
    if git(work, 'diff', '--cached', '--quiet', check=False).returncode:
        git(work, 'commit', '-m', 'ratings: deployed ' + manifest['runId'])
    # Push even without a new diff: recovers a previous commit whose push failed.
    # No force: a concurrent publisher causes a safe failure and retry from remote.
    git(work, 'push', 'origin', 'HEAD:refs/heads/' + BRANCH)
    result = {'status': 'synced', 'runId': manifest['runId'], 'branch': BRANCH,
              'databaseSha256': manifest['databaseSha256'], 'commit': git(work, 'rev-parse', 'HEAD').stdout.strip()}
    remote_commit = git(work, 'ls-remote', '--heads', 'origin', 'refs/heads/' + BRANCH).stdout.split()[0]
    if remote_commit != result['commit']:
        raise RuntimeError('GitHub branch verification failed')
    (state / 'github-sync.json').write_text(json.dumps(result, indent=2) + '\n')
    (state / 'github-sync-error.json').unlink(missing_ok=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, default=ROOT / 'routing/.data/research')
    args = parser.parse_args()
    with (args.state / 'github.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            print(json.dumps(sync(args.state)))
        except (OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError) as error:
            # Never include credential-helper output in durable logs.
            result = {'status': 'failed', 'errorType': type(error).__name__,
                      'message': 'GitHub sync failed; retry sync_github.py. AWS publication is unchanged.'}
            (args.state / 'github-sync-error.json').write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result))
            raise SystemExit(1)
