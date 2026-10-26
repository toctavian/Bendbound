#!/usr/bin/env python3
"""Publish only an approved, immutable, graph-matched local ratings artifact via AWS MCP."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import shlex
import time
import urllib.request

from identity.document import DOCUMENT, parameters
from aws_mcp import AwsMcp
from validate_overlay import digest, validate
from run_daily import dump, proposal_sha
from selection import prepare as prepare_application

ROOT=Path(__file__).resolve().parents[3]
INSTANCE='i-0c392dc16f7c9d857'
BUCKET='bendbound-group-artifacts-843872332156-eu-west-2'


class PublicationFailed(RuntimeError):
    pass


def ssm(client,commands,state,day,artifact_sha,publication_config=None):
    params={'InstanceIds':[INSTANCE],'DocumentName':'AWS-RunShellScript',
            'Parameters':{'commands':commands,'executionTimeout':['900']},
            'Comment':'Publish independently reviewed daily road ratings with rollback'}
    if os.environ.get('BENDBOUND_RESEARCH_AWS_PROFILE') == 'bendbound-research':
        if publication_config is None:
            raise ValueError('Machine publication requires the fixed SSM document')
        params['DocumentName']=DOCUMENT
        params['Parameters']=parameters(publication_config)
    sent=client.script("r=await call_boto3(service_name='ssm',operation_name='SendCommand',region_name='eu-west-2',params="+repr(params)+")\nresult={'commandId':r['Command']['CommandId']}\nresult")
    ident=sent['commandId']
    dump(state/'publication-attempt.json',{'commandId':ident,'runId':day,'sha256':artifact_sha})
    try:
        return poll_ssm(client,ident)
    except PublicationFailed:
        (state/'publication-attempt.json').unlink(missing_ok=True)
        raise


def poll_ssm(client,ident):
    for _ in range(180):
        time.sleep(5)
        result=client.script("r=await call_boto3(service_name='ssm',operation_name='GetCommandInvocation',region_name='eu-west-2',params="+repr({'CommandId':ident,'InstanceId':INSTANCE})+")\nresult={'status':r['Status'],'stdout':r.get('StandardOutputContent',''),'stderr':r.get('StandardErrorContent','')}\nresult")
        if result['status'] in {'Pending','InProgress','Delayed'}:continue
        if result['status']!='Success':
            raise PublicationFailed('Remote publication failed; SSM '+ident+'; inspect sanitized remote result before retrying')
        data=json.loads(result['stdout'].strip().splitlines()[-1])
        data['ssmCommandId']=ident
        return data
    raise RuntimeError('Publication still running; inspect SSM '+ident+' before retrying')


def record(state,day,result,changed=None):
    result.update(publishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),runId=day)
    if changed is not None:result['changedSections']=changed
    run=state/'runs'/day
    dump(run/'publication.json',result);dump(state/'remote-published.json',result)
    status=json.loads((run/'status.json').read_text())
    status.update(deployment='published',publication=result);dump(run/'status.json',status)
    latest=json.loads((state/'latest-reviewed.json').read_text())
    if latest['runId']==day:
        latest.update(deployment='published',publication=result);dump(state/'latest-reviewed.json',latest)
    (state/'publication-attempt.json').unlink(missing_ok=True)
    (state/'publication-error.json').unlink(missing_ok=True)


def publish(state):
    latest=json.loads((state/'latest-reviewed.json').read_text())
    day=latest['runId'];run=state/'runs'/day
    status=json.loads((run/'status.json').read_text())
    context=json.loads((run/'context.json').read_text())
    review=json.loads((run/'review.json').read_text())
    proposal=json.loads((run/'proposal.json').read_text())
    application,authorization,selection=prepare_application(run,proposal,review,context)
    for name,expected_view in [('application-proposal.json',application),('application-authorization.json',authorization)]:
        path=run/name
        if path.exists() and json.loads(path.read_text())!=expected_view:
            raise ValueError('Derived application differs from the original review and standing rules')
    artifact=Path(latest['artifact']).resolve();baseline=Path(context['baseline']).resolve()
    if status.get('status')!='complete' or authorization.get('approved') is not True:
        raise ValueError('Research/review not complete and approved')
    if artifact != (run/'ratings.sqlite').resolve():raise ValueError('Unexpected artifact path')
    if digest(artifact)!=latest['sha256']:raise ValueError('Reviewed artifact changed')
    if digest(baseline)!=context['baselineSha256'] or review['reviewedBaselineSha256']!=context['baselineSha256']:
        raise ValueError('Baseline changed')
    if review['reviewedProposalSha256']!=proposal_sha(proposal) or review['reviewedLedgerSha256']!=context['ledgerSha256']:
        raise ValueError('Review not bound to proposal/history')
    proof=validate(baseline,artifact)
    dump(run/'publication-validation.json',proof)
    previous=state/'remote-published.json'
    expected=json.loads(previous.read_text())['sha256'] if previous.exists() else context['baselineSha256']
    client=AwsMcp()
    try:
        ident=client.script("r=await call_boto3(service_name='sts',operation_name='GetCallerIdentity',region_name='eu-west-2',params={})\nresult={'account':r['Account']}\nresult")
        if ident['account']!='843872332156':raise ValueError('Wrong AWS account')
        pending=state/'publication-attempt.json'
        if pending.exists():
            attempt=json.loads(pending.read_text())
            try:
                recovered=poll_ssm(client,attempt['commandId'])
            except PublicationFailed:
                pending.unlink(missing_ok=True)
                raise
            if recovered.get('status') not in {'published','already-published'} or recovered.get('sha256')!=attempt['sha256']:
                raise ValueError('Interrupted publication needs reconciliation')
            record(state,attempt['runId'],recovered)
            expected=recovered['sha256']
            if attempt['runId']==day:
                print(json.dumps(recovered));return 0
        if expected==latest['sha256'] and previous.exists():
            # A no-change morning verifies the served artifact without an upload/restart.
            check="""from pathlib import Path
import hashlib,json,urllib.request
p=Path('/opt/bendbound/routing/.data/uk-current/graph/ratings.sqlite')
h=hashlib.sha256()
with p.open('rb') as f:
 for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
assert h.hexdigest()==EXPECTED
health=json.load(urllib.request.urlopen('http://127.0.0.1:8088/health',timeout=10))
assert health['catalogue']['graph_version']==GRAPH
print(json.dumps({'status':'already-published','sha256':EXPECTED,'graphVersion':GRAPH}))
""".replace('EXPECTED',repr(latest['sha256'])).replace('GRAPH',repr(proof['graphVersion']))
            result=ssm(client,["python3 -c "+shlex.quote(check)],state,day,latest['sha256'],
                       {'mode':'verify','sha256':latest['sha256'],'graphVersion':proof['graphVersion']})
            key=None
        else:
            key='route-research/'+day+'/'+latest['sha256']+'/ratings.sqlite'
            # A file-backed PUT streams the artifact without loading753MB into memory.
            import http.client
            import urllib.parse
            for attempt in range(2):
                url=urllib.parse.urlsplit(client.signed(BUCKET,key,'upload'))
                connection=http.client.HTTPSConnection(url.netloc,timeout=120)
                with artifact.open('rb') as stream:
                    connection.request('PUT',url.path+'?'+url.query,body=stream,
                                       headers={'Content-Length':str(artifact.stat().st_size)})
                    response=connection.getresponse();response.read()
                    http_status=response.status
                connection.close()
                if http_status==200:break
                if attempt==0 and http_status in (401,403):
                    client.renew_login()
                    continue
                raise RuntimeError('Ratings artifact upload failed')
            download=client.signed(BUCKET,key,'download')
            config={'runId':day,'sha256':latest['sha256'],'graphVersion':proof['graphVersion'],
                    'expectedPreviousSha256':expected,'downloadUrl':download}
            remote=(Path(__file__).with_name('remote_publish.py')).read_text()
            # Script and ephemeral URL travel only through the configured SSM operation.
            command="python3 -c "+shlex.quote(remote)+" <<'PUBLISH_INPUT'\n"+json.dumps(config)+"\nPUBLISH_INPUT"
            result=ssm(client,[command],state,day,latest['sha256'],{'mode':'publish',**config})
        if result.get('status') not in {'published','already-published'} or result.get('sha256')!=latest['sha256']:
            raise ValueError('Remote activation not confirmed')
        import sqlite3
        with sqlite3.connect((state/'ledger.sqlite').as_uri()+'?mode=ro',uri=True) as ledger:
            changed_today=ledger.execute('SELECT COUNT(DISTINCT section_id) FROM events WHERE run_id=?',(day,)).fetchone()[0]
        result['changedSectionsVsNationalBaseline']=proof['changedSections']
        result['selection']=selection
        record(state,day,result,changed_today)
        print(json.dumps(result))
        # S3 is transfer staging; retain rollback versions on EC2, not daily full copies in S3.
        try:
            if key:
                client.script("r=await call_boto3(service_name='s3',operation_name='DeleteObject',region_name='eu-west-2',params="+repr({'Bucket':BUCKET,'Key':key})+")\nresult={'transferRemoved':True}\nresult")
        except Exception:
            print('Publication succeeded; temporary S3 transfer cleanup needs retry.')
        # Preserve all sources/reviews/individual deltas; only old published DB copies expire.
        completed=sorted((p for p in (state/'runs').iterdir() if (p/'publication.json').exists()),reverse=True)
        for old in completed[3:]:
            (old/'ratings.sqlite').unlink(missing_ok=True)
        return 0
    finally:
        client.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state',default=str(ROOT/'routing/.data/research'))
    args=parser.parse_args();state=Path(args.state).resolve()
    with (state/'publication.lock').open('a') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            raise SystemExit(publish(state))
        except Exception as error:
            result={'status':'blocked','message':str(error) if isinstance(error,(ValueError,RuntimeError,ConnectionError)) else type(error).__name__}
            dump(state/'publication-error.json',result)
            pointer=state/'latest-reviewed.json'
            if pointer.exists():
                latest=json.loads(pointer.read_text())
                status_file=state/'runs'/latest['runId']/'status.json'
                status=json.loads(status_file.read_text())
                if status.get('status')=='complete':
                    status.update(deployment='blocked',publicationError=result['message'])
                    dump(status_file,status)
            print(json.dumps(result));raise SystemExit(1)
