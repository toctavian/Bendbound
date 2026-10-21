"""Prepare a credential-free, checksummed POI release for AWS MCP/SSM."""
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parents[1]
files = {'service.py': 'routing/poi/service.py', 'test_service.py': 'routing/poi/test_service.py',
         'bendbound-poi.service': 'routing/poi/bendbound-poi.service', 'deploy.py': 'routing/poi/deploy.py', 'Caddyfile': 'routing/catalogue/Caddyfile'}
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz') as tar:
    for name, path in files.items():
        tar.add(root / path, arcname=name)
archive = buf.getvalue()
digest = hashlib.sha256(archive).hexdigest()
release = '/opt/bendbound/releases/poi-' + digest[:12]
remote = '''import base64,hashlib,io,json,pathlib,subprocess,tarfile
archive=base64.b64decode(ARCHIVE)
if hashlib.sha256(archive).hexdigest()!=DIGEST:raise RuntimeError('Release checksum mismatch')
release=pathlib.Path(RELEASE);release.mkdir(parents=True,exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as tar:
 for member in tar.getmembers():
  if member.name.startswith('/') or '..' in pathlib.Path(member.name).parts:raise RuntimeError('Invalid archive path')
 tar.extractall(release,filter='data')
checks=subprocess.run(['python3','-m','unittest','discover','-s',str(release),'-p','test_*.py'],capture_output=True,text=True)
print(json.dumps({'remoteTestsPassed':checks.returncode==0}))
if checks.returncode:raise SystemExit(1)
result=subprocess.run(['python3',str(release/'deploy.py'),str(release)],capture_output=True,text=True)
print(result.stdout)
if result.returncode:raise SystemExit(result.returncode)
'''.replace('ARCHIVE', repr(base64.b64encode(archive).decode())).replace('DIGEST', repr(digest)).replace('RELEASE', repr(release))
command = "python3 - <<'BEND_BOUND_POI_DEPLOY'\n" + remote + '\nBEND_BOUND_POI_DEPLOY'
params = {'InstanceIds': ['i-0c392dc16f7c9d857'], 'DocumentName': 'AWS-RunShellScript',
          'Comment': 'Deploy tested POI and fuel synchronization service with rollback', 'Parameters': {'commands': [command]}, 'TimeoutSeconds': 180}
script = "command = await call_boto3(service_name='ssm',operation_name='SendCommand',region_name='eu-west-2',params=" + repr(params) + ")\nresult={'commandId':command['Command']['CommandId']}\nresult\n"
Path('/tmp/roams-poi-deploy-send.py').write_text(script)
Path('/tmp/roams-poi-release.json').write_text(json.dumps({'release': release, 'sha256': digest,
    'files': {path: hashlib.sha256((root/path).read_bytes()).hexdigest() for path in files.values()}}))
print('Prepared reviewed release:', digest[:12], '; AWS command bytes:', len(command))
