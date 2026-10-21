#!/usr/bin/env python3
"""Review a verified pilot request; --approve explicitly provisions it via AWS MCP.
Requires Python >=3.11. Prints no credentials; defaults to a read-only review.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def invoke_mcp(code):
    config = tomllib.loads((Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml').read_text())['mcp_servers']['aws-mcp']
    env = os.environ.copy()
    env.update(config.get('env', {}))
    process = subprocess.Popen([config['command'], *config.get('args', [])], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    messages = queue.Queue()
    def reader():
        for line in process.stdout:
            try:
                messages.put(json.loads(line))
            except ValueError:
                pass
        messages.put(None)
    threading.Thread(target=reader, daemon=True).start()
    def call(identifier, method, params):
        process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params}) + '\n')
        process.stdin.flush()
        deadline = time.monotonic() + 90
        while True:
            message = messages.get(timeout=max(.01, deadline - time.monotonic()))
            if message is None or 'error' in message:
                raise ConnectionError('AWS MCP transport failed')
            if message.get('id') == identifier:
                return message.get('result')
    try:
        call(1, 'initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
            'clientInfo': {'name': 'bendbound-pilot-enrollment', 'version': '1.0.0'}})
        process.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
        process.stdin.flush()
        result = call(2, 'tools/call', {'name': 'aws___run_script', 'arguments': {'code': code}})
        data = result.get('structuredContent')
        if data is None:
            data = json.loads(next(item['text'] for item in result['content'] if item.get('type') == 'text'))
        if result.get('isError') or data.get('status') != 'success':
            summary = json.dumps(data).lower()
            if any(term in summary for term in ['accessdenied', 'expiredtoken', 'invalidclienttoken', 'unauthorized', 'authentication', 'unknown tool', 'invalidgrant']):
                raise ConnectionError('AWS authentication/MCP recovery required')
            raise RuntimeError('Enrollment was not applied. Review request expiry, mappings, account ownership and lifecycle holds; no automatic overwrite is permitted.')
        return data['return_value']
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True, help='Full reference shown by the verified native login')
    parser.add_argument('--days', type=int, choices=range(1, 8), default=1)
    parser.add_argument('--approve', action='store_true', help='Explicitly approve this matched tester; review is read-only by default')
    args = parser.parse_args()
    if len(args.request) != 64 or any(c not in '0123456789abcdef' for c in args.request):
        parser.error('request must be 64 lowercase hexadecimal characters')
    manifest = json.loads((ROOT / 'docs/group-identity-deployment.json').read_text())
    payload = {'requestId': args.request, 'days': args.days, 'approve': args.approve}
    params = {'FunctionName': manifest['nativeAppleEnrollmentOperatorFunctionName'], 'Payload': json.dumps(payload)}
    code = ("response = await call_boto3(service_name='lambda', operation_name='Invoke', region_name='eu-west-2', params="
        + repr(params) + ")\npayload = response.get('Payload')\n"
        + "result = json.loads(payload) if isinstance(payload, str) else payload\nresult")
    try:
        result = invoke_mcp(code)
    except (ConnectionError, queue.Empty, KeyError, OSError, ValueError):
        print('AWS MCP access failed. Renewing the Bendbound login before retrying the configured connection.', file=sys.stderr)
        completed = subprocess.run(['aws', 'login', '--profile', 'bendbound', '--region', 'eu-west-2'])
        if completed.returncode:
            raise SystemExit('AWS login did not complete. Diagnose the fresh browser error; do not reuse a failed link.')
        try:
            result = invoke_mcp(code)
        except (ConnectionError, queue.Empty, KeyError, OSError, ValueError):
            raise SystemExit('AWS login completed but the configured MCP connection still failed.')
    except RuntimeError as error:
        raise SystemExit(str(error))
    if not isinstance(result, dict) or result.get('status') not in ['review_required', 'approved', 'already_approved']:
        raise SystemExit('No approval confirmed. Review expiry, account ownership, conflicts and lifecycle holds; retry review before any further change.')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
