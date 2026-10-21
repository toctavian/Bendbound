import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('research_ledger', Path(__file__).resolve().parents[1] / 'research/ledger.py')
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.base, self.db, self.out = [self.root / name for name in ('base.sqlite', 'ledger.sqlite', 'new.sqlite')]
        self.section = {'id': 's1', 'ref': 'A272', 'quality': 5., 'rating': 5., 'recommendationCount': 0,
                        'frequencyRating': None, 'sources': [], 'graphVersion': 'abc', 'physicalIds': ['native-1'],
                        'edgeIds': ['7'], 'geometry': {'type': 'LineString', 'coordinates': [[-.9, 51.], [-.8, 51.01]]}}
        with sqlite3.connect(self.base) as conn:
            conn.executescript('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE sections(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE native_edges(id TEXT,value TEXT); CREATE TABLE membership(physical TEXT,section TEXT); CREATE VIRTUAL TABLE bounds USING rtree(id,minx,maxx,miny,maxy);')
            conn.execute('INSERT INTO metadata VALUES(?,?)', ('summary', json.dumps({'schemaVersion': 3, 'graphVersion': 'abc', 'sections': 1, 'recommendedSections': 0})))
            conn.execute('INSERT INTO sections VALUES(?,?)', ('s1', json.dumps(self.section)))
            conn.execute('INSERT INTO native_edges VALUES(?,?)', ('native-1', '{"shape":"unchanged"}'))
            conn.execute('INSERT INTO membership VALUES(?,?)', ('native-1', 's1'))
            conn.execute('INSERT INTO bounds VALUES(?,?,?,?,?)', (1, -.9, -.8, 51, 51.01))
        self.baseline_hash = ledger.digest_file(self.base)

    def tearDown(self):
        self.temp.cleanup()

    def inputs(self, suffix='one', publisher='magazine', work=None, weight=1.):
        url = 'https://example.com/' + suffix
        proposal = {'pages': [{'url': url, 'title': 'A named ride', 'publisher': publisher,
                              'syndicationKey': work or suffix, 'checkedAt': '2026-10-20', 'notes': 'Named endpoints verified',
                              'roads': [{'sectionId': 's1', 'roadRef': 'A272', 'fullSectionScope': True,
                                         'scopeBbox': [-1., 50.9, -.7, 51.1], 'reason': 'Entire section between the stated endpoints'}]}]}
        review = {'reviewedBaselineSha256': ledger.digest_file(self.base),
                  'reviewedProposalSha256': self.proposal_hash(proposal), 'approved': True, 'reviewedLedgerSha256': ledger.digest_file(self.db) if self.db.exists() else 'absent',
                  'decisions': [{'url': url, 'sectionId': 's1', 'weight': weight, 'reason': 'Independent specific route evidence'}]}
        return proposal, review

    def proposal_hash(self, proposal):
        return ledger.hashlib.sha256(json.dumps(proposal, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()

    def bind(self, proposal, review):
        review['reviewedBaselineSha256'] = ledger.digest_file(self.base)
        review['reviewedProposalSha256'] = self.proposal_hash(proposal)
        return review

    def apply(self, run_id='run1', **kwargs):
        p, r = self.inputs(**kwargs)
        ledger.run(self.base, self.db, p, r, self.out, run_id)
        return p, r

    def events(self):
        with ledger.open_readonly(self.db) as conn:
            return [dict(row) for row in conn.execute('SELECT * FROM events ORDER BY id')]

    def output_section(self):
        with sqlite3.connect(self.out) as conn:
            return json.loads(conn.execute('SELECT value FROM sections').fetchone()[0])

    def test_retry_is_idempotent_and_baseline_untouched(self):
        p, r = self.apply()
        old_events = self.events()
        ledger.run(self.base, self.db, p, r, self.out, 'run1')
        self.assertEqual(old_events, self.events())
        self.assertEqual(ledger.digest_file(self.base), self.baseline_hash)
        self.assertEqual(self.events()[0]['kind'], 'baseline-snapshot')
        self.assertIsNone(self.events()[0]['delta'])
        self.assertTrue((self.root / 'sources.jsonl').exists())
        self.assertTrue((self.root / 'contributions.jsonl').exists())

    def test_same_publisher_and_syndication_caps(self):
        self.apply()
        first = self.output_section()['rating']
        self.apply(run_id='run2', suffix='two')
        self.assertEqual(self.output_section()['recommendationCount'], 1)
        self.assertEqual(self.output_section()['rating'], first)
        self.assertEqual(self.events()[-1]['delta'], 0)
        self.apply(run_id='run3', suffix='three', publisher='other', work='one')
        self.assertEqual(self.output_section()['recommendationCount'], 1)
        self.assertEqual(self.events()[-1]['delta'], 0)

    def test_negative_delta_and_append_only_correction(self):
        self.apply()
        first = self.events()[-1]
        self.assertLess(first['delta'], 0)
        self.assertAlmostEqual(first['delta'], ledger.rating(5, 1) - 5)
        p, r = self.inputs(suffix='two', weight=0)
        r['adjustments'] = [{'observationId': first['observation_id'], 'weight': 0, 'reason': 'Found syndicated attribution error'}]
        ledger.run(self.base, self.db, p, r, self.out, 'run2')
        self.assertEqual(first, self.events()[1])
        self.assertEqual(self.events()[-1]['kind'], 'correction')
        self.assertAlmostEqual(self.events()[-1]['delta'], -first['delta'])
        self.assertEqual(self.output_section()['rating'], 5)

    def test_independent_fractional_evidence_and_topology(self):
        self.apply(weight=.5)
        self.apply(run_id='run2', suffix='two', publisher='independent', weight=.5)
        section = self.output_section()
        self.assertEqual(section['recommendationCount'], 2)
        self.assertEqual(section['weightedEvidenceCount'], 1)
        for field in ('geometry', 'physicalIds', 'edgeIds', 'graphVersion', 'quality', 'ref', 'id'):
            self.assertEqual(section[field], self.section[field])
        with sqlite3.connect(self.base) as a, sqlite3.connect(self.out) as b:
            for table in ('native_edges', 'membership', 'bounds'):
                self.assertEqual(a.execute('SELECT * FROM ' + table).fetchall(), b.execute('SELECT * FROM ' + table).fetchall())
            self.assertEqual(json.loads(b.execute('SELECT value FROM metadata').fetchone()[0])['graphVersion'], 'abc')

    def test_invalid_inputs_leave_no_writes(self):
        cases = []
        for mutate in (
            lambda p, r: r.update(approved=False),
            lambda p, r: r.update(reviewedLedgerSha256='wrong'),
            lambda p, r: r.update(decisions=[]),
            lambda p, r: p['pages'][0]['roads'][0].update(roadRef='A1'),
            lambda p, r: p['pages'][0]['roads'][0].update(fullSectionScope=False),
            lambda p, r: p['pages'][0]['roads'][0].update(scopeBbox=[-.85, 50.9, -.7, 51.1]),
            lambda p, r: r['decisions'][0].update(weight=float('nan')),
            lambda p, r: p['pages'][0].update(contentHash='fake'),
        ):
            p, r = self.inputs()
            mutate(p, r)
            self.bind(p, r)
            cases.append((p, r))
        for p, r in cases:
            with self.assertRaises(ValueError):
                ledger.run(self.base, self.db, p, r, self.out, 'bad')
            self.assertFalse(self.db.exists())
            self.assertFalse(self.out.exists())
            self.assertFalse((self.root / 'sources.jsonl').exists())
        self.apply()
        old = {p: p.read_bytes() for p in (self.db, self.out, self.root / 'sources.jsonl', self.root / 'contributions.jsonl')}
        p, r = self.inputs(suffix='one')
        with self.assertRaises(ValueError):
            ledger.run(self.base, self.db, p, r, self.out, 'duplicate-page')
        for p, contents in old.items():
            self.assertEqual(p.read_bytes(), contents)

    def test_compact_native_shapes_and_empty_reviewed_batch(self):
        compact = dict(self.section)
        coordinates = compact.pop('geometry')['coordinates']
        compact.pop('edgeIds')
        previous, encoded = [0, 0], ''
        for lon, lat in coordinates:
            values = [round(lat * 1e6), round(lon * 1e6)]
            for i, current in enumerate(values):
                delta = current - previous[i]
                previous[i] = current
                value = ~(delta << 1) if delta < 0 else delta << 1
                while value >= 32:
                    encoded += chr((32 | (value & 31)) + 63)
                    value >>= 5
                encoded += chr(value + 63)
        compact.update(shape=encoded, bbox=[-.9, 51., -.8, 51.01])
        with sqlite3.connect(self.base) as conn:
            conn.execute('UPDATE sections SET value=?', (json.dumps(compact),))
        self.apply()
        actual = self.output_section()
        self.assertEqual(actual['shape'], encoded)
        self.assertEqual(actual['bbox'], compact['bbox'])
        prior = self.events()[-1]
        p = {'pages': []}
        r = {'approved': True, 'reviewedLedgerSha256': ledger.digest_file(self.db), 'decisions': [],
             'adjustments': [{'observationId': prior['observation_id'], 'weight': 0, 'reason': 'Reviewed correction with no new pages'}]}
        self.bind(p, r)
        ledger.run(self.base, self.db, p, r, self.out, 'correction-only')
        self.assertEqual(self.events()[-1]['kind'], 'correction')
        self.assertEqual(self.output_section()['rating'], 5)
        r = {'approved': True, 'reviewedLedgerSha256': ledger.digest_file(self.db), 'decisions': []}
        self.bind({'pages': []}, r)
        ledger.run(self.base, self.db, {'pages': []}, r, self.out, 'empty-day')
        self.assertEqual(self.output_section()['shape'], encoded)
        with sqlite3.connect(self.db) as conn:
            indexes = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        self.assertTrue({'events_observation', 'observations_section'} <= indexes)

    def test_historical_baseline_and_immutable_contribution_rows(self):
        historical = dict(self.section, recommendationCount=1, rating=ledger.rating(5, 1),
                          sources=[{'id': 'old-guide', 'publisher': 'Historic Magazine', 'url': 'https://historic.example/ride'}])
        with sqlite3.connect(self.base) as conn:
            conn.execute('UPDATE sections SET value=?', (json.dumps(historical),))
        self.apply()
        snapshots = [e for e in self.events() if e['run_id'] == 'baseline']
        self.assertEqual(len(snapshots), 2)
        self.assertTrue(all(e['delta'] is None for e in snapshots))
        self.assertEqual(self.output_section()['recommendationCount'], 2)
        with sqlite3.connect(self.db) as conn:
            for statement in ('UPDATE events SET delta=99', 'DELETE FROM events', 'DELETE FROM observations'):
                with self.assertRaises(sqlite3.IntegrityError):
                    conn.execute(statement)

    def test_review_snapshot_binding_and_retrieval_metadata(self):
        p, r = self.inputs()
        p['pages'][0]['notes'] = 'Edited after review'
        with self.assertRaisesRegex(ValueError, 'Proposal changed'):
            ledger.run(self.base, self.db, p, r, self.out, 'drift')
        self.assertFalse(self.db.exists())
        p, r = self.inputs()
        with sqlite3.connect(self.base) as conn:
            conn.execute('UPDATE native_edges SET value=?', ('changed native graph',))
        with self.assertRaisesRegex(ValueError, 'baseline snapshot'):
            ledger.run(self.base, self.db, p, r, self.out, 'drift')
        self.assertFalse(self.db.exists())
        p, r = self.inputs()
        p['pages'][0].update(contentHash='a' * 64, retrievalMethod='direct-http')
        self.bind(p, r)
        ledger.run(self.base, self.db, p, r, self.out, 'metadata')
        page = json.loads((self.root / 'sources.jsonl').read_text().splitlines()[0])
        self.assertEqual(page['content_hash'], 'a' * 64)
        self.assertEqual(page['retrieval_method'], 'direct-http')

    def test_url_aliases_and_edited_retry_rejected(self):
        p, r = self.apply()
        r['decisions'][0]['weight'] = .5
        with self.assertRaises(ValueError):
            ledger.run(self.base, self.db, p, r, self.out, 'run1')
        self.assertEqual(ledger.canonical_url('https://EXAMPLE.com/one/?utm_source=copy#fragment'), 'https://example.com/one')

    def test_all_observations_reviewed_and_correction_target_known(self):
        p, r = self.inputs()
        r['adjustments'] = [{'observationId': 'invented', 'weight': 0, 'reason': 'Invalid target'}]
        with self.assertRaises(ValueError):
            ledger.run(self.base, self.db, p, r, self.out, 'bad')
        self.assertFalse(self.db.exists())


if __name__ == '__main__':
    unittest.main()
