"""Static promotional website served by Lambda Function URL through CloudFront."""
import base64
import hashlib
import mimetypes
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent / 'public'
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; upgrade-insecure-requests"
HEADERS = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'strict-transport-security': 'max-age=31536000',
}

def handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    if method not in ('GET', 'HEAD'):
        return response(405, b'Method not allowed', 'text/plain; charset=utf-8', method, {'allow': 'GET, HEAD', 'cache-control': 'no-store'})
    path = unquote(event.get('rawPath', '/') or '/')
    if '\x00' in path or '\\' in path or any(part == '..' for part in path.split('/')):
        return response(404, b'Not found', 'text/plain; charset=utf-8', method, {'cache-control': 'no-store'})
    file = (ROOT / ('index.html' if path == '/' else path.lstrip('/'))).resolve()
    if not file.is_relative_to(ROOT.resolve()) or not file.is_file():
        return response(404, b'Not found', 'text/plain; charset=utf-8', method, {'cache-control': 'no-store'})
    body = file.read_bytes()
    content_type = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
    if content_type.startswith('text/') or content_type in ('application/javascript', 'application/xml'):
        content_type += '; charset=utf-8'
    etag = '"' + hashlib.sha256(body).hexdigest() + '"'
    headers = {'cache-control': 'public, max-age=300' if file.suffix in ('.html', '.css', '.js') else 'public, max-age=86400', 'etag': etag}
    if event.get('headers', {}).get('if-none-match') == etag:
        return {'statusCode': 304, 'headers': {**HEADERS, **headers}, 'body': ''}
    return response(200, body, content_type, method, headers)

def response(status, body, content_type, method, extra):
    return {'statusCode': status, 'headers': {**HEADERS, 'content-type': content_type, **extra}, 'isBase64Encoded': True, 'body': '' if method == 'HEAD' else base64.b64encode(body).decode('ascii')}
