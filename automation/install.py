#!/usr/bin/env python3
"""Install a per-user macOS LaunchAgent. No sudo and no credit purchases."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
state = root / 'automation' / '.state'
label = 'com.bendbound.continue-work'
parser = argparse.ArgumentParser()
parser.add_argument('--thread', required=True)
args = parser.parse_args()
codex = shutil.which('codex')
if not codex:
    raise SystemExit('Install and sign in to Codex CLI first.')
state.mkdir(parents=True, exist_ok=True)
config = state / 'continuation.json'
if not config.exists():
    config.write_text(json.dumps({'enabled': True, 'threadId': args.thread, 'codex': codex, 'work': [
        {'description': 'Complete self-hosted Valhalla pilot, GraphHopper benchmark, tests and EC2 instructions', 'status': 'pending'}
    ]}, indent=2) + '\n')
plist = Path.home() / 'Library' / 'LaunchAgents' / f'{label}.plist'
plist.parent.mkdir(parents=True, exist_ok=True)
definition = {'Label': label, 'ProgramArguments': [sys.executable, str(root / 'automation/check_usage.py')],
              'WorkingDirectory': str(root), 'StartInterval': 18000, 'RunAtLoad': False,
              'StandardOutPath': str(state / 'checks.log'), 'StandardErrorPath': str(state / 'checks.log'),
              'EnvironmentVariables': {'PATH': f'{Path(codex).parent}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}}
with plist.open('wb') as f:
    plistlib.dump(definition, f)
domain = f'gui/{os.getuid()}'
subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], capture_output=True)
subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
print(f'Installed {label}: every 18,000 seconds while this Mac is awake and you are logged in.')
