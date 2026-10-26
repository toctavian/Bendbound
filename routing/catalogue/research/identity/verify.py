#!/usr/bin/env python3
"""Prove fresh machine credentials, scoped S3 transfer and fixed SSM verification."""
import configparser
import datetime
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import urllib.request
import uuid

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from aws_mcp import AwsMcp
from identity.document import DOCUMENT, GRAPH, BUCKET, parameters
from identity.local_identity import DIRECTORY


def main():
    if os.environ.get('BENDBOUND_RESEARCH_AWS_PROFILE')!='bendbound-research':
        raise ValueError('Verification must explicitly select the machine profile')
    cfg=configparser.RawConfigParser();cfg.read(Path.home()/'.aws/config')
    command=shlex.split(cfg.get('profile bendbound-research','credential_process'))
    # Authentication only: never print or persist the credential-process output.
    fresh=[]
    for _ in range(2):
        process=subprocess.run(command,capture_output=True,timeout=60)
        if process.returncode:raise RuntimeError('Certificate authentication failed')
        fresh.append(json.loads(process.stdout))
    if fresh[0]['AccessKeyId']==fresh[1]['AccessKeyId']:
        raise ValueError('Fresh credential sessions were not demonstrated')
    expirations=[x['Expiration'] for x in fresh];del fresh
    client=AwsMcp();key='route-research/identity-probes/'+str(uuid.uuid4())
    def api(service,operation,params,expression):
        return client.script('r=await call_boto3(service_name='+repr(service)+',operation_name='+repr(operation)+",region_name='eu-west-2',params="+repr(params)+')\nresult='+expression+'\nresult')
    try:
        who=api('sts','GetCallerIdentity',{},"{'account':r['Account'],'arn':r['Arn']}")
        if who['account']!='843872332156' or ':assumed-role/bendbound-research-publisher/' not in who['arn']:
            raise ValueError('Unexpected machine principal')
        body=b'Bendbound scheduled identity verification\n'
        try:
            request=urllib.request.Request(client.signed(BUCKET,key,'upload'),data=body,method='PUT')
            with urllib.request.urlopen(request,timeout=60) as response:
                if response.status!=200:raise RuntimeError('Transfer upload failed')
            with urllib.request.urlopen(client.signed(BUCKET,key,'download'),timeout=60) as response:
                if response.read()!=body:raise ValueError('Transfer content mismatch')
        finally:
            api('s3','DeleteObject',{'Bucket':BUCKET,'Key':key},"{'removed':True}")
        latest=json.loads((HERE.parents[3]/'routing/.data/research/remote-published.json').read_text())
        payload={'mode':'verify','sha256':latest['sha256'],'graphVersion':GRAPH}
        command_id=api('ssm','SendCommand',{'InstanceIds':['i-0c392dc16f7c9d857'],'DocumentName':DOCUMENT,
            'Parameters':parameters(payload),'Comment':'Verify scheduled certificate identity; no ratings change or restart'},"r['Command']['CommandId']")
        for _ in range(30):
            time.sleep(3)
            result=api('ssm','GetCommandInvocation',{'CommandId':command_id,'InstanceId':'i-0c392dc16f7c9d857'},
                      "{'status':r['Status'],'stdout':r.get('StandardOutputContent','')}")
            if result['status'] in {'Pending','InProgress','Delayed'}:continue
            if result['status']!='Success':raise RuntimeError('Fixed SSM verification failed: '+command_id)
            server=json.loads(result['stdout'])
            if server['sha256']!=latest['sha256']:raise ValueError('Live ratings mismatch')
            receipt={'status':'verified','checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'principal':who['arn'],'freshCredentialSessions':2,'credentialExpirations':expirations,'s3TransferAndCleanup':True,
                'ssmCommandId':command_id,'server':server,'ratingsModified':False,'browserLoginUsed':False}
            (DIRECTORY/'verification.json').write_text(json.dumps(receipt,indent=2)+'\n')
            print(json.dumps(receipt));return
        raise RuntimeError('SSM verification still pending: '+command_id)
    finally:client.close()

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'status':'failed','errorType':type(error).__name__,'message':str(error) if isinstance(error,(ValueError,RuntimeError,ConnectionError)) else 'Machine identity verification failed; no credentials logged'}))
        raise SystemExit(1)
