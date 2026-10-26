import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('daily_runner', HERE.parent / 'research/run_daily.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
spec = importlib.util.spec_from_file_location('ledger_fixtures', HERE / 'test_research_ledger.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LedgerTests()
        self.fixture.setUp()
        self.state = self.fixture.root / 'state'
        self.args = argparse.Namespace(state=str(self.state), baseline=str(self.fixture.base),
                                       codex='fake-codex', dry_run=False, agent_timeout=30)

    def tearDown(self):
        self.fixture.tearDown()

    def agent(self, codex, prompt, schema, context_path, run_dir, output_name, timeout):
        proposal, review = self.fixture.inputs()
        if output_name == 'proposal.json':
            result = proposal
        else:
            context = json.loads(context_path.read_text())
            review.update(reviewedLedgerSha256=context['ledgerSha256'],
                          reviewedBaselineSha256=context['baselineSha256'],
                          reviewedProposalSha256=context['proposalSha256'])
            result = review
        runner.dump(run_dir / output_name, result)
        return result

    def test_two_agents_then_idempotent_retry_and_post_commit_recovery(self):
        with patch.object(runner, 'call_agent', side_effect=self.agent) as calls:
            self.assertEqual(runner.run(self.args), 0)
            self.assertEqual(calls.call_count, 2)
            self.assertEqual(runner.run(self.args), 0)
            self.assertEqual(calls.call_count, 2)
        status = next((self.state / 'runs').glob('*/status.json'))
        self.assertEqual(json.loads(status.read_text())['deployment'], 'pending')
        before = (self.state / 'contributions.jsonl').read_bytes()
        status.unlink()  # Simulate a crash after ledger commit, before final status/pointer.
        (self.state / 'latest-reviewed.json').unlink()
        with patch.object(runner, 'call_agent', side_effect=AssertionError('Must not start new agents')):
            self.assertEqual(runner.run(self.args), 0)
        self.assertEqual(before, (self.state / 'contributions.jsonl').read_bytes())
        self.assertTrue((self.state / 'latest-reviewed.json').exists())

    def test_dry_run_after_completed_batch_never_publishes(self):
        with patch.object(runner, 'call_agent', side_effect=self.agent):
            self.assertEqual(runner.run(self.args), 0)
        self.args.dry_run = True
        self.args.publish = True
        with patch.object(runner, 'publish_if_requested', side_effect=AssertionError('Dry run must not publish')):
            self.assertEqual(runner.run(self.args), 0)

    def test_unmapped_source_is_registered_without_inventing_an_observation(self):
        run=self.state/'runs'/'fixture';run.mkdir(parents=True)
        proposal,_=self.fixture.inputs()
        empty={**proposal['pages'][0], 'url':'https://example.com/unresolved','roads':[]}
        proposal['pages'].append(empty)
        actual=runner.prepare_proposal(proposal,self.state,run,'fixture')
        self.assertEqual(len(actual['pages']),1)
        self.assertEqual(len((self.state/'processed-pages.jsonl').read_text().splitlines()),2)
        self.assertEqual(json.loads((run/'unmapped-pages.json').read_text())[0]['roads'],[])
        runner.prepare_proposal(proposal,self.state,run,'fixture')
        self.assertEqual(len((self.state/'processed-pages.jsonl').read_text().splitlines()),2)

    def test_reviewer_still_runs_when_research_fails(self):
        def agent(*args):
            if args[5] == 'proposal.json':
                raise subprocess.CalledProcessError(1, ['fake-codex'])
            result = {'approved': False, 'summary': 'Research failed; retain current ratings.'}
            runner.dump(args[4] / args[5], result)
            return result
        with patch.object(runner, 'call_agent', side_effect=agent) as calls:
            self.assertEqual(runner.run(self.args), 0)
            self.assertEqual(calls.call_count, 2)
        self.assertFalse((self.state / 'ledger.sqlite').exists())

    def test_missing_national_baseline_calls_no_agents(self):
        self.args.baseline = str(self.fixture.root / 'absent.sqlite')
        with patch.object(runner, 'call_agent', side_effect=AssertionError('No valid baseline')):
            self.assertEqual(runner.run(self.args), 1)
        status = json.loads(next((self.state / 'runs').glob('*/status.json')).read_text())
        self.assertEqual(status['status'], 'blocked')

if __name__ == '__main__':
    unittest.main()
