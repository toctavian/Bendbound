"""Build the fixed SSM command available to the unattended ratings identity."""
import base64
import json
from pathlib import Path

DOCUMENT = 'Bendbound-PublishReviewedRatings'
GRAPH = '8cc789c4ceb36866622af1a26b787f9b5515c40537b569b9beebcc069a93acd2'
BUCKET = 'bendbound-group-artifacts-843872332156-eu-west-2'


def document():
    source = (Path(__file__).resolve().parents[1] / 'remote_publish.py').read_text()
    source = source.split("if __name__=='__main__':")[0]
    # Docker Go templates must not be mistaken for SSM parameter interpolation.
    source = source.replace("'{{json .Config.Env}}'", "('{'*2+'json .Config.Env'+'}'*2)")
    wrapper = '''
import base64,re,urllib.parse
if len('{{ Payload }}')>16384:raise ValueError('Payload too large')
config=json.loads(base64.b64decode('{{ Payload }}',validate=True))
if set(config) not in ({'mode','sha256','graphVersion'}, {'mode','runId','sha256','graphVersion','expectedPreviousSha256','downloadUrl'}):
 raise ValueError('Unexpected publication fields')
if config['graphVersion'] != GRAPH: raise ValueError('Unapproved graph')
if not re.fullmatch('[0-9a-f]{64}',config['sha256']): raise ValueError('Invalid checksum')
if config['mode']=='verify':
 active=ROOT/'.data/uk-current/graph/ratings.sqlite'
 if digest(active)!=config['sha256']:raise ValueError('Active ratings differ')
 ready(config['graphVersion'])
 print(json.dumps({'status':'already-published','sha256':config['sha256'],'graphVersion':config['graphVersion']}))
elif config['mode']=='publish':
 if not re.fullmatch(r'20[0-9]{2}-[0-9]{2}-[0-9]{2}',config['runId']):raise ValueError('Invalid run ID')
 if not re.fullmatch('[0-9a-f]{64}',config['expectedPreviousSha256']):raise ValueError('Invalid previous checksum')
 u=urllib.parse.urlsplit(config['downloadUrl'])
 expected='/route-research/'+config['runId']+'/'+config['sha256']+'/ratings.sqlite'
 if u.scheme!='https' or u.netloc not in {BUCKET+'.s3.eu-west-2.amazonaws.com',BUCKET+'.s3.amazonaws.com'} or u.path!=expected or u.fragment:
  raise ValueError('Unapproved artifact location')
 print(json.dumps(install(config)))
else:raise ValueError('Invalid publication mode')
'''.replace('GRAPH',repr(GRAPH)).replace('BUCKET',repr(BUCKET))
    return {'schemaVersion':'2.2','description':'Install reviewed ratings only, or verify current ratings; pinned UK graph and transfer prefix.',
            'parameters':{'Payload':{'type':'String','description':'Base64 encoded publication configuration; no executable code.',
                                     'allowedPattern':'^[A-Za-z0-9+/=]+$'}},
            'mainSteps':[{'action':'aws:runShellScript','name':'PublishReviewedRatings','inputs':{
                'timeoutSeconds':'900','runCommand':["python3 - <<'BEND_RESEARCH_PY'\n"+source+wrapper+'\nBEND_RESEARCH_PY']}}]}


def parameters(config):
    return {'Payload':[base64.b64encode(json.dumps(config).encode()).decode()]}
