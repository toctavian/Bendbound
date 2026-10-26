"""Use the configured AWS MCP transport; never bypass it with CLI resource calls."""
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
import tomllib


class AwsMcp:
    def __init__(self):
        self.profile = os.environ.get('BENDBOUND_RESEARCH_AWS_PROFILE', 'bendbound')
        if self.profile not in {'bendbound', 'bendbound-research'}:
            raise ValueError('Unapproved ratings AWS profile')
        self.process = None
        self.serial = 1

    def close(self):
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None

    def rpc(self, method, params):
        self.serial += 1
        ident = self.serial
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': ident,
                                            'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        deadline = time.monotonic() + 120
        while True:
            msg = self.messages.get(timeout=max(.01, deadline - time.monotonic()))
            if msg is None or 'error' in msg:
                raise ConnectionError('AWS MCP transport failed')
            if msg.get('id') == ident:
                return msg['result']

    def connect(self):
        config = tomllib.loads((Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
                                / 'config.toml').read_text())['mcp_servers']['aws-mcp']
        env = {k: v for k, v in os.environ.items() if k in
               {'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME'}}
        env.update(config.get('env', {}))
        # The scheduled transport exposes only its machine identity. Manual MCP
        # configuration stays untouched and keeps the browser-login profile.
        env['AWS_MCP_PROXY_PROFILES'] = self.profile
        self.process = subprocess.Popen([config['command'], *config.get('args', [])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, env=env)
        self.messages = queue.Queue()
        process, messages = self.process, self.messages

        def read():
            for line in process.stdout:
                try:
                    messages.put(json.loads(line))
                except ValueError:
                    pass
            messages.put(None)

        threading.Thread(target=read, daemon=True).start()
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                              'clientInfo': {'name': 'bendbound-ratings-publisher', 'version': '1'}})
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
        self.process.stdin.flush()

    def renew_login(self):
        self.close()
        if self.profile == 'bendbound-research':
            # A fresh transport re-runs credential_process, obtaining new temporary
            # credentials. Never silently escalate to the manual/admin identity.
            print('Renewing scheduled machine credentials; no browser login.', flush=True)
            return
        print('AWS access failed; attempting fresh bendbound London browser login.', flush=True)
        try:
            result = subprocess.run(['aws', 'login', '--profile', 'bendbound', '--region', 'eu-west-2'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=240)
        except subprocess.TimeoutExpired:
            raise ConnectionError('AWS browser login needs completion; ratings unchanged') from None
        if result.returncode:
            raise ConnectionError('AWS login failed; diagnose the fresh browser flow')

    def tool(self, name, arguments):
        for attempt in range(2):
            try:
                if self.process is None:
                    self.connect()
                result = self.rpc('tools/call', {'name': name, 'arguments': arguments})
                if result.get('isError'):
                    raise ConnectionError('AWS MCP tool access failed')
                data = result.get('structuredContent')
                if data is None:
                    data = json.loads(next(c['text'] for c in result['content'] if c['type'] == 'text'))
                if data.get('status') in {'error', 'failed'}:
                    raise ConnectionError('AWS MCP resource access failed')
                if isinstance(data.get('result'), list) and any(isinstance(x, dict) and 'error' in x for x in data['result']):
                    raise ConnectionError('AWS MCP transfer access failed')
                return data
            except (ConnectionError, queue.Empty, KeyError, ValueError, OSError):
                self.close()
                if attempt:
                    raise ConnectionError('AWS MCP unavailable after credential recovery for '+self.profile) from None
                self.renew_login()

    def script(self, code):
        data = self.tool('aws___run_script', {'code': code})
        if data.get('status') != 'success' or not data.get('api_calls'):
            raise RuntimeError('AWS MCP did not confirm resource execution')
        return data['return_value']

    def signed(self, bucket, key, operation):
        data = self.tool('aws___get_presigned_url', {'requests': [
            {'bucket': bucket, 'key': key, 'operation': operation,
             'region': 'eu-west-2', 'expires_in': 900}]})
        return data['result'][0]['url']
