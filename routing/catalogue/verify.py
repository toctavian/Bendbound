#!/usr/bin/env python3
"""Live deployment gates; save navigation geometries for independent revalidation."""
import argparse
import datetime
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

parser=argparse.ArgumentParser()
parser.add_argument('--base',default='http://127.0.0.1:8088')
parser.add_argument('--env-file')
parser.add_argument('--output',default='/opt/bendbound/catalogue-verification.json')
args=parser.parse_args()
token=None
if args.env_file:
    for line in Path(args.env_file).read_text().splitlines():
        if line.startswith(('ROUTING_API_TOKEN=','EXPO_PUBLIC_ROUTING_TOKEN=')):
            token=line.split('=',1)[1].strip().strip('"').strip("'")


def request(path,data=None,authenticated=True):
    headers={'Content-Type':'application/json'}
    if token and authenticated:headers['Authorization']='Bearer '+token
    start=time.monotonic()
    req=urllib.request.Request(args.base+path,data=json.dumps(data).encode() if data is not None else None,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=45) as response:status=response.status;body=json.load(response)
    except urllib.error.HTTPError as error:
        status=error.code;raw=error.read().decode('utf-8',errors='replace')
        try:body=json.loads(raw)
        except json.JSONDecodeError:body={'code':f'HTTP_{status}','message':raw[:1024]}
    return status,body,round(time.monotonic()-start,3)


checks=[];routes=[]
for attempt in range(30):
    try:
        status,health,seconds=request('/health')
        if status==200:break
    except (OSError,urllib.error.URLError):
        if attempt==29:raise
    time.sleep(1)
assert status==200 and health['implementation']=='road-catalogue-v1' and health['status']=='ready',health
assert health['catalogue']['version']==health['catalogue']['graph_version']
assert health['catalogue']['sections']>0 and health['catalogue']['recommended_sections']>0
checks.append({'check':'health','seconds':seconds,'response':health})
status,roads,seconds=request('/roads?lat=51.2328&lon=-0.3297&radiusKm=30')
assert status==200 and roads['roads'],roads
assert all(r['geometry']['type']=='LineString' and len(r['geometry']['coordinates'])>=2 and 0<=r['rating']<=5 for r in roads['roads'])
assert any(r['recommendationCount']>0 for r in roads['roads'])
checks.append({'check':'full-road-area-search','seconds':seconds,'returnedSections':len(roads['roads']),'sample':roads['roads'][:3]})
status,outside,seconds=request('/round-trip',{'center':{'latitude':52.7,'longitude':0},'targetKm':40,'direction':90,'profile':'winding','avoidMotorways':True})
assert status==422 and outside['code']=='OUTSIDE_AREA'
checks.append({'check':'outside-area-rejected','status':status})
status,standard,seconds=request('/route',{'locations':[{'lat':51.481,'lon':-0.009},{'lat':51.505,'lon':-0.075}],'costing':'motorcycle','units':'kilometers','shape_format':'polyline6'})
assert status==200 and standard['trip']['legs'],standard
checks.append({'check':'standard-route','seconds':seconds,'distanceKm':standard['trip']['summary']['length']})
cases=[
    {'name':'E14-40-south','center':{'latitude':51.487429,'longitude':-0.020573},'targetKm':40,'direction':180},
    {'name':'E14-40-west','center':{'latitude':51.487429,'longitude':-0.020573},'targetKm':40,'direction':270},
    {'name':'Greenwich-20','center':{'latitude':51.481,'longitude':-0.009},'targetKm':20,'direction':90},
    {'name':'Dorking-40','center':{'latitude':51.2328,'longitude':-0.3297},'targetKm':40,'direction':90},
    {'name':'Ashdown-60','center':{'latitude':51.0786776,'longitude':0.101936},'targetKm':60,'direction':90},
]
for case in cases:
    name=case['name']; data={k:v for k,v in case.items() if k!='name'};data.update(profile='winding',avoidMotorways=True)
    status,result,seconds=request('/round-trip',data)
    assert status==200,(name,status,result)
    p=result['planner']; legs=result['trip']['legs']
    assert p['valid'] and p['implementation']=='road-catalogue-v1'
    assert abs(result['trip']['summary']['length']-data['targetKm'])<10
    assert p['roadUsePolicy']=='physical-segments-twice-10-percent'
    assert p['maxTraversals']<=2 and p['repeatedRatio']<=0.1+1e-9
    assert (p['identityVerification']=='strict-geometry-subset' or p['verifiedRatio']>=0.98) and p['closed'] and p['nearStart']
    assert legs and all(l.get('shape') and l.get('maneuvers') for l in legs)
    assert all(0<=r['coverage']<=1 and r['traversedKm']<=r['lengthKm']+0.001 for r in p['roads'])
    if name!='Greenwich-20':assert p['evaluatedKm']>0,(name,p)
    checks.append({'check':name,'input':data,'seconds':seconds,'planner':p,'distanceKm':result['trip']['summary']['length'],'maneuvers':sum(len(l['maneuvers']) for l in legs)})
    routes.append({'input':data,'response':result})
    print(json.dumps({'check':name,'seconds':seconds,'distanceKm':p['distanceKm'],'evaluatedKm':p['evaluatedKm'],'recommendedKm':p['recommendedKm'],'sections':len(p['roads'])}),flush=True)
if token:
    status,_,_=request('/health',authenticated=False);assert status==401
    checks.append({'check':'missing-token-rejected','status':status})
record={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'base':args.base,'checks':checks}
Path(args.output).write_text(json.dumps(record,indent=2)+'\n')
Path(args.output+'.routes.json').write_text(json.dumps(routes)+'\n')
print('Deployment gates passed',flush=True)
