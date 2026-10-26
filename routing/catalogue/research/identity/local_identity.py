"""Create Mac-only certificate material and a checksummed official AWS helper."""
import hashlib
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import urllib.request

DIRECTORY = Path.home()/'.aws/bendbound-research'
OPENSSL = '/opt/homebrew/opt/openssl@3/bin/openssl'
HELPER_URL = 'https://rolesanywhere.amazonaws.com/releases/1.8.5/Aarch64/MacOS/Sonoma/aws_signing_helper'
HELPER_SHA = 'ac4b656cd83ffde5a6e9e8f2317ffb90e036c9bb704cc80faa6aee414b55915a'


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError('Local identity command failed: '+Path(args[0]).name)
    return result.stdout


def prepare():
    os.umask(0o077)
    DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True); DIRECTORY.chmod(0o700)
    helper = DIRECTORY/'aws_signing_helper'
    if not helper.exists() or hashlib.sha256(helper.read_bytes()).hexdigest()!=HELPER_SHA:
        data=urllib.request.urlopen(HELPER_URL,timeout=60).read()
        if hashlib.sha256(data).hexdigest()!=HELPER_SHA:raise ValueError('AWS helper checksum mismatch')
        tmp=helper.with_suffix('.tmp');tmp.write_bytes(data);tmp.chmod(0o700);tmp.replace(helper)
    run(['/usr/bin/codesign','--verify','--strict',str(helper)])
    if not (DIRECTORY/'ca.pem').exists():
        if (DIRECTORY/'ca-key.pem').exists():raise ValueError('Partial CA setup requires recovery')
        password=secrets.token_urlsafe(48)
        # security's interactive command input avoids placing the secret in argv/logs.
        command='add-generic-password -U -a bendbound-research -s com.bendbound.research-ca -w '+shlex.quote(password)+'\n'
        run(['/usr/bin/security','-i'],input=command.encode())
        stored=run(['/usr/bin/security','find-generic-password','-a','bendbound-research','-s','com.bendbound.research-ca','-w']).decode().strip()
        if stored!=password:raise RuntimeError('CA password was not stored in Keychain')
        run([OPENSSL,'genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:3072','-aes-256-cbc','-pass','stdin','-out',str(DIRECTORY/'ca-key.pem')],input=(password+'\n').encode())
        run([OPENSSL,'req','-new','-x509','-sha256','-days','3650','-key',str(DIRECTORY/'ca-key.pem'),'-passin','stdin',
             '-subj','/O=Bendbound/OU=Research/CN=Bendbound Research Mac CA',
             '-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign',
             '-out',str(DIRECTORY/'ca.pem')],input=(password+'\n').encode())
    if not (DIRECTORY/'client.pem').exists():
        password=run(['/usr/bin/security','find-generic-password','-a','bendbound-research','-s','com.bendbound.research-ca','-w']).strip()
        run([OPENSSL,'genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',str(DIRECTORY/'client-key.pem')])
        run([OPENSSL,'req','-new','-sha256','-key',str(DIRECTORY/'client-key.pem'),'-subj','/O=Bendbound/OU=Research/CN=bendbound-research-mac','-out',str(DIRECTORY/'client.csr')])
        extensions=DIRECTORY/'client.ext'
        extensions.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
        run([OPENSSL,'x509','-req','-sha256','-days','365','-in',str(DIRECTORY/'client.csr'),'-CA',str(DIRECTORY/'ca.pem'),
             '-CAkey',str(DIRECTORY/'ca-key.pem'),'-passin','stdin','-set_serial','0x'+secrets.token_hex(16),
             '-extfile',str(extensions),'-out',str(DIRECTORY/'client.pem')],input=password+b'\n')
        (DIRECTORY/'client.csr').unlink();extensions.unlink()
    run([OPENSSL,'verify','-CAfile',str(DIRECTORY/'ca.pem'),str(DIRECTORY/'client.pem')])
    run([OPENSSL,'x509','-checkend','2592000','-noout','-in',str(DIRECTORY/'client.pem')])
    return DIRECTORY
