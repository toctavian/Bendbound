#!/usr/bin/env python3
"""Five-hour local continuation check. No model request is used to read usage."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import selectors
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'automation' / '.state'


def usage_allowed(snapshot):
    # The backend's explicit permission is authoritative. A clock reset or a
    # guessed remaining percentage is NOT permission to start more work.
    quota = snapshot.get('rateLimits') or {}
    if quota.get('spendControlReached') is True:
        return False
    reached = quota.get('rateLimitReachedType')
    if reached and reached != 'rate_limit_reached':
        return False
    if snapshot.get('ordinaryUsageAllowed') is True:
        return True
    credits = quota.get('credits') or {}
    return credits.get('hasCredits') is True or credits.get('unlimited') is True


class RPC:
    def __init__(self, executable):
        self.process = subprocess.Popen([executable, 'app-server', '--listen', 'stdio://'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b''
        self.counter = 0
        self.call('initialize', {'clientInfo': {'name': 'bendbound-continuation', 'version': '1.0.0'},
                                 'capabilities': {'experimentalApi': True}})

    def call(self, method, params=None):
        self.counter += 1
        self.process.stdin.write((json.dumps({'id': self.counter, 'method': method, 'params': params or {}}) + '\n').encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                message = json.loads(line)
                if message.get('id') == self.counter:
                    if 'error' in message:
                        raise RuntimeError(f'{method} failed; check Codex login/service status')
                    return message['result']
            if not self.selector.select(1):
                continue
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('Codex app-server disconnected')
            self.buffer += chunk
        raise TimeoutError(method)

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
        self.selector.close()


def run(config, dry_run=False):
    if not config.get('enabled'):
        return 'disabled'
    pending = [item for item in config.get('work', []) if item.get('status') == 'pending']
    if not pending:
        return 'no runnable unfinished work'
    rpc = RPC(config['codex'])
    try:
        usage = rpc.call('account/rateLimits/read')
        if not usage_allowed(usage):
            return 'usage unavailable or exhausted; retry at next five-hour check'
        turns = rpc.call('thread/turns/list', {'threadId': config['threadId'], 'limit': 1, 'sortDirection': 'desc'})
        latest = (turns.get('data') or [None])[0]
        # Missing history is not a safe reason to create another session.
        if latest is None or latest.get('status') == 'inProgress':
            return 'thread active or status unavailable; skipped'
        if latest.get('status') == 'interrupted':
            return 'thread interrupted; wait for explicit user resume'
        if dry_run:
            return 'usage available; would resume pending work (dry run)'
    finally:
        rpc.close()
    prompt = ('Scheduled five-hour continuation authorised by the user. Read automation/.state/continuation.json '
              'and docs/routing-progress.md. Continue only pending authorised Bendbound work. Respect newer user '
              'instructions. Do not resume blocked, cancelled or completed work. Mark completed items done and '
              'external blockers blocked in that state file. Do not deploy to a paid host without its deployment '
              'details. If nothing remains, stop. Pending items: ' + '; '.join(item['description'] for item in pending))
    # Explicit thread ID; never --last. Inherit the user's existing permissions.
    with open(STATE / 'last-run.log', 'w') as log:
        result = subprocess.run([config['codex'], 'exec', 'resume', '--json', config['threadId'], prompt],
                                cwd=ROOT, stdout=log, stderr=log, timeout=14400)
    return f'continuation exited {result.returncode}'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True)
    with open(STATE / 'check.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            config = json.loads((STATE / 'continuation.json').read_text())
            message = run(config, args.dry_run)
        except Exception as error:
            message = f'check failed ({type(error).__name__}); no automatic retry until next interval'
        # Never log raw account IDs, balances, credentials or usage responses.
        print(time.strftime('%Y-%m-%d %H:%M:%S'), message, flush=True)


if __name__ == '__main__':
    main()
