import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import unittest

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'research'))
from validate_overlay import validate
spec=importlib.util.spec_from_file_location('publication_fixtures',HERE/'test_research_ledger.py')
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.LedgerTests();self.f.setUp();self.f.apply()
    def tearDown(self):self.f.tearDown()

    def test_valid_negative_delta_preserves_exact_native_graph(self):
        proof=validate(self.f.base,self.f.out)
        self.assertEqual(proof['changedSections'],1)
        self.assertEqual(proof['recommendedSections'],1)

    def test_reject_native_edge_geometry_drift(self):
        with sqlite3.connect(self.f.out) as db:db.execute("UPDATE native_edges SET value='{}'")
        with self.assertRaisesRegex(ValueError,'Immutable'):validate(self.f.base,self.f.out)

    def test_reject_section_quality_or_access_drift(self):
        with sqlite3.connect(self.f.out) as db:
            v=json.loads(db.execute('SELECT value FROM sections').fetchone()[0]);v['quality']=4
            db.execute('UPDATE sections SET value=?',(json.dumps(v),))
        with self.assertRaisesRegex(ValueError,'quality'):validate(self.f.base,self.f.out)

    def test_reject_summary_count_and_graph_mismatch(self):
        with sqlite3.connect(self.f.out) as db:
            v=json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0]);v['graphVersion']='other'
            db.execute("UPDATE metadata SET value=? WHERE key='summary'",(json.dumps(v),))
        with self.assertRaisesRegex(ValueError,'Graph identity'):validate(self.f.base,self.f.out)

    def test_reject_corrupt_recommended_total(self):
        with sqlite3.connect(self.f.out) as db:
            v=json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0]);v['recommendedSections']=22
            db.execute("UPDATE metadata SET value=? WHERE key='summary'",(json.dumps(v),))
        with self.assertRaisesRegex(ValueError,'Recommended count'):validate(self.f.base,self.f.out)


# Failure injection proves that activation never strands the new file on a failed smoke.
import io
import os
import shutil
import tempfile
from unittest.mock import patch
import remote_publish as remote
from validate_overlay import digest


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.LedgerTests();self.f.setUp();self.f.apply()
        self.root=self.f.root/'server'
        self.active=self.root/'.data/uk-current/graph/ratings.sqlite'
        self.active.parent.mkdir(parents=True);shutil.copy2(self.f.base,self.active)
        self.config={'runId':'2026-10-21','sha256':digest(self.f.out),'graphVersion':'abc',
                     'expectedPreviousSha256':digest(self.f.base),'downloadUrl':'https://example.invalid/transfer'}
        self.commands=[]

    def tearDown(self):
        os.environ.pop('ROUTING_SMOKE_TOKEN',None);self.f.tearDown()

    def run_command(self,*args):
        self.commands.append(args)
        if 'inspect' in args:return json.dumps(['ROUTING_API_TOKEN=test-only-fake'])
        return ''

    def ready(self,graph):
        with sqlite3.connect(self.active) as db:
            meta=json.loads(db.execute("SELECT value FROM metadata WHERE key='summary'").fetchone()[0])
        return {'catalogue':{'graph_version':meta['graphVersion'],'recommended_sections':meta['recommendedSections']}}

    def activate(self,fail=False):
        def verify(url):
            if fail:raise RuntimeError('Injected route verification failure')
            return {'status':'verified'}
        with patch.object(remote,'ROOT',self.root),patch.object(remote,'run',side_effect=self.run_command), \
             patch.object(remote,'ready',side_effect=self.ready),patch.object(remote.runpy,'run_path',return_value={'verify':verify}), \
             patch.object(remote.urllib.request,'urlopen',side_effect=lambda *a,**k:io.BytesIO(self.f.out.read_bytes())):
            return remote.install(self.config)

    def test_success_and_retry_keep_original_rollback(self):
        self.assertEqual(self.activate()['status'],'published')
        self.assertEqual(digest(self.active),self.config['sha256'])
        self.assertEqual(self.activate()['status'],'already-published')
        backup=next((self.root/'.data/research-published').glob('*/previous.sqlite'))
        self.assertEqual(digest(backup),self.config['expectedPreviousSha256'])
        self.assertEqual(digest(self.root/'.data/research-published/national-baseline.sqlite'),self.config['expectedPreviousSha256'])

    def test_failed_public_routes_restore_old_overlay_and_restart(self):
        with self.assertRaisesRegex(RuntimeError,'previous ratings restored'):self.activate(fail=True)
        self.assertEqual(digest(self.active),self.config['expectedPreviousSha256'])
        self.assertEqual(sum(c[:2]==('docker','restart') for c in self.commands),2)

    def test_stale_publication_cannot_replace_unknown_remote(self):
        self.config['expectedPreviousSha256']='unknown'
        with self.assertRaisesRegex(ValueError,'stale'):self.activate()
        self.assertEqual(digest(self.active),digest(self.f.base))
        self.assertFalse(self.commands)

    def test_retry_after_interrupted_swap_restarts_and_verifies(self):
        release=self.root/'.data/research-published'
        target=release/(self.config['runId']+'-'+self.config['sha256']);target.mkdir(parents=True)
        os.link(self.active,release/'national-baseline.sqlite');os.link(self.active,target/'previous.sqlite')
        shutil.copy2(self.f.out,target/'ratings.sqlite')
        tmp=self.active.with_suffix('.tmp');os.link(target/'ratings.sqlite',tmp);os.replace(tmp,self.active)
        self.assertEqual(self.activate()['status'],'already-published')
        self.assertTrue(any(c[:2]==('docker','restart') for c in self.commands))

if __name__=='__main__':unittest.main()
