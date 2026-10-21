#!/usr/bin/env python3
"""Build national ratings on this Mac with memory/disk limits and retained diagnostics."""
import datetime as dt
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
STAGE = ROOT/'routing/.data/uk-20261020'
NAME = 'bendbound-uk-ratings-export-v2'
IMAGE = 'ghcr.io/valhalla/valhalla:3.9.0@sha256:511c095b8caf393dccceb8b519ec96b6f85a0166b2288ba014a8a748acc5a63c'


def main():
    assert (STAGE/'GRAPH_READY').exists(), 'Verified graph preparation is required'
    assert (STAGE/'valhalla/tiles.tar').is_file()
    assert (STAGE/'ratings-source.jsonl').is_file()
    output = STAGE/'graph'
    output.mkdir(exist_ok=True)
    free = shutil.disk_usage(STAGE).free
    if free < 6*1024**3:
        raise RuntimeError('At least6GiB free is required before starting;4GiB is reserved during export.')
    existing = subprocess.run(['docker', 'inspect', NAME], capture_output=True, text=True)
    if existing.returncode == 0:
        state = json.loads(existing.stdout)[0]['State']
        if state['Running']:
            raise RuntimeError('Ratings export is already running')
        (output/'previous-container-state.json').write_text(json.dumps(state, indent=2)+'\n')
        subprocess.run(['docker', 'rm', NAME], check=True, stdout=subprocess.DEVNULL)
    command = ['docker', 'run', '--init', '--name', NAME, '--cpus', '2', '--memory', '5g', '--memory-swap', '5g',
               '--ulimit', 'core=0', '--log-driver', 'local', '--log-opt', 'max-size=5m',
               '-e', 'PYTHONDONTWRITEBYTECODE=1',
               '-v', str(STAGE/'valhalla')+':/data:ro',
               '-v', str(STAGE/'ratings-source.jsonl')+':/input/ratings-source.jsonl:ro',
               '-v', str(output)+':/output',
               '-v', str(ROOT/'routing/catalogue/graph')+':/tools:ro',
               '--entrypoint', 'python3', IMAGE, '-u', '/tools/export.py',
               '--source', '/input/ratings-source.jsonl', '--output', '/output/ratings.sqlite',
               '--config', '/data/valhalla.json']
    (STAGE/'RATINGS_READY').unlink(missing_ok=True)
    log_path = output/'export.log'
    print('Starting bounded export with5GiB RAM limit; graph read-only. Log: '+str(log_path), flush=True)
    with log_path.open('a') as log, (output/'resources.jsonl').open('a') as metrics:
        log.write('\nRatings export started '+dt.datetime.now(dt.timezone.utc).isoformat()+'\n')
        log.flush()
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        stopped_low_disk = False
        while process.poll() is None:
            free = shutil.disk_usage(STAGE).free
            sample = {'time': dt.datetime.now(dt.timezone.utc).isoformat(), 'freeDiskBytes': free}
            memory = subprocess.run(['docker', 'exec', NAME, 'cat', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.peak'], capture_output=True, text=True)
            numbers = memory.stdout.split()
            if numbers:
                sample['memoryCurrentBytes'] = int(numbers[0])
            if len(numbers) > 1:
                sample['memoryPeakBytes'] = int(numbers[1])
            metrics.write(json.dumps(sample)+'\n'); metrics.flush()
            print(json.dumps(sample), flush=True)
            if free < 4*1024**3:
                stopped_low_disk = True
                subprocess.run(['docker', 'stop', '-t', '15', NAME], check=True, stdout=subprocess.DEVNULL)
                break
            time.sleep(15)
        code = process.wait()
    state_raw = subprocess.run(['docker', 'inspect', '--format', '{{json .State}}', NAME], capture_output=True, text=True, check=True)
    state = json.loads(state_raw.stdout)
    report = {'container': state, 'exitCode': code, 'stoppedLowDisk': stopped_low_disk, 'log': str(log_path)}
    (output/'export-status.json').write_text(json.dumps(report, indent=2)+'\n')
    if code or state.get('OOMKilled') or stopped_low_disk:
        raise RuntimeError('Ratings export stopped; retained container diagnostics/checkpoint in '+str(output))
    path = output/'ratings.sqlite'
    with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Final SQLite integrity failed')
        summary = json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0])
        if summary['schemaVersion'] != 3 or summary['sections'] < 1:
            raise RuntimeError('Final rating summary is invalid')
    (STAGE/'RATINGS_READY').write_text(json.dumps(summary, indent=2)+'\n')
    print(json.dumps({'status': 'complete', **summary, 'bytes': path.stat().st_size}), flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
