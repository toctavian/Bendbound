"""Read geometry from the exact pinned Valhalla tiles; never load a second road map."""
import hashlib
import json
import os
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, HTTPServer
from valhalla.baldr import GraphId
from valhalla.baldr.utils import GraphUtils

CONFIG = os.environ.get('VALHALLA_CONFIG', '/data/valhalla.json')
with open(CONFIG) as f:
    config = json.load(f)
config['mjolnir']['max_cache_size'] = int(os.environ.get('GRAPH_TILE_CACHE_MB', '64')) * 1024 * 1024
config['mjolnir']['use_lru_mem_cache'] = True
config['mjolnir']['lru_mem_cache_hard_control'] = True
reader = GraphUtils(config)
digest = hashlib.sha256()
with open(config['mjolnir']['tile_extract'], 'rb') as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b''):
        digest.update(chunk)
graph_version = digest.hexdigest()

@lru_cache(maxsize=4096)
def edge_geometry(edge_id):
    if not isinstance(edge_id, str) or not edge_id.isdigit():
        raise ValueError('Invalid graph edge ID')
    shape = [[round(lon, 6), round(lat, 6)] for lon, lat in reader.get_edge_shape(GraphId(int(edge_id)))]
    if len(shape) < 2:
        raise ValueError('Empty edge geometry')
    reverse = list(reversed(shape))
    flipped = reverse < shape
    canonical = reverse if flipped else shape
    physical_id = hashlib.sha256(json.dumps(canonical, separators=(',', ':')).encode()).hexdigest()
    return {'edgeId': edge_id, 'physicalId': physical_id, 'flipped': flipped, 'coordinates': shape}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # No coordinates or request bodies in operational logs.

    def send(self, status, payload):
        data = json.dumps(payload, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            self.send(200, {'status': 'ready', 'graphVersion': graph_version})
        else:
            self.send(404, {'code': 'NOT_FOUND'})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if self.path != '/edges' or length <= 0 or length > 262144:
                return self.send(400, {'code': 'INVALID_REQUEST'})
            body = json.loads(self.rfile.read(length))
            if body.get('graphVersion') != graph_version:
                return self.send(409, {'code': 'GRAPH_VERSION_MISMATCH'})
            ids = body.get('edgeIds')
            if not isinstance(ids, list) or not 1 <= len(ids) <= 4096:
                return self.send(400, {'code': 'INVALID_REQUEST'})
            self.send(200, {'graphVersion': graph_version, 'edges': [edge_geometry(i) for i in ids]})
        except Exception as error:
            print(json.dumps({'event': 'graph.lookup_failed', 'errorType': type(error).__name__}), flush=True)
            self.send(502, {'code': 'ROAD_IDENTITY'})

if __name__ == '__main__':
    print(json.dumps({'event': 'graph.started', 'graphVersion': graph_version}), flush=True)
    HTTPServer(('0.0.0.0', 8003), Handler).serve_forever()
