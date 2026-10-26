#!/usr/bin/env python3
"""Enroll the Mac's ratings-only machine identity via the manual AWS MCP profile."""
import configparser
import json
import os
from pathlib import Path
import shlex
import sys

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from aws_mcp import AwsMcp
from identity.document import document, DOCUMENT, BUCKET
from identity.local_identity import prepare, run, OPENSSL

ACCOUNT='843872332156'
REGION='eu-west-2'
ROLE='bendbound-research-publisher'
NAME='bendbound-research-mac'
INSTANCE='i-0c392dc16f7c9d857'


def permission_policy():
    return {'Version':'2012-10-17','Statement':[
      {'Sid':'RatingsTransferOnly','Effect':'Allow','Action':['s3:GetObject','s3:PutObject','s3:DeleteObject'],
       'Resource':f'arn:aws:s3:::{BUCKET}/route-research/*'},
      {'Sid':'ResolveTransferBucketRegion','Effect':'Allow','Action':'s3:GetBucketLocation',
       'Resource':f'arn:aws:s3:::{BUCKET}'},
      {'Sid':'FixedRatingsCommandOnly','Effect':'Allow','Action':'ssm:SendCommand',
       'Resource':[f'arn:aws:ssm:{REGION}:{ACCOUNT}:document/{DOCUMENT}',f'arn:aws:ec2:{REGION}:{ACCOUNT}:instance/{INSTANCE}']},
      {'Sid':'ReadCommandCompletion','Effect':'Allow','Action':'ssm:GetCommandInvocation','Resource':'*'}]}


def main():
    if os.environ.get('BENDBOUND_RESEARCH_AWS_PROFILE','bendbound')!='bendbound':
        raise ValueError('Enrollment requires the manual bendbound profile')
    directory=prepare();client=AwsMcp()
    def api(service,operation,params,expression='r'):
        return client.script('import json\nr=await call_boto3(service_name='+repr(service)+',operation_name='+repr(operation)+',region_name='+repr(REGION)+',params='+repr(params)+')\nresult='+expression+'\nresult')
    try:
        who=api('sts','GetCallerIdentity',{},"{'account':r['Account']}")
        if who['account']!=ACCOUNT:raise ValueError('Wrong AWS account')
        anchors=api('rolesanywhere','ListTrustAnchors',{},"r.get('trustAnchors',[])")
        found=next((x for x in anchors if x['name']==NAME),None)
        cert=(directory/'ca.pem').read_text()
        if found:
            anchor=found['trustAnchorArn']
            existing=api('rolesanywhere','GetTrustAnchor',{'trustAnchorId':found['trustAnchorId']},"r['trustAnchor']")
            if existing['source']['sourceData']['x509CertificateData'].strip()!=cert.strip():raise ValueError('Existing trust anchor belongs to another CA')
        else:
            a=api('rolesanywhere','CreateTrustAnchor',{'name':NAME,'enabled':True,'source':{'sourceType':'CERTIFICATE_BUNDLE','sourceData':{'x509CertificateData':cert}},'tags':[{'key':'Purpose','value':'BendboundDailyRatings'}]},"r['trustAnchor']")
            anchor=a['trustAnchorArn']
        trust={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':'rolesanywhere.amazonaws.com'},
            'Action':['sts:AssumeRole','sts:TagSession','sts:SetSourceIdentity'],'Condition':{
             'ArnEquals':{'aws:SourceArn':anchor},'StringEquals':{'aws:SourceAccount':ACCOUNT,'aws:PrincipalTag/x509Subject/CN':NAME}}}]}
        roles=api('iam','ListRoles',{},"[x['RoleName'] for x in r['Roles']]")
        if ROLE not in roles:api('iam','CreateRole',{'RoleName':ROLE,'AssumeRolePolicyDocument':json.dumps(trust),'MaxSessionDuration':3600,'Description':'Mac scheduled ratings publisher; certificate identity and fixed SSM publication only.'},"{'created':True}")
        else:api('iam','UpdateAssumeRolePolicy',{'RoleName':ROLE,'PolicyDocument':json.dumps(trust)},"{'updated':True}")
        api('iam','PutRolePolicy',{'RoleName':ROLE,'PolicyName':'RatingsPublicationOnly','PolicyDocument':json.dumps(permission_policy())},"{'policyInstalled':True}")
        role=f'arn:aws:iam::{ACCOUNT}:role/{ROLE}'
        profiles=api('rolesanywhere','ListProfiles',{},"r.get('profiles',[])")
        found=next((x for x in profiles if x['name']==NAME),None)
        if found:
            pr=api('rolesanywhere','UpdateProfile',{'profileId':found['profileId'],'durationSeconds':3600,'roleArns':[role]},"r['profile']")
        else:pr=api('rolesanywhere','CreateProfile',{'name':NAME,'enabled':True,'durationSeconds':3600,'roleArns':[role],'tags':[{'key':'Purpose','value':'BendboundDailyRatings'}]},"r['profile']")
        docs=api('ssm','ListDocuments',{'Filters':[{'Key':'Owner','Values':['Self']}]},"[x['Name'] for x in r.get('DocumentIdentifiers',[])]")
        content=json.dumps(document())
        if DOCUMENT not in docs:api('ssm','CreateDocument',{'Name':DOCUMENT,'Content':content,'DocumentType':'Command','DocumentFormat':'JSON'},"{'created':True}")
        else:
            previous=api('ssm','GetDocument',{'Name':DOCUMENT,'DocumentVersion':'$LATEST'},"json.loads(r['Content'])")
            if previous!=document():
                version=api('ssm','UpdateDocument',{'Name':DOCUMENT,'Content':content,'DocumentVersion':'$LATEST','DocumentFormat':'JSON'},"r['DocumentDescription']['DocumentVersion']")
                api('ssm','UpdateDocumentDefaultVersion',{'Name':DOCUMENT,'DocumentVersion':version},"{'updated':True}")
        args=[str(directory/'aws_signing_helper'),'credential-process','--certificate',str(directory/'client.pem'),'--private-key',str(directory/'client-key.pem'),
              '--trust-anchor-arn',anchor,'--profile-arn',pr['profileArn'],'--role-arn',role,'--session-duration','3600','--region',REGION]
        path=Path.home()/'.aws/config';text=path.read_text();cfg=configparser.RawConfigParser();cfg.read_string(text)
        section='profile bendbound-research'
        if cfg.has_section(section):
            if cfg.get(section,'credential_process',fallback='')!=shlex.join(args) or cfg.get(section,'region',fallback='')!=REGION:
                raise ValueError('Existing machine profile differs; inspect before replacing')
        else:
            text+='\n['+section+']\nregion = '+REGION+'\ncredential_process = '+shlex.join(args)+'\n'
            tmp=path.with_suffix('.research.tmp');tmp.write_text(text);tmp.chmod(0o600);tmp.replace(path)
        receipt={'status':'enrolled','awsProfile':'bendbound-research','manualProfile':'bendbound','trustAnchorArn':anchor,'rolesAnywhereProfileArn':pr['profileArn'],
                 'roleArn':role,'ssmDocument':DOCUMENT,'certificateExpiry':run([OPENSSL,'x509','-enddate','-noout','-in',str(directory/'client.pem')]).decode().strip(),
                 'permissions':permission_policy()}
        (directory/'enrollment.json').write_text(json.dumps(receipt,indent=2)+'\n')
        print(json.dumps(receipt))
    finally:client.close()

if __name__=='__main__':main()
