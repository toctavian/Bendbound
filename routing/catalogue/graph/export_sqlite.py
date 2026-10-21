"""Bounded-memory, resumable native ratings export for country-sized graphs.

All nationwide indexes live in SQLite. RAM holds one source/OSM way/shortcut at
once, plus the explicitly bounded native tile cache. Published schema is unchanged.
"""
import hashlib
import json
from pathlib import Path
import resource
import shutil
import sqlite3
import struct
import sys
import tarfile
import time

SQL = '''
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE sections(id TEXT UNIQUE,value TEXT);
CREATE VIRTUAL TABLE bounds USING rtree(id,minx,maxx,miny,maxy);
CREATE TABLE native_edges(id TEXT PRIMARY KEY,value TEXT);
CREATE TABLE membership(physical TEXT,section INTEGER);
CREATE INDEX membership_physical ON membership(physical);
CREATE TABLE export_meta(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE wanted(id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE ways(id TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID;
CREATE TABLE known_upper(id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE segments(key BLOB,section INTEGER,PRIMARY KEY(key,section)) WITHOUT ROWID;
CREATE TABLE shortcuts(section INTEGER,edge TEXT,start REAL,end REAL);
CREATE INDEX shortcuts_section ON shortcuts(section);
CREATE TABLE completed_tiles(name TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE unmapped(id TEXT,recommended INTEGER);
'''
SCRATCH_TABLES = ('export_meta', 'wanted', 'ways', 'known_upper', 'segments',
                  'shortcuts', 'completed_tiles', 'unmapped')


def compact(value):
    return json.dumps(value, separators=(',', ':'))


def digest_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def segment_key(a, b):
    # Native shapes have already been rounded to polyline6 precision, exactly as
    # in the legacy exporter. Binary integer endpoints avoid Python tuple indexes.
    ends = sorted((tuple(round(n * 1e6) for n in a), tuple(round(n * 1e6) for n in b)))
    return struct.pack('<iiii', *ends[0], *ends[1])


def build(source, destination, config, reader, graph_id, project, length, encode):
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    work = destination.with_suffix('.work.sqlite')
    temporary = destination.with_suffix('.publishing.sqlite')
    started = time.monotonic()
    version = digest_file(config['mjolnir']['tile_extract'])
    identity = compact({'graphVersion': version, 'source': digest_file(source),
                        'exporter': digest_file(__file__), 'format': 1})
    db = sqlite3.connect(work)
    db.executescript('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; '
                     'PRAGMA cache_size=-262144; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;')

    def get(key, default=None):
        row = db.execute('SELECT value FROM export_meta WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(key, value):
        db.execute('INSERT OR REPLACE INTO export_meta VALUES(?,?)', (key, compact(value)))

    def progress(event, **values):
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        rss /= 1024 * 1024 if sys.platform == 'darwin' else 1024
        print(compact({'event': event, 'elapsedSeconds': round(time.monotonic()-started, 1),
                       'peakRssMiB': round(rss, 1), **values}), flush=True)
        if shutil.disk_usage(work.parent).free < 4 * 1024**3:
            raise RuntimeError('Less than 4GiB disk headroom; export stopped at a committed checkpoint.')

    def checkpoint(**values):
        for key, value in values.items():
            put(key, value)
        db.commit()
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')

    try:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='export_meta'").fetchone():
            db.executescript(SQL)
            put('identity', identity)
            checkpoint(stage='wanted')
        elif get('identity') != identity:
            raise ValueError('Export checkpoint belongs to different source, graph or exporter; preserve it and start a new output path.')
        progress('ratings.resume', stage=get('stage'), graphVersion=version)

        if get('stage') == 'wanted':
            db.execute('DELETE FROM wanted')
            count = 0
            with source.open() as stream:
                for line in stream:
                    section = json.loads(line)
                    db.executemany('INSERT OR IGNORE INTO wanted VALUES(?)', [(str(w),) for w in section['wayIds']])
                    count += 1
            checkpoint(stage='ways', sourceCount=count)
            progress('ratings.sources', sourceSections=count)

        if get('stage') == 'ways':
            # Only identifiers, not nationwide shapes or source documents, enter RAM.
            wanted = {row[0] for row in db.execute('SELECT id FROM wanted')}
            last = get('wayLine', 0)
            mapped = get('mappedWays', 0)
            with (Path(config['mjolnir']['tile_dir'])/'way_edges.txt').open() as stream:
                for number, line in enumerate(stream, 1):
                    if number <= last:
                        continue
                    fields = line.strip().split(',')
                    db.executemany('INSERT OR IGNORE INTO known_upper VALUES(?)',
                                   [(fields[i],) for i in range(2, len(fields), 2) if (int(fields[i]) & 7) < 2])
                    if fields[0] in wanted:
                        edges, seen = [], {}
                        for i in range(1, len(fields), 2):
                            edge_id = fields[i+1]
                            shape = [[round(x, 6), round(y, 6)] for x, y in reader.get_edge_shape(graph_id(int(edge_id))) ]
                            if len(shape) < 2:
                                continue
                            physical = hashlib.sha256(compact(min(shape, list(reversed(shape)))).encode()).hexdigest()
                            key = fields[0] + ':' + physical
                            if key in seen:
                                seen[key]['edgeIds'].append(edge_id)
                                continue
                            item = {'physicalId': key, 'coordinates': shape, 'edgeIds': [edge_id]}
                            seen[key] = item
                            edges.append(item)
                        db.execute('INSERT OR REPLACE INTO ways VALUES(?,?)', (fields[0], compact(edges)))
                        for edge in edges:
                            row = [edge['physicalId'], encode(edge['coordinates']), edge['edgeIds']]
                            db.execute('INSERT OR REPLACE INTO native_edges VALUES(?,?)', (row[0], compact(row)))
                        mapped += 1
                    if number % 50000 == 0:
                        checkpoint(wayLine=number, mappedWays=mapped)
                        progress('ratings.ways', scannedWays=number, mappedWays=mapped)
            del wanted
            checkpoint(stage='sections', mappedWays=mapped)
            progress('ratings.ways.complete', mappedWays=mapped)

        if get('stage') == 'sections':
            last = get('sourceLine', 0)
            with source.open() as stream:
                for number, line in enumerate(stream, 1):
                    if number <= last:
                        continue
                    source_row = json.loads(line)
                    original = source_row['geometry']['coordinates']
                    chosen = []
                    for way in source_row['wayIds']:
                        stored = db.execute('SELECT value FROM ways WHERE id=?', (str(way),)).fetchone()
                        for edge in json.loads(stored[0]) if stored else []:
                            shape = edge['coordinates']
                            projected = [project(p, original) for p in shape]
                            if max(p[0] for p in projected) > 25:
                                continue
                            if projected[0][1] > projected[-1][1]:
                                shape = list(reversed(shape))
                            chosen.append((min(p[1] for p in projected), edge['physicalId'], shape))
                    chosen.sort(key=lambda e: e[0])
                    groups = []
                    for _, physical, shape in chosen:
                        if groups and length([groups[-1]['coordinates'][-1], shape[0]]) < .001:
                            groups[-1]['coordinates'].extend(shape[1:])
                            groups[-1]['physicalIds'].append(physical)
                            groups[-1]['lengthKm'] += length(shape)
                        else:
                            groups.append({'coordinates': list(shape), 'physicalIds': [physical], 'lengthKm': length(shape)})
                    if not groups:
                        db.execute('INSERT INTO unmapped VALUES(?,?)', (source_row['id'], int(source_row.get('recommendationCount', 0) > 0)))
                    metadata = {k: v for k, v in source_row.items() if k not in ('geometry', 'wayIds', 'lengthKm')}
                    for i, group in enumerate(groups):
                        coords = group['coordinates']
                        section = {**metadata, 'physicalIds': group['physicalIds'], 'lengthKm': group['lengthKm'],
                                   'id': source_row['id'] if len(groups) == 1 else source_row['id'] + '-' + str(i),
                                   'sourceSectionId': source_row['id'], 'graphVersion': version,
                                   'shape': encode(coords), 'shortcutRanges': [],
                                   'bbox': [min(p[0] for p in coords), min(p[1] for p in coords), max(p[0] for p in coords), max(p[1] for p in coords)]}
                        row = db.execute('INSERT INTO sections VALUES(?,?)', (section['id'], compact(section))).lastrowid
                        west, south, east, north = section['bbox']
                        db.execute('INSERT INTO bounds VALUES(?,?,?,?,?)', (row, west, east, south, north))
                        db.executemany('INSERT INTO membership VALUES(?,?)', [(physical, row) for physical in section['physicalIds']])
                        db.executemany('INSERT OR IGNORE INTO segments VALUES(?,?)', [(segment_key(a, b), row) for a, b in zip(coords, coords[1:])])
                    if number % 1000 == 0:
                        checkpoint(sourceLine=number)
                        progress('ratings.sections', sourceSectionsProcessed=number, totalSourceSections=get('sourceCount'))
            checkpoint(stage='shortcuts')
            progress('ratings.sections.complete', sections=db.execute('SELECT count(*) FROM sections').fetchone()[0])

        if get('stage') == 'shortcuts':
            shortcut_count = get('shortcutCount', 0)
            with tarfile.open(config['mjolnir']['tile_extract'], 'r:') as archive:
                for entry in archive:
                    if not entry.name.endswith('.gph'):
                        continue
                    tile = graph_id.from_tile_path(entry.name)
                    if tile.level() > 1 or db.execute('SELECT 1 FROM completed_tiles WHERE name=?', (entry.name,)).fetchone():
                        continue
                    count = reader.get_graph_tile_header(tile).directededgecount
                    for n in range(count):
                        gid = tile+n
                        edge_id = str(gid.value)
                        if db.execute('SELECT 1 FROM known_upper WHERE id=?', (edge_id,)).fetchone():
                            continue
                        try:
                            shape = [[round(x, 6), round(y, 6)] for x, y in reader.get_edge_shape(gid)]
                        except RuntimeError:
                            continue
                        spans = [length([a, b]) for a, b in zip(shape, shape[1:])]
                        total = sum(spans)
                        if total <= 0:
                            continue
                        offset, ranges = 0, {}
                        for (a, b), span in zip(zip(shape, shape[1:]), spans):
                            start, end = offset/total, (offset+span)/total
                            for (index,) in db.execute('SELECT section FROM segments WHERE key=?', (segment_key(a, b),)):
                                chunks = ranges.setdefault(index, [])
                                if chunks and abs(chunks[-1][1]-start) < 1e-8:
                                    chunks[-1][1] = end
                                else:
                                    chunks.append([start, end])
                            offset += span
                        if ranges:
                            shortcut_count += 1
                        for index, chunks in ranges.items():
                            db.executemany('INSERT INTO shortcuts VALUES(?,?,?,?)',
                                           [(index, edge_id, a, min(1, b)) for a, b in chunks if b-a > 1e-8])
                    db.execute('INSERT INTO completed_tiles VALUES(?)', (entry.name,))
                    checkpoint(shortcutCount=shortcut_count)
                    progress('ratings.shortcuts.tile', tile=entry.name, nativeShortcutEdges=shortcut_count)
            checkpoint(stage='finalize')

        if get('stage') == 'finalize':
            # Each section gets only its own shortcut ranges; no global expansion.
            last = get('finalRow', 0)
            while True:
                # Materialize only one batch, closing its SELECT cursor before a
                # WAL checkpoint. An active streaming cursor prevents TRUNCATE.
                batch = db.execute('SELECT rowid,value FROM sections WHERE rowid>? ORDER BY rowid LIMIT 1000', (last,)).fetchall()
                if not batch:
                    break
                for row, value in batch:
                    section = json.loads(value)
                    section['shortcutRanges'] = [[edge, a, b] for edge, a, b in db.execute('SELECT edge,start,end FROM shortcuts WHERE section=? ORDER BY rowid', (row,))]
                    db.execute('UPDATE sections SET value=? WHERE rowid=?', (compact(section), row))
                last = batch[-1][0]
                checkpoint(finalRow=last)
            db.execute('DELETE FROM native_edges WHERE NOT EXISTS(SELECT 1 FROM membership WHERE physical=native_edges.id)')
            if db.execute('SELECT count(*) FROM membership m LEFT JOIN native_edges e ON e.id=m.physical WHERE e.id IS NULL').fetchone()[0]:
                raise ValueError('Missing native edge identity in exported ratings')
            recommended = sum(json.loads(row[0]).get('recommendationCount', 0) > 0 for row in db.execute('SELECT value FROM sections'))
            summary = {'schemaVersion': 3, 'graphVersion': version,
                       'sections': db.execute('SELECT count(*) FROM sections').fetchone()[0],
                       'recommendedSections': recommended,
                       'nativeEdges': db.execute('SELECT count(*) FROM native_edges').fetchone()[0],
                       'sourceSections': get('sourceCount'),
                       'unmappedSections': db.execute('SELECT count(*) FROM unmapped').fetchone()[0]}
            db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', ('summary', compact(summary)))
            checkpoint(stage='publish')

        summary = json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0])
        progress('ratings.publish', **summary)
        temporary.unlink(missing_ok=True)
        target = sqlite3.connect(temporary)
        try:
            db.backup(target)
            target.execute('PRAGMA journal_mode=DELETE')
            for table in SCRATCH_TABLES:
                target.execute('DROP TABLE ' + table)
            target.commit()
            target.execute('VACUUM')
            if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Ratings SQLite integrity check failed')
        finally:
            target.close()
        temporary.replace(destination)
        progress('ratings.exported', **summary, bytes=destination.stat().st_size,
                 nativeShortcutEdges=get('shortcutCount', 0),
                 unmappedRecommendedSections=db.execute('SELECT count(*) FROM unmapped WHERE recommended=1').fetchone()[0])
        return summary
    finally:
        db.close()
