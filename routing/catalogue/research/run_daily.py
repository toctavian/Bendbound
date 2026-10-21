#!/usr/bin/env python3
"""Daily research -> independent cumulative review -> deterministic local rating overlay.
Uses the existing ChatGPT-authenticated Codex CLI, never an API-credit polling loop.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
STATE = ROOT / 'routing/.data/research'
LONDON = ZoneInfo('Europe/London')

def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.replace(path)

def sha(path):
    if not path.exists():
        return 'absent'
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def proposal_sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()

def baseline_path(explicit=None):
    choices = [Path(explicit)] if explicit else [
        ROOT / 'routing/.data/uk-current/graph/ratings.sqlite',
        ROOT / 'routing/.data/uk-20261020/graph/ratings.sqlite',
    ]
    return next((p.resolve() for p in choices if p.is_file()), None)

def history_snapshot(ledger, destination):
    """Visit every historical row; never truncate cumulative review to recent/top N."""
    report = {'ledgerSha256': sha(ledger), 'tables': {}, 'invalidDeltas': [], 'brokenChains': []}
    with destination.open('w') as out:
        if not ledger.exists():
            return report
        db = sqlite3.connect(ledger.as_uri() + '?mode=ro', uri=True)
        db.row_factory = sqlite3.Row
        try:
            for table in ('metadata', 'sections', 'pages', 'observations', 'events', 'runs'):
                count = 0
                query = 'SELECT * FROM ' + table + (' ORDER BY id' if table == 'events' else '')
                last = {}
                for row in db.execute(query):
                    value = dict(row)
                    out.write(json.dumps({'table': table, 'row': value}, separators=(',', ':')) + '\n')
                    count += 1
                    if table == 'events':
                        delta = value.get('delta')
                        before, after = value.get('before_rating'), value.get('after_rating')
                        if delta is not None and abs((after - before) - delta) > 1e-9:
                            report['invalidDeltas'].append(value['id'])
                        section = value.get('section_id')
                        if section in last and abs(last[section] - before) > 1e-9:
                            report['brokenChains'].append(value['id'])
                        last[section] = after
                report['tables'][table] = count
        finally:
            db.close()
    return report

def call_agent(codex, prompt_name, schema_name, context, run_dir, output_name, timeout):
    prompt = (HERE / prompt_name).read_text()
    prompt += '\n\nRun context: ' + str(context) + '\nRun directory: ' + str(run_dir)
    output = run_dir / output_name
    command = [codex, '--no-daemon', '--search', '-a', 'never', 'exec',
               '--sandbox', 'read-only', '--cd', str(ROOT),
               '--output-schema', str(HERE / schema_name),
               '--output-last-message', str(output), '--json', '-']
    # Avoid forwarding application/API secrets from a developer shell to the job.
    env = {k: v for k, v in os.environ.items()
           if k in {'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'CODEX_HOME'}}
    with (run_dir / (output_name + '.agent.jsonl')).open('w') as log:
        subprocess.run(command, input=prompt, text=True, stdout=log, stderr=subprocess.STDOUT,
                       cwd=ROOT, env=env, timeout=timeout, check=True)
    return json.loads(output.read_text())

def run(args):
    state = Path(args.state).resolve()
    state.mkdir(parents=True, exist_ok=True)
    with (state / 'daily.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another daily research job is running; skipped.')
            return 0
        return run_locked(args, state)

def run_locked(args, state):
    day = dt.datetime.now(LONDON).date().isoformat()
    run_dir = state / 'runs' / day
    run_dir.mkdir(parents=True, exist_ok=True)
    status_path = run_dir / 'status.json'
    if status_path.exists() and json.loads(status_path.read_text()).get('status') == 'complete':
        print('Today\'s reviewed batch is already complete; no agent calls.')
        return 0
    baseline = baseline_path(args.baseline)
    codex = args.codex or shutil.which('codex')
    if args.dry_run:
        print(json.dumps({'schedule': '06:00 Europe/London daily', 'baseline': str(baseline),
                          'codex': codex, 'state': str(state),
                          'steps': ['research: up to 20 new pages', 'independent full-history review',
                                    'validated append-only ledger + local ratings overlay'],
                          'deployment': 'pending UK release integration'}, indent=2))
        return 0
    status = {'runId': day, 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat()}
    try:
        if not baseline:
            raise RuntimeError('No completed national ratings.sqlite baseline. Research is blocked until UK ratings export succeeds; no agents or scores were run.')
        if not codex:
            raise RuntimeError('Codex CLI is not installed at the configured path.')
        if shutil.disk_usage(state).free < 4 * 1024**3:
            raise RuntimeError('Less than 4GiB local disk headroom; keep current ratings.')
        ledger = state / 'ledger.sqlite'
        audit = history_snapshot(ledger, run_dir / 'ledger-history.jsonl')
        dump(run_dir / 'history-audit.json', audit)
        if audit['invalidDeltas'] or audit['brokenChains']:
            raise RuntimeError('Cumulative ledger has inconsistent score deltas; hold current ratings.')
        committed = False
        if ledger.exists():
            with sqlite3.connect(ledger.as_uri() + '?mode=ro', uri=True) as db:
                committed = db.execute('SELECT 1 FROM runs WHERE run_id=?', (day,)).fetchone() is not None
        context_path = run_dir / 'context.json'
        if context_path.exists():
            context = json.loads(context_path.read_text())
            if context.get('baselineSha256') != sha(baseline):
                raise RuntimeError('Baseline changed during this daily run; retain artifacts for explicit rebase.')
            if not committed and context.get('ledgerSha256') != audit['ledgerSha256']:
                raise RuntimeError('Ledger changed during this daily run; retain artifacts for a fresh review.')
        else:
            context = {'runId': day, 'timezone': 'Europe/London', 'targetNewPages': 20,
                       'baseline': str(baseline), 'baselineSha256': sha(baseline), 'ledger': str(ledger),
                       'ledgerSha256': audit['ledgerSha256'], 'runDirectory': str(run_dir),
                       'existingEvidence': str(ROOT / 'routing/catalogue/evidence.json'),
                       'scope': 'UK only; no access/topology changes; no production deployment'}
            dump(context_path, context)
        proposal_file, review_file = run_dir / 'proposal.json', run_dir / 'review.json'
        if committed and not (proposal_file.is_file() and review_file.is_file()):
            raise RuntimeError('Committed run requires its saved proposal and review for crash recovery.')
        if proposal_file.is_file():
            proposal = json.loads(proposal_file.read_text())
        else:
            status['status'] = 'researching'; dump(status_path, status)
            try:
                proposal = call_agent(codex, 'research-prompt.md', 'proposal.schema.json', context_path,
                                      run_dir, 'proposal.json', args.agent_timeout)
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                # The independent full-history review still runs after failed research.
                proposal = {'pages': [], 'summary': 'Research failed: ' + str(error)}
                dump(proposal_file, proposal)
                context['researchFailed'] = True
        context['proposalSha256'] = proposal_sha(proposal)
        dump(context_path, context)
        if review_file.is_file():
            review = json.loads(review_file.read_text())
        else:
            status['status'] = 'reviewing'; dump(status_path, status)
            review = call_agent(codex, 'review-prompt.md', 'review.schema.json', context_path,
                                run_dir, 'review.json', args.agent_timeout)
        if review.get('approved') is not True:
            status.update(status='held', reason=review.get('summary', 'Independent review held this batch.'))
            dump(status_path, status)
            return 0
        output = run_dir / 'ratings.sqlite'
        subprocess.run([sys.executable, str(HERE / 'ledger.py'), '--baseline', str(baseline),
                        '--ledger', str(ledger), '--proposal', str(run_dir / 'proposal.json'),
                        '--review', str(run_dir / 'review.json'), '--output', str(output),
                        '--run-id', day], check=True, cwd=ROOT, timeout=600)
        if not output.is_file():
            raise RuntimeError('Ledger did not produce the reviewed ratings artifact.')
        dump(state / 'latest-reviewed.json', {'runId': day, 'artifact': str(output),
                                            'sha256': sha(output), 'deployment': 'pending'})
        status.update(status='complete', artifact=str(output), deployment='pending',
                      finishedAt=dt.datetime.now(dt.timezone.utc).isoformat())
        dump(status_path, status)
        print(json.dumps(status))
        return 0
    except (RuntimeError, ValueError, sqlite3.Error, OSError, subprocess.SubprocessError) as error:
        status.update(status='blocked', reason=str(error), finishedAt=dt.datetime.now(dt.timezone.utc).isoformat())
        dump(status_path, status)
        print(json.dumps(status), file=sys.stderr)
        return 1

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', default=str(STATE))
    parser.add_argument('--baseline')
    parser.add_argument('--codex')
    parser.add_argument('--agent-timeout', type=int, default=5400)
    parser.add_argument('--dry-run', action='store_true')
    raise SystemExit(run(parser.parse_args()))
