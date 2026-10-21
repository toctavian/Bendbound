"""Smoke-test a running UK release; never print authentication or route geometry."""
import argparse
import json
import os
import time
import urllib.request


def verify(base):
    token = os.environ.get('ROUTING_SMOKE_TOKEN')

    def request(path, data=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(base.rstrip('/') + path,
                                     data=json.dumps(data).encode() if data else None,
                                     headers=headers)
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)

    health = request('/health')
    assert health['status'] == 'ready'
    assert health['area']['coverage'] == 'United Kingdom'
    graph = '8cc789c4ceb36866622af1a26b787f9b5515c40537b569b9beebcc069a93acd2'
    assert health['catalogue']['graph_version'] == graph
    cases = []
    for name, a, b, c, d in [
        ('London', 51.5074, -.1278, 51.55, -.17),
        ('England', 54.46, -3.08, 54.6, -3.14),
        ('Wales', 53, -3.9, 53.1, -3.8),
        ('Scotland', 57, -4.7, 57.2, -4.5),
        ('Northern Ireland', 54.6, -5.93, 54.65, -5.8),
    ]:
        start = time.monotonic()
        result = request('/route', {'costing': 'motorcycle', 'locations': [
            {'lat': a, 'lon': b}, {'lat': c, 'lon': d}]})
        assert result['trip']['summary']['length'] > 0
        cases.append({'area': name, 'km': result['trip']['summary']['length'],
                      'seconds': round(time.monotonic() - start, 2)})

    start = time.monotonic()
    result = request('/round-trip', {
        'center': {'latitude': 51.481, 'longitude': -.009},
        'targetKm': 20, 'direction': 90, 'profile': 'winding',
        'avoidMotorways': True, 'coneAngleDegrees': 120})
    planner = result['planner']
    assert planner['valid'] and planner['insideCone'] and planner['closed']
    assert planner['maxTraversals'] <= 2 and planner['repeatedRatio'] <= .1
    assert planner['identityVerification'] == 'valhalla-native-edges'
    assert planner['verifiedRatio'] > .999
    assert planner['area']['coverage'] == 'United Kingdom'
    cases.append({'type': 'strict-cone-round-trip',
                  'seconds': round(time.monotonic() - start, 2),
                  **{key: planner[key] for key in ['valid', 'distanceKm',
                     'insideCone', 'maxTraversals', 'repeatedRatio', 'verifiedRatio']}})
    return {'status': 'verified', 'graphVersion': graph, 'health': health, 'cases': cases}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base')
    parser.add_argument('--report')
    args = parser.parse_args()
    report = json.dumps(verify(args.base), indent=2) + '\n'
    if args.report:
        with open(args.report, 'w') as output:
            output.write(report)
    print(report, end='')
