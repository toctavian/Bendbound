"""Prove a research artifact changes only rating/evidence fields, never the road graph."""
import hashlib
import itertools
import json
import math
from pathlib import Path
import sqlite3

ALLOWED = {'rating', 'recommendationCount', 'weightedEvidenceCount',
           'frequencyRating', 'ratingBasis', 'sources'}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def validate(baseline, artifact):
    with sqlite3.connect(Path(baseline).resolve().as_uri() + '?mode=ro', uri=True) as a, \
         sqlite3.connect(Path(artifact).resolve().as_uri() + '?mode=ro', uri=True) as b:
        for db in (a, b):
            db.execute('PRAGMA cache_size=-16384')
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Invalid SQLite integrity')
        schemas = list(a.execute("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"))
        if schemas != list(b.execute("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")):
            raise ValueError('Overlay schema changed')
        meta = [json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0]) for db in (a,b)]
        if {k:v for k,v in meta[0].items() if k != 'recommendedSections'} != {k:v for k,v in meta[1].items() if k != 'recommendedSections'}:
            raise ValueError('Graph identity or counts changed')
        tables = [r[0] for r in a.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        changed, recommended = 0, 0
        for table in tables:
            if table == 'sections':
                qa, qb = (db.execute('SELECT id,value FROM sections ORDER BY id') for db in (a,b))
                for left, right in itertools.zip_longest(qa, qb):
                    if not left or not right or left[0] != right[0]:
                        raise ValueError('Section identities changed')
                    x, y = json.loads(left[1]), json.loads(right[1])
                    if {k:v for k,v in x.items() if k not in ALLOWED} != {k:v for k,v in y.items() if k not in ALLOWED}:
                        raise ValueError('Geometry, eligibility or quality changed')
                    rating = y.get('rating')
                    if not isinstance(rating, (int,float)) or not math.isfinite(rating) or not 0 <= rating <= 5:
                        raise ValueError('Invalid rating')
                    recommended += y.get('recommendationCount',0) > 0
                    changed += x != y
            else:
                # Compare all stored data, including native edges and RTree shadow tables.
                qa, qb = (db.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY 1') for db in (a,b))
                for left, right in itertools.zip_longest(qa, qb):
                    if table == 'metadata' and left and right and left[0] == right[0] == 'summary':
                        continue
                    if left != right:
                        raise ValueError('Immutable graph table changed: ' + table)
        if recommended != meta[1]['recommendedSections']:
            raise ValueError('Recommended count differs from actual sections')
        return {'graphVersion': meta[1]['graphVersion'], 'sections': meta[1]['sections'],
                'recommendedSections': recommended, 'changedSections': changed}
