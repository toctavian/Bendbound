#!/usr/bin/env python3
"""Public HTTPS smoke checks. No AWS credentials or resource operations."""
import argparse,hashlib,json,socket,subprocess,urllib.error,urllib.request
from pathlib import Path
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):return None
parser=argparse.ArgumentParser()
parser.add_argument('--dns-server',help='Optional public DNS resolver for propagation checks; does not change system DNS or TLS verification')
args=parser.parse_args()
if args.dns_server:
    original_getaddrinfo=socket.getaddrinfo
    dns_cache={}
    def resolved(host,port,*rest,**kwargs):
        if host in ('bendboundapp.com','www.bendboundapp.com'):
            if host not in dns_cache:
                answers=subprocess.check_output(['dig','+short','@'+args.dns_server,host,'A'],text=True).splitlines()
                addresses=[ip for ip in answers if ip.count('.')==3 and all(p.isdigit() for p in ip.split('.'))]
                if not addresses:raise RuntimeError('Public DNS has not resolved '+host)
                dns_cache[host]=addresses[0]
            return original_getaddrinfo(dns_cache[host],port,*rest,**kwargs)
        return original_getaddrinfo(host,port,*rest,**kwargs)
    socket.getaddrinfo=resolved
opener=urllib.request.build_opener(NoRedirect)
def request(url,method='GET'):
    try:
        with opener.open(urllib.request.Request(url,method=method),timeout=25) as r:
            return r.status,dict(r.headers),r.read()
    except urllib.error.HTTPError as e:return e.code,dict(e.headers),e.read()
manifest=json.loads((Path(__file__).resolve().parents[1]/'deployment.json').read_text())
checks=[]
keys=[p for p in (Path(__file__).resolve().parents[1]/'public').glob('*.txt') if len(p.stem)==32 and all(c in '0123456789abcdef' for c in p.stem)]
assert len(keys)==1
status,_,body=request('https://bendboundapp.com/'+keys[0].name)
assert status==200 and body==keys[0].read_bytes()
checks.append({'path':'IndexNow ownership file','status':status,'sha256':hashlib.sha256(body).hexdigest()})
for path,content in [('/',b'Find your'),('/styles.css',b'--bg:#111214'),('/site.js',b'selectFeature'),('/assets/map.webp',b'RIFF'),('/assets/planner.webp',b'RIFF'),('/assets/tours.webp',b'RIFF'),('/assets/route-detail.webp',b'RIFF'),('/assets/social-card.png',b'PNG'),('/llms.txt',b'# Bendbound'),('/index.md',b'# Bendbound'),('/robots.txt',b'Sitemap:'),('/sitemap.xml',b'bendboundapp.com')]:
    status,headers,body=request('https://bendboundapp.com'+path)
    assert status==200,(path,status)
    assert content in body,(path,'missing content')
    local=Path(__file__).resolve().parents[1]/'public'/('index.html' if path=='/' else path.lstrip('/'))
    digest=hashlib.sha256(body).hexdigest()
    assert digest==hashlib.sha256(local.read_bytes()).hexdigest(),(path,'live content differs from local release')
    checks.append({'path':path,'status':status,'bytes':len(body),'sha256':digest})
status,headers,body=request('https://bendboundapp.com/','HEAD')
assert status==200 and not body
lower={k.lower():v for k,v in headers.items()}
assert "script-src 'self'" in lower.get('content-security-policy','')
assert lower.get('x-content-type-options')=='nosniff'
assert '/llms.txt' in lower.get('link','') and 'text/markdown' in lower.get('link','')
assert "'sha256-" in lower['content-security-policy']
for agent in ['Googlebot','bingbot','OAI-SearchBot','PerplexityBot','Claude-SearchBot']:
    with opener.open(urllib.request.Request('https://bendboundapp.com/index.md',headers={'User-Agent':agent}),timeout=25) as r:
        assert r.status==200 and r.headers['Content-Type'].startswith('text/markdown')
status,headers,_=request('http://bendboundapp.com/')
assert status in (301,302,307,308)
assert headers.get('Location',headers.get('location','')).startswith('https://bendboundapp.com')
status,headers,_=request('https://www.bendboundapp.com/')
assert status==308
assert headers.get('Location',headers.get('location'))=='https://bendboundapp.com/'
status,_,_=request('https://bendboundapp.com/not-a-page')
assert status==404
status,_,_=request(manifest['functionUrl'])
assert status==403,('Lambda origin must reject unsigned public access',status)
result={'status':'PASS','website':'https://bendboundapp.com','checks':checks,'httpsRedirect':True,'wwwRedirect':True,'notFound':404,'unsignedOrigin':403,'securityHeaders':True,'dnsResolver':args.dns_server or 'system'}
print(json.dumps(result,indent=2))
(Path(__file__).resolve().parents[1]/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
