#!/usr/bin/env python3
"""Independent, bounded-memory integrity/provenance verification of a ratings DB."""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import tempfile

FIELDS = ('name', 'ref', 'quality', 'rating', 'winding', 'twisty', 'recommendationCount',
          'frequencyRating', 'surfaceConfidence', 'ratingBasis', 'sources')


def digest_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            digest.update(block)
    return digest.hexdigest()


def decode(shape):
    index, lat, lon = 0, 0, 0
    points = []
    while index < len(shape):
        deltas = []
        for _ in range(2):
            shift, result = 0, 0
            while True:
                value = ord(shape[index])-63
                index += 1
                result |= (value & 31) << shift
                shift += 5
                if value < 32:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat += deltas[0]; lon += deltas[1]
        points.append([lon/1e6, lat/1e6])
    return points


def verify(database, source, graph):
    version = digest_file(graph)
    db = sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro', uri=True)
    db.executescript('PRAGMA cache_size=-32768; PRAGMA temp_store=FILE;')
    try:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('SQLite integrity check failed')
        summary = json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0])
        assert summary['schemaVersion'] == 3 and summary['graphVersion'] == version
        assert db.execute('SELECT count(*) FROM sections').fetchone()[0] == summary['sections']
        assert db.execute('SELECT count(*) FROM bounds').fetchone()[0] == summary['sections']
        assert db.execute('SELECT count(*) FROM native_edges').fetchone()[0] == summary['nativeEdges']
        assert not db.execute('SELECT 1 FROM membership m LEFT JOIN sections s ON m.section=s.rowid LEFT JOIN native_edges n ON m.physical=n.id WHERE s.id IS NULL OR n.id IS NULL LIMIT 1').fetchone()
        # The same road may appear in several original source sections. Compare
        # every output section's actual scoring/provenance against its exact source.
        with tempfile.TemporaryDirectory(prefix='ratings-verify-', dir=Path(database).parent) as temp:
            facts = sqlite3.connect(Path(temp)/'facts.sqlite')
            try:
                facts.execute('PRAGMA cache_size=-16384;')
                facts.execute('CREATE TABLE facts(id TEXT PRIMARY KEY,value TEXT)')
                count = 0
                with open(source) as stream:
                    for line in stream:
                        row = json.loads(line)
                        facts.execute('INSERT INTO facts VALUES(?,?)', (row['id'], json.dumps({k: row[k] for k in FIELDS if k in row}, sort_keys=True)))
                        count += 1
                facts.commit()
                assert count == summary['sourceSections']
                memberships, recommendations = 0, 0
                membership_rows = iter(db.execute('SELECT section,physical FROM membership ORDER BY section,physical'))
                current = next(membership_rows, None)
                for rowid, value, bw, be, bs, bn in db.execute('SELECT s.rowid,s.value,b.minx,b.maxx,b.miny,b.maxy FROM sections s LEFT JOIN bounds b ON b.id=s.rowid ORDER BY s.rowid'):
                    section = json.loads(value)
                    assert section['graphVersion'] == version
                    expected = facts.execute('SELECT value FROM facts WHERE id=?', (section['sourceSectionId'],)).fetchone()
                    assert expected is not None, 'Unknown source section'
                    assert json.dumps({k: section[k] for k in FIELDS if k in section}, sort_keys=True) == expected[0], 'Source rating/provenance changed'
                    coords = decode(section['shape'])
                    assert len(coords) >= 2
                    bbox = [min(p[0] for p in coords), min(p[1] for p in coords), max(p[0] for p in coords), max(p[1] for p in coords)]
                    assert all(abs(a-b) < 1e-9 for a, b in zip(bbox, section['bbox']))
                    west, south, east, north = bbox
                    assert bw is not None and bw <= west and bs <= south and be >= east and bn >= north, 'RTree row does not contain its section'
                    assert max(abs(bw-west), abs(bs-south), abs(be-east), abs(bn-north)) < .00003, 'RTree row belongs to another section'
                    ids = []
                    while current is not None and current[0] == rowid:
                        ids.append(current[1])
                        current = next(membership_rows, None)
                    assert collections.Counter(ids) == collections.Counter(section['physicalIds'])
                    memberships += len(ids)
                    recommendations += section.get('recommendationCount', 0) > 0
                    for edge, start, end in section['shortcutRanges']:
                        assert edge.isdigit() and int(edge) > 0
                        assert math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= 1
                assert current is None, 'Orphan section memberships'
                assert recommendations == summary['recommendedSections']
                for key, value in db.execute('SELECT id,value FROM native_edges'):
                    physical, shape, edge_ids = json.loads(value)
                    assert physical == key and edge_ids
                    assert all(edge.isdigit() and int(edge) > 0 for edge in edge_ids)
                    coords = decode(shape)
                    assert len(coords) >= 2
                    canonical = min(coords, list(reversed(coords)))
                    fingerprint = hashlib.sha256(json.dumps(canonical, separators=(',', ':')).encode()).hexdigest()
                    assert key.split(':', 1)[1] == fingerprint, 'Native physical geometry hash changed'
            finally:
                facts.close()
        areas = {}
        for name, lon, lat in [('London', -.1278, 51.5074), ('Lake District', -3.08, 54.46),
                               ('Snowdonia', -3.9, 53.0), ('Scottish Highlands', -4.7, 57.0),
                               ('Belfast', -5.93, 54.6)]:
            areas[name] = db.execute('SELECT count(*) FROM bounds WHERE minx<=? AND maxx>=? AND miny<=? AND maxy>=?', (lon+.3, lon-.3, lat+.3, lat-.3)).fetchone()[0]
        assert all(areas.values()), 'Missing sample-area road coverage'
        return {'status': 'verified', **summary, 'sectionEdgeMemberships': memberships,
                'sampleAreaSections': areas, 'sha256': digest_file(database), 'bytes': Path(database).stat().st_size}
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--graph', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    report = verify(args.database, args.source, args.graph)
    Path(args.report).write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))
