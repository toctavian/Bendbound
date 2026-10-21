#!/usr/bin/env python3
"""Deploy only through the configured AWS MCP; upload via its presigned S3 URL."""
import hashlib,importlib.util,json,subprocess,sys,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('website_aws_mcp',ROOT/'scripts/aws-mcp.py')
mcp=importlib.util.module_from_spec(spec);spec.loader.exec_module(mcp)
def data(response):
    if response.get('isError'):raise RuntimeError('AWS MCP tool returned an error: '+json.dumps(response))
    d=response.get('structuredContent')
    if d is None:d=json.loads(next(c['text'] for c in response['content'] if c.get('type')=='text'))
    return d

def run(code):
    d=data(mcp.invoke('aws___run_script',{'code':code}))
    if d.get('status')!='success':raise RuntimeError('AWS MCP script did not complete: '+json.dumps(d))
    if not d.get('api_calls'):raise RuntimeError('No AWS API execution evidence')
    print(json.dumps({'api_calls':d['api_calls']}),flush=True)
    return d['return_value']

def find_url(value):
    if isinstance(value,str) and value.startswith('https://') and 'X-Amz-Signature=' in value:return value
    if isinstance(value,dict):
        for item in value.values():
            found=find_url(item)
            if found:return found
    if isinstance(value,list):
        for item in value:
            found=find_url(item)
            if found:return found
    return None

def main():
    build=json.loads(subprocess.check_output([sys.executable,str(ROOT/'scripts/build.py')],text=True))
    bucket='bendbound-website-artifacts-843872332156-eu-west-2'
    signed=data(mcp.invoke('aws___get_presigned_url',{'requests':[{'bucket':bucket,'key':build['key'],'operation':'upload','region':'eu-west-2','expires_in':900}]}))
    url=find_url(signed)
    if not url:raise RuntimeError('MCP did not return an S3 upload URL')
    req=urllib.request.Request(url,data=Path(build['archive']).read_bytes(),method='PUT')
    with urllib.request.urlopen(req,timeout=60) as r:
        if r.status!=200:raise RuntimeError('S3 upload failed')
    del url,signed,req
    template=(ROOT/'infra/stack.json').read_text()
    params=[{'ParameterKey':k,'ParameterValue':v} for k,v in {'ArtifactBucket':bucket,'ArtifactKey':build['key'],'CertificateArn':'arn:aws:acm:us-east-1:843872332156:certificate/725b366d-f0f4-489b-8c7b-150009f0a090','HostedZoneId':'Z07131531TX895IIR7J1N'}.items()]
    validation=run("r=await call_boto3(service_name='cloudformation',operation_name='ValidateTemplate',region_name='eu-west-2',params="+repr({'TemplateBody':template})+")\nresult=r\nresult")
    request={'StackName':'bendbound-website','TemplateBody':template,'Parameters':params,'Capabilities':['CAPABILITY_IAM'],'Tags':[{'Key':'Project','Value':'Bendbound website'}]}
    # Preserve an existing stack on repeat deployments; discovery is via MCP.
    existing=run("r=await call_boto3(service_name='cloudformation',operation_name='ListStacks',region_name='eu-west-2')\nresult=[s for s in r.get('StackSummaries',[]) if s['StackName']=='bendbound-website' and s['StackStatus']!='DELETE_COMPLETE']\nresult")
    op='UpdateStack' if existing else 'CreateStack'
    result=run("r=await call_boto3(service_name='cloudformation',operation_name="+repr(op)+",region_name='eu-west-2',params="+repr(request)+")\nresult=r\nresult")
    manifest={'domain':'bendboundapp.com','region':'eu-west-2','stackName':'bendbound-website','stackId':result['StackId'],'artifactBucket':bucket,'artifactKey':build['key'],'artifactSha256':build['sha256'],'certificateArn':params[2]['ParameterValue'],'status':'deployment-started'}
    (ROOT/'deployment.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
