"""Executed only through AWS MCP/SSM. Install one immutable reviewed overlay."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys
import time
import urllib.request

ROOT = Path('/opt/bendbound/routing')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError('Release command failed: ' + args[0])
    return result.stdout


def ready(graph):
    for _ in range(60):
        try:
            h = json.load(urllib.request.urlopen('http://127.0.0.1:8088/health', timeout=3))
            if h['catalogue']['graph_version'] == graph:
                return h
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('API readiness failed')


def install(config):
    active = ROOT / '.data/uk-current/graph/ratings.sqlite'
    releases = ROOT / '.data/research-published'
    releases.mkdir(exist_ok=True)
    with (releases/'publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = digest(active)
        already = current == config['sha256']
        if current not in {config['expectedPreviousSha256'], config['sha256']}:
            raise ValueError('Remote overlay changed; refusing stale publication')
        before = ready(config['graphVersion'])
        target = releases / (config['runId']+'-'+config['sha256'])
        target.mkdir(exist_ok=True)
        candidate = target/'ratings.sqlite'
        if not candidate.exists() or digest(candidate) != config['sha256']:
            temporary = target/'download.tmp'
            with urllib.request.urlopen(config['downloadUrl'],timeout=120) as response, temporary.open('wb') as output:
                while True:
                    block = response.read(1024*1024)
                    if not block:break
                    output.write(block)
            if digest(temporary) != config['sha256']:
                raise ValueError('Downloaded ratings checksum differs')
            temporary.chmod(0o644)
            temporary.replace(candidate)
        with sqlite3.connect(candidate.as_uri()+'?mode=ro',uri=True) as db:
            if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('Remote SQLite check failed')
            metadata=json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0])
            if metadata['graphVersion'] != config['graphVersion']:
                raise ValueError('Graph version differs')
        native = ROOT/'.data/uk-current/runtime/verify-ratings.mjs'
        run('docker','run','--rm','--network','bendbound-catalogue_default','--memory','256m',
            '-v',str(target)+':/ratings:ro','-v',str(native)+':/app/catalogue/uk/verify-ratings.mjs:ro',
            'bendbound-routing-api:uk-20261020','--max-old-space-size=256','uk/verify-ratings.mjs',
            '/ratings/ratings.sqlite','http://valhalla-graph:8003')
        # Save the deployed national baseline once, then one rollback hard link per release.
        baseline = releases/'national-baseline.sqlite'
        if not baseline.exists():
            if already:raise ValueError('Missing original baseline; reconcile interrupted release')
            os.link(active,baseline)
        backup = target/'previous.sqlite'
        if not backup.exists():
            if already:raise ValueError('Missing rollback; reconcile interrupted release')
            os.link(active,backup)
        replacement = active.with_name('.ratings-publish.tmp')
        replacement.unlink(missing_ok=True)
        os.link(candidate,replacement)
        try:
            os.replace(replacement,active)
            run('docker','restart','bendbound-catalogue-api-1')
            after=ready(config['graphVersion'])
            assert after['catalogue']['recommended_sections']==metadata['recommendedSections']
            entries=json.loads(run('docker','inspect','bendbound-catalogue-caddy-1','--format','{{json .Config.Env}}'))
            os.environ['ROUTING_SMOKE_TOKEN']=next(x.split('=',1)[1] for x in entries if x.startswith('ROUTING_API_TOKEN='))
            smoke=runpy.run_path(str(ROOT/'.data/uk-current/runtime/verify-service.py'))
            report=smoke['verify']('https://api.bendboundapp.com')
            (target/'public-verification.json').write_text(json.dumps(report,indent=2)+'\n')
            assert digest(active)==config['sha256']
        except Exception:
            replacement.unlink(missing_ok=True)
            os.link(backup,replacement)
            os.replace(replacement,active)
            run('docker','restart','bendbound-catalogue-api-1')
            restored=ready(config['graphVersion'])
            assert digest(active)==config['expectedPreviousSha256']
            raise RuntimeError('Publication failed; previous ratings restored') from None
        result={'status':'already-published' if already else 'published','sha256':config['sha256'],'previousSha256':config['expectedPreviousSha256'],
                'graphVersion':config['graphVersion'],'runId':config['runId']}
        (target/'published.json').write_text(json.dumps(result,indent=2)+'\n')
        # Retain three successful versions plus the immutable original baseline.
        successful=sorted((p for p in releases.iterdir() if p.is_dir() and (p/'published.json').exists()),key=lambda p:p.name,reverse=True)
        for old in successful[3:]:
            for name in ('ratings.sqlite','previous.sqlite'):
                (old/name).unlink(missing_ok=True)
        return result


if __name__=='__main__':
    try:
        print(json.dumps(install(json.load(sys.stdin))))
    except Exception as error:
        # Never emit signed URLs, authorization or command output.
        print(json.dumps({'status':'failed','errorType':type(error).__name__,
                          'message':str(error) if isinstance(error,(ValueError,AssertionError,RuntimeError)) else 'Remote publication failed; inspect the release state'}))
        raise SystemExit(1)
