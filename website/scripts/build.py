#!/usr/bin/env python3
import hashlib,json,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
out=root/'build';out.mkdir(exist_ok=True)
archive=out/'website.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for file in [root/'handler.py',*sorted((root/'public').rglob('*'))]:
        if not file.is_file(): continue
        entry=zipfile.ZipInfo(file.relative_to(root).as_posix(),(2026,1,1,0,0,0))
        entry.compress_type=zipfile.ZIP_DEFLATED;entry.external_attr=0o644<<16
        z.writestr(entry,file.read_bytes())
sha=hashlib.sha256(archive.read_bytes()).hexdigest()
print(json.dumps({'archive':str(archive),'sha256':sha,'key':f'releases/{sha}/website.zip','bytes':archive.stat().st_size}))
