import base64,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from handler import handler

def event(path='/', method='GET', headers=None):
    return {'rawPath':path,'requestContext':{'http':{'method':method}},'headers':headers or {}}
class WebsiteHandlerTests(unittest.TestCase):
    def test_homepage_and_assets(self):
        for path,kind in [('/', 'text/html'),('/styles.css','text/css'),('/assets/map.webp','image/webp')]:
            r=handler(event(path),None)
            self.assertEqual(r['statusCode'],200)
            self.assertTrue(r['headers']['content-type'].startswith(kind))
            self.assertGreater(len(base64.b64decode(r['body'])),100)
            self.assertIn("frame-ancestors 'none'",r['headers']['content-security-policy'])
    def test_head_and_conditional_requests(self):
        r=handler(event(),None)
        self.assertEqual(handler(event(method='HEAD'),None)['body'],'')
        self.assertEqual(handler(event(headers={'if-none-match':r['headers']['etag']}),None)['statusCode'],304)
    def test_missing_and_traversal(self):
        for path in ['/missing','/../handler.py','/%2e%2e/handler.py','/handler.py','/assets/../../handler.py','/%00']:
            self.assertEqual(handler(event(path),None)['statusCode'],404,path)
    def test_no_write_methods(self):
        self.assertEqual(handler(event(method='POST'),None)['statusCode'],405)
if __name__=='__main__':unittest.main()
