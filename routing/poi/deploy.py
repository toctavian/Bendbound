"""Execute through AWS MCP/SSM as root after copying a reviewed release bundle."""
import datetime
import json
import pathlib
import shutil
import subprocess
import sys
import urllib.request


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        # Do not emit environment, Docker config or process output containing secrets.
        raise RuntimeError('Command failed: ' + args[0])
    return result.stdout.strip()


def main():
    release = pathlib.Path(sys.argv[1]).resolve()
    root = pathlib.Path('/opt/bendbound')
    caddy = root / 'routing/catalogue/Caddyfile'
    if not caddy.exists():
        raise RuntimeError('Expected catalogue Caddy configuration is missing')
    network = json.loads(run('docker', 'network', 'inspect', 'bendbound-catalogue_default'))[0]
    if network['IPAM']['Config'][0]['Gateway'] != '172.18.0.1':
        raise RuntimeError('Docker gateway differs from the reviewed service configuration')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = root / 'backups' / ('poi-' + stamp)
    backup.mkdir(parents=True, exist_ok=False)
    shutil.copy2(caddy, backup / 'Caddyfile')
    service_root = root / 'poi'
    if service_root.exists():
        shutil.copytree(service_root, backup / 'service')
    unit = pathlib.Path('/etc/systemd/system/bendbound-poi.service')
    if unit.exists():
        shutil.copy2(unit, backup / 'bendbound-poi.service')
    original_config = caddy.read_text()
    try:
        existing = subprocess.run(['id', '-u', 'bendbound-poi'], capture_output=True).returncode == 0
        if not existing:
            run('useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'bendbound-poi')
        run('runuser', '-u', 'bendbound-poi', '--', 'python3', '-c', 'import boto3')
        service_root.mkdir(parents=True, exist_ok=True)
        shutil.copy2(release / 'service.py', service_root / 'service.py')
        shutil.copy2(release / 'bendbound-poi.service', unit)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', 'bendbound-poi.service')
        run('systemctl', 'restart', 'bendbound-poi.service')
        import time
        for _ in range(15):
            try:
                with urllib.request.urlopen('http://172.18.0.1:8090/poi-health', timeout=2) as response:
                    json.load(response)
                break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError('POI service failed to start')
        # Keep the mounted inode; atomic rename would leave Caddy's bind mount
        # referencing the old configuration. Reload only after validation passes.
        caddy.write_text((release / 'Caddyfile').read_text())
        run('bash', '/opt/bendbound/routing/catalogue/compose-aws.sh', 'exec', '-T', 'caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
        run('bash', '/opt/bendbound/routing/catalogue/compose-aws.sh', 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
        print(json.dumps({'deployed': True, 'backup': str(backup), 'service': run('systemctl', 'is-active', 'bendbound-poi.service')}))
    except Exception:
        caddy.write_text(original_config)
        subprocess.run(['bash', '/opt/bendbound/routing/catalogue/compose-aws.sh', 'exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], capture_output=True)
        if (backup / 'service').exists():
            shutil.copytree(backup / 'service', service_root, dirs_exist_ok=True)
        if (backup / 'bendbound-poi.service').exists():
            shutil.copy2(backup / 'bendbound-poi.service', unit)
            subprocess.run(['systemctl', 'daemon-reload'], capture_output=True)
            subprocess.run(['systemctl', 'restart', 'bendbound-poi.service'], capture_output=True)
        else:
            subprocess.run(['systemctl', 'disable', '--now', 'bendbound-poi.service'], capture_output=True)
        print(json.dumps({'deployed': False, 'rollbackBackup': str(backup)}))
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'errorType': type(error).__name__}))
        sys.exit(1)
