#!/usr/bin/env python3
"""Call the project's configured AWS MCP via stdio. Python 3.11+.
Reads {tool, arguments} JSON from stdin. Credentials never enter source or output.
"""
import json, os, queue, subprocess, sys, threading, time, tomllib
from pathlib import Path

def invoke(tool, arguments):
    config = tomllib.loads((Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'config.toml').read_text())['mcp_servers']['aws-mcp']
    env = os.environ.copy(); env.update(config.get('env', {}))
    process = subprocess.Popen([config['command'], *config.get('args', [])], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    messages = queue.Queue()
    def reader():
        for line in process.stdout:
            try: messages.put(json.loads(line))
            except ValueError: pass
        messages.put(None)
    threading.Thread(target=reader, daemon=True).start()
    def call(identifier, method, params):
        process.stdin.write(json.dumps({'jsonrpc':'2.0','id':identifier,'method':method,'params':params})+'\n');process.stdin.flush()
        deadline=time.monotonic()+300
        while True:
            msg=messages.get(timeout=max(.01,deadline-time.monotonic()))
            if msg is None: raise ConnectionError('Configured AWS MCP disconnected')
            if msg.get('id')==identifier:
                if 'error' in msg: raise ConnectionError(json.dumps(msg['error']))
                return msg.get('result')
    try:
        call(1,'initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'bendbound-website','version':'1.0.0'}})
        process.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n');process.stdin.flush()
        return call(2,'tools/call',{'name':tool,'arguments':arguments})
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill();process.wait()
if __name__=='__main__':
    payload=json.load(sys.stdin)
    print(json.dumps(invoke(payload['tool'],payload.get('arguments',{}))))
