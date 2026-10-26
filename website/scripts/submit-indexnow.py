#!/usr/bin/env python3
"""Notify participating search engines after deployment; receipt is not indexing."""
import json
from pathlib import Path
import re
import urllib.request

root = Path(__file__).resolve().parents[1]
keys = [p for p in (root / 'public').glob('*.txt') if re.fullmatch('[a-f0-9]{32}', p.stem)]
if len(keys) != 1:
    raise RuntimeError('Expected one published IndexNow ownership file')
key = keys[0].read_text().strip()
key_url = 'https://bendboundapp.com/' + keys[0].name
with urllib.request.urlopen(key_url, timeout=25) as response:
    if response.read().decode().strip() != key:
        raise RuntimeError('Deployed ownership file does not match local release')
payload = {'host': 'bendboundapp.com', 'key': key, 'keyLocation': key_url,
           'urlList': ['https://bendboundapp.com/']}
request = urllib.request.Request('https://api.indexnow.org/indexnow',
    data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
with urllib.request.urlopen(request, timeout=30) as response:
    if response.status not in (200, 202):
        raise RuntimeError('Unexpected IndexNow response: ' + str(response.status))
    result = {'endpoint': 'https://api.indexnow.org/indexnow', 'httpStatus': response.status,
              'urls': payload['urlList'], 'meaning': ('Notification received; ownership verification pending' if response.status == 202 else 'Notification received; indexing is not guaranteed')}
(root / 'indexnow-submission.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
