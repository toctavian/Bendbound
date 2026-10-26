import argparse
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'research'))
import selection
import run_daily as runner
import publish_reviewed as publisher
spec=importlib.util.spec_from_file_location('selection_fixtures',HERE/'test_research_ledger.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class SelectionTests(unittest.TestCase):
    def setUp(self):self.f=f.LedgerTests();self.f.setUp()
    def tearDown(self):self.f.tearDown()

    def inputs(self):
        proposal,review=self.f.inputs()
        proposal['pages'].append({**proposal['pages'][0],'url':'https://example.com/uncertain',
            'roads':[{**proposal['pages'][0]['roads'][0],'sectionId':'not-a-native-section','fullSectionScope':False}]})
        review.pop('approved');review['integrity']={**{k:True for k in selection.FLAGS},'issues':[]}
        review['reviewedProposalSha256']=selection.fingerprint(proposal)
        review['decisions'][0]['disposition']='supported'
        review['decisions'].append({'url':'https://example.com/uncertain','sectionId':'not-a-native-section',
            'weight':0,'disposition':'quarantined','reason':'Unknown provenance and road scope'})
        context={'runId':'run1','baselineSha256':review['reviewedBaselineSha256'],
                 'ledgerSha256':review['reviewedLedgerSha256']}
        return proposal,review,context

    def test_uncertain_invalid_mapping_cannot_block_supported_items(self):
        p,r,c=self.inputs();original=copy.deepcopy(r)
        app,auth,report=selection.select(p,r,c)
        f.ledger.run(self.f.base,self.f.db,app,auth,self.f.out,'run1')
        self.assertEqual(len(app['pages']),1);self.assertEqual(len(report['quarantined']),1)
        self.assertEqual(r,original)
        self.assertEqual(auth['sourceReviewSha256'],selection.fingerprint(original))
        self.assertEqual(len(self.f.events()),2)  # imported snapshot + one supported addition

    def test_global_accounting_failure_holds_every_item(self):
        p,r,c=self.inputs();r['integrity']['accountingPassed']=False
        with self.assertRaisesRegex(ValueError,'integrity'):selection.select(p,r,c)
        self.assertFalse(self.f.db.exists())

    def test_incomplete_coverage_or_input_tampering_never_authorizes_subset(self):
        p,r,c=self.inputs();r['decisions'].pop()
        with self.assertRaisesRegex(ValueError,'every observation'):selection.select(p,r,c)
        p,r,c=self.inputs();p['pages'][0]['roads'][0]['reason']='changed after review'
        with self.assertRaisesRegex(ValueError,'binding'):selection.select(p,r,c)

    def test_status_weight_disagreement_fails_closed(self):
        p,r,c=self.inputs();r['decisions'][1]['weight']=1
        with self.assertRaisesRegex(ValueError,'disposition'):selection.select(p,r,c)

    def test_supported_old_credit_removal_applies_with_new_claim_quarantined(self):
        self.f.apply();oid=self.f.events()[-1]['observation_id']
        p,r=self.f.inputs(suffix='next',weight=0)
        r.pop('approved');r['integrity']={**{k:True for k in selection.FLAGS},'issues':[]}
        r['decisions'][0]['disposition']='quarantined'
        r['adjustments']=[{'observationId':oid,'weight':0,'disposition':'supported','reason':'Source does not cover this native stretch'}]
        c={'runId':'run2','baselineSha256':r['reviewedBaselineSha256'],'ledgerSha256':r['reviewedLedgerSha256']}
        app,auth,report=selection.select(p,r,c)
        f.ledger.run(self.f.base,self.f.db,app,auth,self.f.out,'run2')
        self.assertEqual(app['pages'],[]);self.assertEqual(self.f.output_section()['rating'],5)
        self.assertEqual(self.f.events()[-1]['kind'],'correction');self.assertGreater(self.f.events()[-1]['delta'],0)

    def test_legacy_hold_requires_explicit_hash_bound_adoption(self):
        p,r,c=self.inputs();r.pop('integrity');r['approved']=False
        with self.assertRaisesRegex(ValueError,'specific'):selection.select(p,r,c)
        a={'policyId':selection.rules()['policyId'],'sourceReviewSha256':selection.fingerprint(r),
           'runId':'run1','integrity':{**{k:True for k in selection.FLAGS},'issues':[]}}
        app,auth,report=selection.select(p,r,c,a)
        self.assertEqual(len(app['pages']),1);self.assertFalse(r['approved'])
        self.assertTrue(report['legacyPolicyAdoption'])
        a['sourceReviewSha256']='wrong'
        with self.assertRaises(ValueError):selection.select(p,r,c,a)

    def test_runner_uses_one_review_and_publisher_rejects_tampered_subset(self):
        state=self.f.root/'state';args=argparse.Namespace(state=str(state),baseline=str(self.f.base),codex='fake',dry_run=False,agent_timeout=30)
        def agent(*call):
            p,r,c=self.inputs();ctx=json.loads(call[3].read_text())
            r.update(reviewedBaselineSha256=ctx['baselineSha256'],reviewedLedgerSha256=ctx['ledgerSha256'],reviewedProposalSha256=selection.fingerprint(p))
            value=p if call[5]=='proposal.json' else r
            runner.dump(call[4]/call[5],value);return value
        with patch.object(runner,'call_agent',side_effect=agent) as calls:
            self.assertEqual(runner.run(args),0);self.assertEqual(calls.call_count,2)
            self.assertEqual(runner.run(args),0);self.assertEqual(calls.call_count,2)
        run=next((state/'runs').iterdir());auth=json.loads((run/'application-authorization.json').read_text())
        auth['decisions'][0]['weight']=.5;runner.dump(run/'application-authorization.json',auth)
        with patch.object(publisher,'AwsMcp',side_effect=AssertionError('Must not contact AWS')):
            with self.assertRaisesRegex(ValueError,'Derived application'):publisher.publish(state)

    def test_all_quarantined_means_no_invented_scores(self):
        p,r,c=self.inputs()
        for d in r['decisions']:d.update(weight=0,disposition='quarantined')
        app,auth,report=selection.select(p,r,c)
        f.ledger.run(self.f.base,self.f.db,app,auth,self.f.out,'run1')
        self.assertEqual(app['pages'],[]);self.assertEqual(len(self.f.events()),1)
        self.assertEqual(self.f.output_section()['rating'],5)

    def test_same_served_hash_verifies_without_upload_or_restart(self):
        state=self.f.root/'state';args=argparse.Namespace(state=str(state),baseline=str(self.f.base),codex='fake',dry_run=False,agent_timeout=30)
        def agent(*call):
            p,r,c=self.inputs();ctx=json.loads(call[3].read_text())
            r.update(reviewedBaselineSha256=ctx['baselineSha256'],reviewedLedgerSha256=ctx['ledgerSha256'],reviewedProposalSha256=selection.fingerprint(p))
            value=p if call[5]=='proposal.json' else r
            runner.dump(call[4]/call[5],value);return value
        with patch.object(runner,'call_agent',side_effect=agent):self.assertEqual(runner.run(args),0)
        latest=json.loads((state/'latest-reviewed.json').read_text())
        runner.dump(state/'remote-published.json',{'runId':latest['runId'],'sha256':latest['sha256']})
        class Client:
            def script(self,code):return {'account':'843872332156'}
            def signed(self,*args):raise AssertionError('Unchanged DB must not transfer')
            def close(self):pass
        def remote_check(client,commands,*args):
            self.assertNotIn('docker',commands[0]);self.assertNotIn('curl',commands[0])
            return {'status':'already-published','sha256':latest['sha256']}
        with patch.object(publisher,'AwsMcp',return_value=Client()),patch.object(publisher,'ssm',side_effect=remote_check):
            self.assertEqual(publisher.publish(state),0)
        self.assertEqual(json.loads((state/'remote-published.json').read_text())['status'],'already-published')

if __name__=='__main__':unittest.main()
