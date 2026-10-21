"""Check the bounded exporter against the unchanged legacy gzip algorithm."""
import contextlib
import gzip
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

GRAPH = Path(__file__).resolve().parents[1] / 'graph'
sys.path.insert(0, str(GRAPH))
from export_sqlite import build, segment_key


class GraphId:
    def __init__(self, value, level=0):
        self.value, self._level = value, level

    def __add__(self, offset):
        return GraphId(self.value+offset, self._level)

    def level(self):
        return self._level

    @classmethod
    def from_tile_path(cls, name):
        return cls(256, int(name.split('/')[0]))


class Reader:
    def __init__(self, config):
        self.fail = False
        self.calls = 0

    def get_edge_shape(self, gid):
        self.calls += 1
        if self.fail:
            raise RuntimeError('Simulated interruption')
        if gid.value in (122, 256):
            return [[0, 51], [.01, 51]]
        if gid.value == 130:
            return [[.01, 51], [0, 51]]
        if gid.value == 257:
            return [[-.01, 51], [0, 51], [.01, 51], [.02, 51]]
        return [[.01, 51], [0, 51]]

    def get_graph_tile_header(self, gid):
        return types.SimpleNamespace(directededgecount=3)


modules = {'valhalla': types.ModuleType('valhalla'),
           'valhalla.baldr': types.ModuleType('valhalla.baldr'),
           'valhalla.baldr.utils': types.ModuleType('valhalla.baldr.utils')}
modules['valhalla.baldr'].GraphId = GraphId
modules['valhalla.baldr.utils'].GraphUtils = Reader
with patch.dict(sys.modules, modules):
    spec = importlib.util.spec_from_file_location('legacy_export', GRAPH / 'export.py')
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'sources.jsonl'
        self.output = self.root / 'ratings.sqlite'
        self.config = {'mjolnir': {'tile_dir': str(self.root), 'tile_extract': str(self.root/'tiles.tar')}}
        (self.root/'way_edges.txt').write_text('7,2,122,2,130,0,256\n')
        source = {'id': 'source-1', 'wayIds': ['7'], 'ref': 'A1', 'geometry': {'coordinates': [[0, 51], [.01, 51]]},
                  'quality': 4, 'rating': 4.1, 'recommendationCount': 1, 'sources': [{'publisher': 'Guide', 'url': 'https://example.com/ride'}]}
        unmapped = {**source, 'id': 'unmapped', 'wayIds': ['999']}
        self.source.write_text('\n'.join(map(json.dumps, (source, unmapped)))+'\n')
        with tarfile.open(self.root/'tiles.tar', 'w') as archive:
            for name in ('0/tile.gph', '2/tile.gph'):
                archive.addfile(tarfile.TarInfo(name), io.BytesIO())
        self.reader = Reader(self.config)

    def tearDown(self):
        self.temp.cleanup()

    def export(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return build(self.source, self.output, self.config, self.reader, GraphId,
                         legacy.project, legacy.length, legacy.encode)

    def test_semantically_identical_to_legacy_export(self):
        config_file = self.root / 'valhalla.json'
        config_file.write_text(json.dumps(self.config))
        zipped = self.root / 'legacy.json.gz'
        with patch.object(sys, 'argv', ['export.py', '--source', str(self.source), '--output', str(zipped), '--config', str(config_file)]), contextlib.redirect_stdout(io.StringIO()):
            legacy.main()
        with gzip.open(zipped, 'rt') as stream:
            expected = json.load(stream)
        summary = self.export()
        with sqlite3.connect(self.output) as db:
            sections = [json.loads(r[0]) for r in db.execute('SELECT value FROM sections ORDER BY id')]
            edges = [json.loads(r[0]) for r in db.execute('SELECT value FROM native_edges ORDER BY id')]
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('SELECT count(*) FROM membership').fetchone()[0], len(sections[0]['physicalIds']))
            self.assertFalse(db.execute("SELECT 1 FROM sqlite_master WHERE name='ways'").fetchone())
        self.assertEqual(sections, expected['sections'])
        self.assertEqual(edges, expected['nativeEdges'])
        self.assertEqual(summary['graphVersion'], expected['graphVersion'])
        self.assertEqual(summary['unmappedSections'], len(expected['unmappedSections']))
        # Known upper native edge256 is excluded, and the real shortcut gets
        # the exact middle third; reverse geometry has the same physical identity.
        self.assertEqual(sections[0]['shortcutRanges'][0][0], '257')
        self.assertAlmostEqual(sections[0]['shortcutRanges'][0][1], 1/3)
        self.assertAlmostEqual(sections[0]['shortcutRanges'][0][2], 2/3)

    def test_checkpoint_republishes_without_rewalking_graph(self):
        self.export()
        before = self.output.read_bytes()
        calls = self.reader.calls
        self.reader.fail = True
        self.export()
        self.assertEqual(self.reader.calls, calls)
        self.assertEqual(self.output.read_bytes(), before)

    def test_changed_source_rejects_stale_checkpoint_and_preserves_output(self):
        self.export()
        before = self.output.read_bytes()
        self.source.write_text(self.source.read_text()+'\n')
        with self.assertRaisesRegex(ValueError, 'different source'):
            self.export()
        self.assertEqual(self.output.read_bytes(), before)

    def test_failed_way_walk_keeps_prior_published_output(self):
        self.output.write_bytes(b'previous published ratings')
        self.reader.fail = True
        with self.assertRaisesRegex(RuntimeError, 'Simulated interruption'):
            self.export()
        self.assertEqual(self.output.read_bytes(), b'previous published ratings')
        self.reader.fail = False
        summary = self.export()
        self.assertEqual(summary['sections'], 1)

    def test_more_than_one_checkpoint_of_sections_finalizes(self):
        source = json.loads(self.source.read_text().splitlines()[0])
        with self.source.open('w') as stream:
            for i in range(1002):
                stream.write(json.dumps({**source, 'id': 'section-' + str(i)})+'\n')
        summary = self.export()
        self.assertEqual(summary['sections'], 1002)

    def test_joined_section_does_not_change_individual_native_edge_geometry(self):
        source = json.loads(self.source.read_text().splitlines()[0])
        source['geometry']['coordinates'].append([.02, 51])
        self.source.write_text(json.dumps(source)+'\n')
        (self.root/'way_edges.txt').write_text('7,2,122,2,130,2,138,0,256\n')
        original_reader = self.reader.get_edge_shape
        self.reader.get_edge_shape = lambda gid: [[.01, 51], [.02, 51]] if gid.value == 138 else original_reader(gid)
        self.export()
        with sqlite3.connect(self.output) as db:
            section = json.loads(db.execute('SELECT value FROM sections').fetchone()[0])
            edges = [json.loads(row[0]) for row in db.execute('SELECT value FROM native_edges')]
        self.assertEqual(section['shape'], legacy.encode([[0, 51], [.01, 51], [.02, 51]]))
        self.assertEqual(len(section['physicalIds']), 2)
        first = next(edge for edge in edges if '122' in edge[2])
        self.assertEqual(first[1], legacy.encode([[0, 51], [.01, 51]]))

    def test_far_source_geometry_cannot_attach_ratings_to_same_way(self):
        source = json.loads(self.source.read_text().splitlines()[0])
        source['geometry']['coordinates'] = [[0, 50.9], [.01, 50.9]]
        self.source.write_text(json.dumps(source)+'\n')
        summary = self.export()
        self.assertEqual(summary['sections'], 0)
        self.assertEqual(summary['nativeEdges'], 0)
        self.assertEqual(summary['unmappedSections'], 1)

    def test_segment_identity_is_exact_direction_independent_polyline6(self):
        self.assertEqual(segment_key([-.0, 51], [.01, 51]), segment_key([.01, 51], [0, 51]))
        self.assertNotEqual(segment_key([0, 51], [.01, 51]), segment_key([0, 51], [.010001, 51]))

if __name__ == '__main__':
    unittest.main()
