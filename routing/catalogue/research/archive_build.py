#!/usr/bin/env python3
"""Copy build scratch to a mounted NAS, verify every byte, then remove local copies."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / 'routing/.data'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def archive(destination):
    # Fail closed if the SMB mount has disappeared; never fill a local /Volumes dir.
    mounts = subprocess.check_output(['mount'], text=True)
    if '//octav@192.168.1.247/home on /Volumes/home (smbfs,' not in mounts:
        raise RuntimeError('Expected NAS SMB share is not mounted')
    destination = destination.resolve()
    if not destination.is_relative_to(Path('/Volumes/home')):
        raise ValueError('Destination must be inside the verified NAS mount')
    state = DATA / 'research'
    with (state / 'daily.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Preserve exact baseline path: saved review contexts bind to it.
        roots = [DATA / name for name in ('map', 'graphhopper', 'valhalla')]
        uk = DATA / 'uk-20261020'
        roots += [uk / name for name in ('map', 'valhalla', 'api-context')]
        roots += [uk / 'graph/ratings.work.sqlite']
        roots += [uk / name for name in ('api-image.tar.gz', 'london-ratings-source.jsonl.gz', 'ratings-source.jsonl')]
        files = sorted(p for root in roots if root.exists()
                       for p in (root.rglob('*') if root.is_dir() else [root]) if p.is_file())
        if any(p.is_symlink() for p in files):
            raise ValueError('Unexpected symlink in build scratch')
        destination.mkdir(parents=True, exist_ok=True)
        previous_path = destination / 'archive-manifest.json'
        previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
        archived_records = previous.get('files', [])
        records = []
        total = sum(p.stat().st_size for p in files)
        print(json.dumps({'files': len(files), 'bytes': total, 'destination': str(destination)}), flush=True)
        for index, source in enumerate(files):
            relative = source.relative_to(DATA)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            before = source.stat()
            checksum = digest(source)
            if not target.is_file() or target.stat().st_size != before.st_size or digest(target) != checksum:
                tmp = target.with_name(target.name + '.partial')
                shutil.copyfile(source, tmp)
                if digest(tmp) != checksum:
                    raise RuntimeError('NAS checksum mismatch: ' + str(relative))
                tmp.replace(target)
            if source.stat().st_mtime_ns != before.st_mtime_ns or digest(source) != checksum:
                raise RuntimeError('Source changed during copy: ' + str(relative))
            records.append({'path': str(relative), 'bytes': before.st_size, 'sha256': checksum})
            if index % 100 == 0 or before.st_size > 100_000_000:
                print(json.dumps({'verified': index + 1, 'of': len(files), 'path': str(relative)}), flush=True)
        # Preserve receipts for files already moved on an earlier successful pass.
        combined = {r['path']: r for r in archived_records + records}
        manifest = {'destination': str(destination), 'files': list(combined.values()),
                    'bytes': sum(r['bytes'] for r in combined.values()), 'status': 'verified'}
        text = json.dumps(manifest, indent=2) + '\n'
        (destination / 'archive-manifest.json').write_text(text)
        (state / 'build-archive.json').write_text(text)
        # Recheck ALL destination bytes before deleting any source, including resumed copies.
        for record in records:
            if digest(destination / record['path']) != record['sha256']:
                raise RuntimeError('Final NAS verification failed')
        for record in records:
            source = DATA / record['path']
            if digest(source) != record['sha256']:
                raise RuntimeError('Source changed before removal')
            source.unlink()
        for root in roots:
            if root.is_dir():
                for directory in sorted(root.rglob('*'), reverse=True):
                    if directory.is_dir():
                        directory.rmdir()
                root.rmdir()
        manifest['status'] = 'moved'
        text = json.dumps(manifest, indent=2) + '\n'
        (destination / 'archive-manifest.json').write_text(text)
        (state / 'build-archive.json').write_text(text)
        print(json.dumps({'status': 'moved', 'bytesFreed': total}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=Path('/Volumes/home/Bendbound/routing-builds/2026-10-25'))
    archive(parser.parse_args().destination)
