"""Security boundaries for the unattended publisher's separate AWS identity."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'research'))
from aws_mcp import AwsMcp
from identity.document import document, parameters, DOCUMENT, GRAPH, BUCKET
from identity.enroll import permission_policy
import publish_reviewed


class MachineIdentityTests(unittest.TestCase):
    def test_machine_recovery_never_opens_browser_or_escalates(self):
        with patch.dict(os.environ,{'BENDBOUND_RESEARCH_AWS_PROFILE':'bendbound-research'}):
            c=AwsMcp()
            with patch('aws_mcp.subprocess.run') as browser,contextlib.redirect_stdout(io.StringIO()):
                c.renew_login()
            browser.assert_not_called()
            self.assertEqual(c.profile,'bendbound-research')

    def test_manual_recovery_keeps_verified_london_flow(self):
        with patch.dict(os.environ,{'BENDBOUND_RESEARCH_AWS_PROFILE':'bendbound'}):
            c=AwsMcp()
            with patch('aws_mcp.subprocess.run',return_value=MagicMock(returncode=0)) as browser,contextlib.redirect_stdout(io.StringIO()):
                c.renew_login()
            self.assertEqual(browser.call_args.args[0],['aws','login','--profile','bendbound','--region','eu-west-2'])

    def test_machine_cannot_send_arbitrary_shell_commands(self):
        with tempfile.TemporaryDirectory() as td,patch.dict(os.environ,{'BENDBOUND_RESEARCH_AWS_PROFILE':'bendbound-research'}):
            c=MagicMock()
            with self.assertRaisesRegex(ValueError,'fixed SSM'):
                publish_reviewed.ssm(c,['arbitrary command'],Path(td),'2026-10-22','a'*64)
            c.script.assert_not_called()

    def test_machine_sends_only_base64_data_to_fixed_document(self):
        with tempfile.TemporaryDirectory() as td,patch.dict(os.environ,{'BENDBOUND_RESEARCH_AWS_PROFILE':'bendbound-research'}):
            c=MagicMock();c.script.return_value={'commandId':'test-command'}
            config={'mode':'verify','sha256':'a'*64,'graphVersion':GRAPH}
            with patch.object(publish_reviewed,'poll_ssm',return_value={'status':'already-published'}):
                publish_reviewed.ssm(c,['ignored-shell'],Path(td),'2026-10-22','a'*64,config)
            sent=c.script.call_args.args[0]
            self.assertIn(DOCUMENT,sent);self.assertNotIn('ignored-shell',sent)
            payload=parameters(config)['Payload'][0]
            self.assertEqual(json.loads(base64.b64decode(payload)),config)

    def test_role_cannot_call_generic_shell_document_or_modify_iam(self):
        p=permission_policy()
        ss=[x for x in p['Statement'] if x['Action']=='ssm:SendCommand'][0]
        self.assertEqual(len(ss['Resource']),2)
        self.assertTrue(any(x.endswith(':document/'+DOCUMENT) for x in ss['Resource']))
        self.assertFalse(any('AWS-RunShellScript' in x or x=='*' for x in ss['Resource']))
        self.assertNotIn('iam:',json.dumps(p));self.assertNotIn('secretsmanager:',json.dumps(p))
        s3=p['Statement'][0]
        self.assertEqual(s3['Resource'],f'arn:aws:s3:::{BUCKET}/route-research/*')

    def test_document_pins_graph_url_and_rejects_untrusted_payload(self):
        doc=document();step=doc['mainSteps'][0]['inputs']['runCommand'][0]
        self.assertEqual(doc['parameters']['Payload']['allowedPattern'],'^[A-Za-z0-9+/=]+$')
        self.assertIn(GRAPH,step);self.assertIn(BUCKET,step)
        # Run only its input-validation wrapper, replacing install/ready with stubs.
        wrapper=step[step.index('import base64,re,urllib.parse'):].removesuffix('\nBEND_RESEARCH_PY')
        base={'mode':'publish','runId':'2026-10-22','sha256':'a'*64,'graphVersion':GRAPH,'expectedPreviousSha256':'b'*64,
              'downloadUrl':f'https://{BUCKET}.s3.eu-west-2.amazonaws.com/route-research/2026-10-22/'+('a'*64)+'/ratings.sqlite?signature=test'}
        for change in [{'runId':'../../etc'},{'graphVersion':'other'},{'downloadUrl':'http://169.254.169.254/latest/meta-data/'},
                       {'downloadUrl':'https://example.com/ratings.sqlite'},{'sha256':'bad'},{'command':'arbitrary'}]:
            cfg={**base,**change};payload=parameters(cfg)['Payload'][0]
            install=MagicMock(return_value={})
            with self.assertRaises((ValueError,KeyError)):
                exec(wrapper.replace('{{ Payload }}',payload),{'json':json,'install':install})
            install.assert_not_called()
        install=MagicMock(return_value={'status':'published'})
        with contextlib.redirect_stdout(io.StringIO()):
            exec(wrapper.replace('{{ Payload }}',parameters(base)['Payload'][0]),{'json':json,'install':install})
        install.assert_called_once_with(base)
