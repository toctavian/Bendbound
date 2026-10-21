#!/usr/bin/env python3
"""Install this specific daily workflow, without reviving the old work autopilot."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
LABEL = 'com.bendbound.route-research'
STATE = ROOT / 'routing/.data/research'
CODEX = Path('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')


def install():
    if not CODEX.is_file():
        raise RuntimeError('Stable bundled Codex CLI is missing; select a working CLI path first.')
    timezone = Path('/etc/localtime').resolve()
    if not str(timezone).endswith('Europe/London'):
        raise RuntimeError('Mac calendar timezone must be Europe/London for the requested 06:00 schedule.')
    STATE.mkdir(parents=True, exist_ok=True)
    plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    plist.parent.mkdir(parents=True, exist_ok=True)
    data = {
        'Label': LABEL,
        'ProgramArguments': ['/usr/bin/python3', str(ROOT / 'routing/catalogue/research/run_daily.py'), '--codex', str(CODEX)],
        'WorkingDirectory': str(ROOT),
        'StartCalendarInterval': {'Hour': 6, 'Minute': 0},
        'RunAtLoad': False,
        'ProcessType': 'Background',
        'StandardOutPath': str(STATE / 'scheduler.stdout.log'),
        'StandardErrorPath': str(STATE / 'scheduler.stderr.log'),
        'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                                 'TZ': 'Europe/London', 'PYTHONUNBUFFERED': '1'},
    }
    domain = 'gui/' + str(os.getuid())
    existing = subprocess.run(['launchctl', 'print', domain + '/' + LABEL], capture_output=True)
    if existing.returncode == 0:
        subprocess.run(['launchctl', 'bootout', domain + '/' + LABEL], check=True)
    temporary = plist.with_suffix('.tmp')
    temporary.write_bytes(plistlib.dumps(data))
    temporary.chmod(0o600)
    temporary.replace(plist)
    subprocess.run(['plutil', '-lint', str(plist)], check=True)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    subprocess.run(['launchctl', 'print', domain + '/' + LABEL], check=True)
    print('Installed 06:00 Europe/London daily; not run at install. Mac must be on; missed calendar jobs can run on wake.')


if __name__ == '__main__':
    try:
        install()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
