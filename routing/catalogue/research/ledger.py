"""Offline, append-only editorial evidence ledger. Never changes the input graph.

Policy: linked publisher/syndication identities form conservative independence
groups. Only the strongest observation per group contributes fractional evidence.
The existing 70/30 geometry/frequency formula is retained, including negative deltas.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import tempfile
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

POLICY = 'guide-frequency-70-30-independent-v1'


def canonical_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Invalid public source URL')
    host = parsed.hostname.lower()
    if parsed.port and parsed.port not in (80, 443):
        host += ':' + str(parsed.port)
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
             if not k.lower().startswith('utm_') and k.lower() not in ('fbclid', 'gclid')]
    return urlunsplit((parsed.scheme, host, parsed.path.rstrip('/') or '/', urlencode(sorted(query)), ''))


def required_text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Missing ' + label)
    return value.strip()


def weight_value(value):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError('Evidence weight must be finite and between 0 and 1')
    return float(value)


def rating(quality, count):
    return max(0., min(5., quality if count == 0 else .7 * quality + .3 * (1 + 4 * count / (count + 2))))


def evidence_weight(rows):
    """Conservatively collapse connected publisher/syndication duplicates.

    A publisher cannot gain credit by publishing many pages, or by having its
    work republished under another publisher. Transitive links are conservatively
    treated as one independence group, pending explicit reviewer correction.
    """
    parents = {}

    def root(key):
        parents.setdefault(key, key)
        while parents[key] != key:
            parents[key] = parents[parents[key]]
            key = parents[key]
        return key

    active = [row for row in rows if row['weight'] > 0]
    for row in active:
        a, b = root(('publisher', row['publisher'])), root(('work', row['syndication_key']))
        parents[b] = a
    strongest = {}
    for row in active:
        key = root(('publisher', row['publisher']))
        strongest[key] = max(strongest.get(key, 0.), row['weight'])
    return sum(strongest.values())


SCHEMA = '''
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE pages(url TEXT PRIMARY KEY,title TEXT NOT NULL,publisher TEXT NOT NULL,syndication_key TEXT NOT NULL,checked_at TEXT NOT NULL,notes TEXT NOT NULL,run_id TEXT NOT NULL,content_hash TEXT,retrieval_method TEXT NOT NULL);
CREATE TABLE sections(section_id TEXT PRIMARY KEY,quality REAL NOT NULL,baseline_rating REAL NOT NULL,road_ref TEXT NOT NULL,graph_version TEXT NOT NULL,legacy_unattributed_weight REAL NOT NULL,scope_bbox TEXT NOT NULL);
CREATE TABLE observations(observation_id TEXT PRIMARY KEY,url TEXT NOT NULL,section_id TEXT NOT NULL,publisher TEXT NOT NULL,syndication_key TEXT NOT NULL,run_id TEXT NOT NULL,checked_at TEXT NOT NULL,reason TEXT NOT NULL,is_baseline INTEGER NOT NULL);
CREATE TABLE events(id INTEGER PRIMARY KEY,observation_id TEXT,run_id TEXT NOT NULL,kind TEXT NOT NULL,source_url TEXT,publisher TEXT,syndication_key TEXT,section_id TEXT NOT NULL,graph_version TEXT NOT NULL,prior_weight REAL,new_weight REAL,prior_publisher_weight REAL,new_publisher_weight REAL,before_rating REAL NOT NULL,after_rating REAL NOT NULL,delta REAL,reason TEXT NOT NULL,policy_version TEXT NOT NULL);
CREATE INDEX events_section ON events(section_id,id);
CREATE INDEX events_observation ON events(observation_id,id);
CREATE INDEX observations_section ON observations(section_id);
CREATE TABLE runs(run_id TEXT PRIMARY KEY,input_digest TEXT NOT NULL);
CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'Immutable observation'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'Immutable observation'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Append-only contribution events'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Append-only contribution events'); END;
'''


def digest_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def open_readonly(path):
    conn = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def insert_event(conn, **values):
    values['policy_version'] = POLICY
    columns = ','.join(values)
    conn.execute(f"INSERT INTO events({columns}) VALUES({','.join('?' for _ in values)})", tuple(values.values()))


def section_coordinates(section):
    if 'geometry' in section:
        return section['geometry']['coordinates']
    shape = section.get('shape')
    if not isinstance(shape, str) or not shape:
        raise ValueError('Missing native section shape')
    coordinates, offset, latitude, longitude = [], 0, 0, 0
    while offset < len(shape):
        deltas = []
        for _ in range(2):
            value, shift = 0, 0
            while True:
                if offset >= len(shape) or shift > 35:
                    raise ValueError('Malformed native section shape')
                byte = ord(shape[offset]) - 63
                offset += 1
                if not 0 <= byte <= 63:
                    raise ValueError('Malformed native section shape')
                value |= (byte & 31) << shift
                shift += 5
                if byte < 32:
                    break
            deltas.append(~(value >> 1) if value & 1 else value >> 1)
        latitude += deltas[0]
        longitude += deltas[1]
        coordinates.append([longitude / 1e6, latitude / 1e6])
    return coordinates


def bootstrap(conn, baseline, baseline_hash):
    conn.executescript(SCHEMA)
    conn.execute('INSERT INTO metadata VALUES(?,?)', ('baseline_sha256', baseline_hash))
    conn.execute('INSERT INTO metadata VALUES(?,?)', ('policy_version', POLICY))
    with open_readonly(baseline) as source:
        summary = json.loads(source.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0])
        version = summary['graphVersion']
        conn.execute('INSERT INTO metadata VALUES(?,?)', ('graph_version', version))
        for row in source.execute('SELECT value FROM sections ORDER BY id'):
            section = json.loads(row[0])
            sid, quality = str(section['id']), float(section['quality'])
            if section.get('graphVersion', version) != version:
                raise ValueError('Baseline section graph version mismatch')
            sources = section.get('sources', [])
            if not math.isfinite(quality) or not 0 <= quality <= 5:
                raise ValueError('Invalid baseline quality')
            known_publishers = set()
            for i, src in enumerate(sources):
                if not isinstance(src, dict) or not src.get('url'):
                    continue
                url = canonical_url(src['url'])
                publisher = str(src.get('publisher') or 'unknown-baseline:' + str(src.get('id', i))).strip().casefold()
                known_publishers.add(publisher)
                oid = 'baseline:' + hashlib.sha256((sid + '\0' + publisher + '\0' + url).encode()).hexdigest()
                work = 'baseline-source:' + str(src.get('id') or url)
                conn.execute('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?,?,?,?)',
                             (oid, url, sid, publisher, work, 'baseline', str(src.get('checkedAt') or 'unknown'),
                              'Historical baseline source; original ingestion delta unavailable', 1))
                if conn.execute('SELECT 1 FROM events WHERE observation_id=?', (oid,)).fetchone() is None:
                    insert_event(conn, observation_id=oid, run_id='baseline', kind='baseline-observation', source_url=url,
                                 publisher=publisher, syndication_key=work, section_id=sid, graph_version=version,
                                 prior_weight=None, new_weight=1., prior_publisher_weight=None, new_publisher_weight=1.,
                                 before_rating=section['rating'], after_rating=section['rating'], delta=None,
                                 reason='Historical snapshot; no historical per-source rating delta is known')
                conn.execute('INSERT OR IGNORE INTO pages VALUES(?,?,?,?,?,?,?,?,?)',
                             (url, str(src.get('title') or src.get('id') or 'Historical source'), publisher, work,
                              str(src.get('checkedAt') or 'unknown'), 'Historical baseline metadata; not re-fetched', 'baseline', None, 'legacy-manifest'))
            legacy = max(0., float(section.get('recommendationCount', 0)) - len(known_publishers))
            coordinates = section_coordinates(section)
            if not coordinates or any(len(p) < 2 or not all(isinstance(n, (float, int)) and math.isfinite(n) for n in p[:2]) for p in coordinates):
                raise ValueError('Invalid baseline section geometry')
            bbox = [min(p[0] for p in coordinates), min(p[1] for p in coordinates), max(p[0] for p in coordinates), max(p[1] for p in coordinates)]
            if not isinstance(section['rating'], (float, int)) or not math.isfinite(section['rating']) or not 0 <= section['rating'] <= 5:
                raise ValueError('Invalid baseline rating')
            conn.execute('INSERT INTO sections VALUES(?,?,?,?,?,?,?)',
                         (sid, quality, section['rating'], str(section.get('ref', '')), version, legacy, json.dumps(bbox)))
            insert_event(conn, observation_id=None, run_id='baseline', kind='baseline-snapshot', section_id=sid,
                         graph_version=version, before_rating=section['rating'], after_rating=section['rating'], delta=None,
                         reason='Original per-road snapshot; historical contribution deltas and missing source identities are unknown')


def current_rows(conn, section_id):
    return [dict(row) for row in conn.execute('''SELECT o.*,e.new_weight AS weight FROM observations o JOIN events e ON e.id=(SELECT MAX(id) FROM events WHERE observation_id=o.observation_id) WHERE o.section_id=? ORDER BY o.observation_id''', (section_id,))]


def section_rating(conn, section, rows):
    # Preserve imported baseline bit-for-bit until that section has a research event.
    prior = conn.execute("SELECT after_rating FROM events WHERE section_id=? AND kind IN ('addition','correction') ORDER BY id DESC LIMIT 1", (section['section_id'],)).fetchone()
    return prior[0] if prior else section['baseline_rating']


def validate(conn, proposal, review, run_id):
    if review.get('approved') is not True:
        raise ValueError('Reviewer did not approve publication')
    pages = proposal.get('pages')
    if not isinstance(pages, list) or not 0 <= len(pages) <= 20:
        raise ValueError('Proposal must contain 0 to 20 pages')
    urls, observations, normalized = set(), {}, []
    for page in pages:
        url = canonical_url(required_text(page.get('url'), 'URL'))
        if url in urls or conn.execute('SELECT 1 FROM pages WHERE url=?', (url,)).fetchone():
            raise ValueError('Page is duplicated or was already registered')
        urls.add(url)
        publisher = required_text(page.get('publisher'), 'publisher identity').casefold()
        work = required_text(page.get('syndicationKey'), 'syndication identity').casefold()
        content_hash = page.get('contentHash')
        if content_hash is not None:
            if not isinstance(content_hash, str) or len(content_hash) != 64 or any(c not in '0123456789abcdefABCDEF' for c in content_hash):
                raise ValueError('contentHash must be a SHA256 hex digest or null')
            content_hash = content_hash.lower()
        retrieval_method = required_text(page.get('retrievalMethod', 'live-web-read'), 'retrieval method')
        normalized.append((url, required_text(page.get('title'), 'title'), publisher, work,
                           required_text(page.get('checkedAt'), 'check timestamp'), str(page.get('notes', '')), run_id, content_hash, retrieval_method))
        roads = page.get('roads')
        if not isinstance(roads, list) or not roads:
            raise ValueError('Page must have specific route observations')
        for road in roads:
            sid = required_text(road.get('sectionId'), 'sectionId')
            section = conn.execute('SELECT * FROM sections WHERE section_id=?', (sid,)).fetchone()
            if section is None or road.get('roadRef') != section['road_ref'] or not section['road_ref']:
                raise ValueError('Section road reference mismatch or ambiguous road')
            if road.get('fullSectionScope') is not True:
                raise ValueError('Explicit full-section scope confirmation is required')
            scope = road.get('scopeBbox')
            if not isinstance(scope, list) or len(scope) != 4 or not all(isinstance(n, (float, int)) and not isinstance(n, bool) and math.isfinite(n) for n in scope):
                raise ValueError('Source-supported scopeBbox required')
            west, south, east, north = scope
            if not -180 <= west <= east <= 180 or not -90 <= south <= north <= 90:
                raise ValueError('Invalid source-supported bounding rectangle')
            sw, ss, se, sn = json.loads(section['scope_bbox'])
            if not (west <= sw and south <= ss and east >= se and north >= sn):
                raise ValueError('Full native section is outside the source-supported scope')
            if (url, sid) in observations:
                raise ValueError('Duplicate road observation')
            observations[(url, sid)] = {'url': url, 'section_id': sid, 'publisher': publisher, 'syndication_key': work,
                'checked_at': page['checkedAt'], 'reason': required_text(road.get('reason'), 'route evidence reason')}
    decisions = {}
    for decision in review.get('decisions', []):
        key = (canonical_url(required_text(decision.get('url'), 'review URL')), required_text(decision.get('sectionId'), 'review section'))
        if key in decisions or key not in observations:
            raise ValueError('Duplicate or unmatched reviewer decision')
        decisions[key] = (weight_value(decision.get('weight')), required_text(decision.get('reason'), 'review rationale'))
    if set(decisions) != set(observations):
        raise ValueError('Review must cover every proposed road observation')
    adjustments, seen = [], set()
    for change in review.get('adjustments', []):
        oid = required_text(change.get('observationId'), 'prior observation ID')
        row = conn.execute('SELECT * FROM observations WHERE observation_id=?', (oid,)).fetchone()
        if row is None or oid in seen:
            raise ValueError('Unknown or duplicate prior correction')
        seen.add(oid)
        adjustments.append((dict(row), weight_value(change.get('weight')), required_text(change.get('reason'), 'correction rationale')))
    return normalized, observations, decisions, adjustments


def apply_change(conn, obs, new_weight, reason, run_id, kind):
    sid = obs['section_id']
    section = conn.execute('SELECT * FROM sections WHERE section_id=?', (sid,)).fetchone()
    rows = current_rows(conn, sid)
    before = section_rating(conn, section, rows)
    old = next((row['weight'] for row in rows if row['observation_id'] == obs['observation_id']), 0.)
    before_pub = max([r['weight'] for r in rows if r['publisher'] == obs['publisher']] or [0.])
    updated = [r for r in rows if r['observation_id'] != obs['observation_id']]
    updated.append({**obs, 'weight': new_weight})
    after_pub = max([r['weight'] for r in updated if r['publisher'] == obs['publisher']] or [0.])
    old_count = evidence_weight(rows) + section['legacy_unattributed_weight']
    new_count = evidence_weight(updated) + section['legacy_unattributed_weight']
    # A duplicate/rejected observation must not change an imported baseline rating.
    after = before if abs(old_count - new_count) < 1e-12 else rating(section['quality'], new_count)
    insert_event(conn, observation_id=obs['observation_id'], run_id=run_id, kind=kind, source_url=obs['url'],
                 publisher=obs['publisher'], syndication_key=obs['syndication_key'], section_id=sid,
                 graph_version=section['graph_version'], prior_weight=old, new_weight=new_weight,
                 prior_publisher_weight=before_pub, new_publisher_weight=after_pub,
                 before_rating=before, after_rating=after, delta=after-before, reason=reason)


def export_jsonl(conn, table, output):
    temp = Path(str(output) + '.tmp')
    try:
        with temp.open('w') as stream:
            for row in conn.execute('SELECT * FROM ' + table + (' ORDER BY id' if table == 'events' else ' ORDER BY url')):
                stream.write(json.dumps(dict(row), sort_keys=True, separators=(',', ':')) + '\n')
        os.replace(temp, output)
    finally:
        temp.unlink(missing_ok=True)


def publish_graph(conn, baseline, output):
    temp = Path(str(output) + '.tmp')
    try:
        # SQLite backup provides a coherent snapshot, including committed WAL contents.
        with open_readonly(baseline) as source, sqlite3.connect(temp) as target:
            source.backup(target)
            affected = [r[0] for r in conn.execute("SELECT DISTINCT section_id FROM events WHERE kind IN ('addition','correction')")]
            for sid in affected:
                stored = target.execute('SELECT value FROM sections WHERE id=?', (sid,)).fetchone()
                section = json.loads(stored[0])
                rows = current_rows(conn, sid)
                original = conn.execute('SELECT * FROM sections WHERE section_id=?', (sid,)).fetchone()
                count = evidence_weight(rows) + original['legacy_unattributed_weight']
                section['rating'] = section_rating(conn, original, rows)
                section['recommendationCount'] = int(evidence_weight([{**r, 'weight': 1.} for r in rows if r['weight'] > 0])) + original['legacy_unattributed_weight']
                section['weightedEvidenceCount'] = count
                section['frequencyRating'] = None if count == 0 else 1 + 4 * count / (count + 2)
                section['ratingBasis'] = 'geometry-and-guide-frequency' if count else 'geometry'
                section['sources'] = [{'observationId': row['observation_id'], 'url': row['url'], 'publisher': row['publisher'],
                                       'syndicationKey': row['syndication_key'], 'evidenceWeight': row['weight'],
                                       'checkedAt': row['checked_at']} for row in rows if row['weight'] > 0]
                target.execute('UPDATE sections SET value=? WHERE id=?', (json.dumps(section, separators=(',', ':')), sid))
            summary = json.loads(target.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0])
            summary['recommendedSections'] = sum(json.loads(row[0]).get('recommendationCount', 0) > 0 for row in target.execute('SELECT value FROM sections'))
            target.execute("UPDATE metadata SET value=? WHERE key='summary'", (json.dumps(summary, separators=(',', ':')),))
            if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Output SQLite integrity check failed')
        os.replace(temp, output)
    finally:
        temp.unlink(missing_ok=True)


def run(baseline, ledger, proposal, review, output, run_id):
    baseline, ledger, output = map(Path, (baseline, ledger, output))
    if len({p.resolve() for p in (baseline, ledger, output)}) != 3:
        raise ValueError('Baseline, ledger and output must be distinct files')
    run_id = required_text(run_id, 'run ID')
    payload_hash = hashlib.sha256(json.dumps({'proposal': proposal, 'review': review}, sort_keys=True).encode()).hexdigest()
    baseline_hash = digest_file(baseline)
    proposal_hash = hashlib.sha256(json.dumps(proposal, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()
    if review.get('reviewedBaselineSha256') != baseline_hash:
        raise ValueError('Reviewer did not inspect this baseline snapshot')
    if review.get('reviewedProposalSha256') != proposal_hash:
        raise ValueError('Proposal changed after independent review')
    ledger.parent.mkdir(parents=True, exist_ok=True)
    # Work on a private copy. Any input/validation failure leaves ledger and output untouched.
    handle, name = tempfile.mkstemp(prefix='.ledger-', suffix='.sqlite', dir=ledger.parent)
    os.close(handle)
    stage = Path(name)
    try:
        if ledger.exists():
            with open_readonly(ledger) as source, sqlite3.connect(stage) as target:
                source.backup(target)
        conn = sqlite3.connect(stage)
        conn.row_factory = sqlite3.Row
        try:
            if not ledger.exists():
                bootstrap(conn, baseline, baseline_hash)
            elif conn.execute("SELECT value FROM metadata WHERE key='baseline_sha256'").fetchone()[0] != baseline_hash:
                raise ValueError('Baseline changed; explicit rebase is required')
            previous = conn.execute('SELECT input_digest FROM runs WHERE run_id=?', (run_id,)).fetchone()
            if previous:
                if previous[0] != payload_hash:
                    raise ValueError('Run ID was already used for different input')
            else:
                expected_hash = digest_file(ledger) if ledger.exists() else 'absent'
                if review.get('reviewedLedgerSha256') != expected_hash:
                    raise ValueError('Reviewer did not inspect the current full ledger snapshot')
                pages, observations, decisions, adjustments = validate(conn, proposal, review, run_id)
                conn.executemany('INSERT INTO pages VALUES(?,?,?,?,?,?,?,?,?)', pages)
                for key, obs in sorted(observations.items()):
                    oid = hashlib.sha256((obs['url'] + '\0' + obs['section_id']).encode()).hexdigest()
                    obs['observation_id'] = oid
                    conn.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?)',
                                 (oid, obs['url'], obs['section_id'], obs['publisher'], obs['syndication_key'], run_id,
                                  obs['checked_at'], obs['reason'], 0))
                    weight, why = decisions[key]
                    apply_change(conn, obs, weight, why, run_id, 'addition')
                for obs, weight, why in sorted(adjustments, key=lambda item: item[0]['observation_id']):
                    apply_change(conn, obs, weight, why, run_id, 'correction')
                conn.execute('INSERT INTO runs VALUES(?,?)', (run_id, payload_hash))
            conn.commit()
            output.parent.mkdir(parents=True, exist_ok=True)
            publish_graph(conn, baseline, output)
            export_jsonl(conn, 'pages', ledger.parent / 'sources.jsonl')
            export_jsonl(conn, 'events', ledger.parent / 'contributions.jsonl')
        finally:
            conn.close()
        os.replace(stage, ledger)
    finally:
        stage.unlink(missing_ok=True)
    return {'runId': run_id, 'ledger': str(ledger), 'output': str(output), 'policyVersion': POLICY}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('baseline', 'ledger', 'proposal', 'review', 'output', 'run-id'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    result = run(args.baseline, args.ledger, json.loads(Path(args.proposal).read_text()),
                 json.loads(Path(args.review).read_text()), args.output, args.run_id)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
