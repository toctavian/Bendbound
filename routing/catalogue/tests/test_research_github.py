import gzip
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch
import argparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'research'))
import sync_github as sync

spec = importlib.util.spec_from_file_location('github_fixtures', HERE / 'test_research_ledger.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class GithubTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.LedgerTests()
        self.f.setUp()
        self.f.apply()
        self.state = self.f.root / 'state'
        self.run = self.state / 'runs/2026-10-25'
        self.run.mkdir(parents=True)
        artifact = self.run / 'ratings.sqlite'
        shutil.copyfile(self.f.out, artifact)
        self.latest = {'runId': '2026-10-25', 'artifact': str(artifact),
                       'sha256': sync.digest(artifact), 'deployment': 'published'}
        self.receipt = {'runId': '2026-10-25', 'status': 'published', 'sha256': self.latest['sha256'],
                        'graphVersion': 'abc', 'publishedAt': '2026-10-25T06:00:00Z'}
        self.save()
        self.destination = self.f.root / 'export'

    def save(self):
        (self.state / 'latest-reviewed.json').write_text(json.dumps(self.latest))
        (self.state / 'remote-published.json').write_text(json.dumps(self.receipt))
        (self.run / 'publication.json').write_text(json.dumps(self.receipt))
        (self.run / 'status.json').write_text(json.dumps({'status': 'complete'}))

    def tearDown(self):
        self.f.tearDown()

    def test_export_is_complete_deterministic_and_excludes_geometry(self):
        manifest = sync.export(self.state, self.destination)
        snapshot = self.destination / 'ratings.jsonl.gz'
        rows = [json.loads(line) for line in gzip.open(snapshot, 'rt')]
        self.assertEqual(len(rows), manifest['sections'])
        self.assertEqual(rows[0]['rating'], self.f.output_section()['rating'])
        self.assertNotIn('geometry', rows[0])
        self.assertNotIn('artifact', manifest)
        self.assertEqual(sync.export(self.state, self.destination), manifest)

    def test_unpublished_or_modified_artifact_cannot_export(self):
        self.latest['deployment'] = 'blocked'
        self.save()
        with self.assertRaises(ValueError):
            sync.export(self.state, self.destination)
        self.latest['deployment'] = 'published'
        self.save()
        with (self.run / 'ratings.sqlite').open('ab') as stream:
            stream.write(b'drift')
        with self.assertRaises(ValueError):
            sync.export(self.state, self.destination)

    def test_real_git_push_retry_and_no_app_worktree_changes(self):
        remote = self.f.root / 'remote.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(remote)], check=True)
        first = sync.sync(self.state, str(remote))
        second = sync.sync(self.state, str(remote))
        self.assertEqual(first['commit'], second['commit'])
        result = subprocess.check_output(['git', '--git-dir=' + str(remote), 'ls-tree', '--name-only',
                                          'refs/heads/ratings-data'], text=True)
        self.assertEqual(set(result.splitlines()), {'README.md', 'latest.json', 'ratings.jsonl.gz'})

    def test_daily_hook_runs_only_after_successful_aws_publication(self):
        import run_daily
        args = argparse.Namespace(publish=True)
        with patch.object(run_daily.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)) as call:
            self.assertEqual(run_daily.publish_if_requested(args, self.state), 1)
            self.assertEqual(call.call_count, 1)
        with patch.object(run_daily.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 0),
                                                                 subprocess.CompletedProcess([], 1)]) as call:
            self.assertEqual(run_daily.publish_if_requested(args, self.state), 1)
            self.assertTrue(call.call_args_list[0].args[0][1].endswith('publish_reviewed.py'))
            self.assertTrue(call.call_args_list[1].args[0][1].endswith('sync_github.py'))


if __name__ == '__main__':
    unittest.main()
