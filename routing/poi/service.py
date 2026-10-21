"""Bendbound POIs and Fuel Finder. Run as an EC2 host service, behind Caddy."""
import collections
import datetime as dt
import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FUEL_BASE = 'https://www.fuel-finder.service.gov.uk/api/v1'
DISCREPANCY = 'https://www.fuel-finder.service.gov.uk/motorist/price-report'
LICENCE = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/'
OVERPASS = ['https://overpass.openstreetmap.fr/api/interpreter', 'https://overpass-api.de/api/interpreter']
FILTERS = {
    'pass': ['["natural"="saddle"]', '["mountain_pass"="yes"]'],
    'meet': ['["amenity"~"cafe|pub|restaurant"]["name"~"Ace Caf|Squires|Loomies",i]'],
    'sight': ['["tourism"~"attraction|viewpoint"]', '["historic"]'],
    'forest': ['["natural"="wood"]["name"]', '["landuse"="forest"]["name"]'],
}
RADII = {'fuel': 15000, 'pass': 35000, 'meet': 60000, 'sight': 8000, 'forest': 10000}
VENUES = [(r'ace caf[eé]', 51.5406, -.2786, 'https://london.acecafe.com/monthly-meets/'),
          (r'squires', 53.782, -1.285, 'https://www.squires-cafe.co.uk/about/'),
          (r'loomies', 51.031, -1.075, 'https://www.loomiescafe.co.uk/')]
FOREST_ROADS = [
    {'id':'epping-a104','name':'Epping Forest','ref':'A104','center':(51.67,.05),
     'url':'https://www.essexhighways.org/highway-schemes-and-developments/highway-schemes/epping-forest-schemes/epping-new-road'},
    {'id':'dean-b4226','name':'Forest of Dean','ref':'B4226','center':(51.809,-2.558),
     'url':'https://www.forestryengland.uk/beechenhurst/activities'},
]
ROAD_TYPES = r'^(trunk|primary|secondary|tertiary|unclassified)$'


class ServiceError(Exception):
    def __init__(self, code, status=503, retry_after=None):
        self.code, self.status, self.retry_after = code, status, retry_after
        super().__init__(code)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def log(event, **fields):
    # Never log request bodies, URLs, headers, credentials or upstream error bodies.
    print(json.dumps({'event': event, 'at': iso(time.time()), **fields}), flush=True)


def iso(timestamp):
    return dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('Invalid timestamp')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    # Fuel Finder also publishes timestamps without a timezone; retain the raw
    # value for display and interpret it as UTC only for internal comparisons.
    return parsed.replace(tzinfo=dt.timezone.utc).timestamp() if parsed.tzinfo is None else parsed.timestamp()


def coordinate(lat, lon):
    lat, lon = float(lat), float(lon)
    if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 90 or abs(lon) > 180:
        raise ServiceError('INVALID_COORDINATE', 400)
    return lat, lon


def distance(a, b):
    p, q = math.radians(a[0]), math.radians(b[0])
    h = math.sin((q-p)/2)**2 + math.cos(p)*math.cos(q)*math.sin(math.radians(b[1]-a[1])/2)**2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(h)))


def http_json(url, body=None, headers=None, timeout=25):
    request = urllib.request.Request(url, data=body, headers={'User-Agent': 'Bendbound/1.1 (place-discovery)', **(headers or {})})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        retry = error.headers.get('Retry-After')
        raise ServiceError('UPSTREAM_HTTP_' + str(error.code), error.code, int(retry) if retry and retry.isdigit() else None) from None
    except (OSError, ValueError):
        raise ServiceError('UPSTREAM_UNAVAILABLE') from None


class FuelClient:
    def __init__(self, fetch=http_json, secret_loader=None, clock=time.time, sleep=time.sleep):
        self.fetch, self.clock, self.sleep = fetch, clock, sleep
        self.secret_loader = secret_loader or self.load_secret
        self.credentials = None
        self.secret_expires = self.token_expires = self.last_call = 0
        self.access_token = None
        self.calls = 0

    @staticmethod
    def load_secret():
        import boto3
        from botocore.config import Config
        client = boto3.client('secretsmanager', region_name=os.getenv('AWS_REGION', 'eu-west-2'),
                             config=Config(connect_timeout=5, read_timeout=15, retries={'max_attempts': 1}))
        value = client.get_secret_value(SecretId=os.environ['FUEL_FINDER_SECRET_ID'])
        return json.loads(value['SecretString'])

    def token(self, force=False):
        now = self.clock()
        if self.access_token and now < self.token_expires and not force:
            return self.access_token
        if not self.credentials or now >= self.secret_expires or force:
            self.credentials = self.secret_loader()
            if not all(isinstance(self.credentials.get(k), str) and self.credentials[k] for k in ('client_id', 'client_secret')):
                raise ServiceError('OAUTH_CONFIGURATION_INVALID')
            self.secret_expires = now + 3600
        auth = self.call('/oauth/generate_access_token', body=json.dumps({k: self.credentials[k] for k in ('client_id', 'client_secret')}).encode(),
                         headers={'Content-Type': 'application/json'})
        token = auth.get('data', {})
        if auth.get('success') is False or not token.get('access_token'):
            raise ServiceError('OAUTH_FAILED')
        self.access_token = token['access_token']
        self.token_expires = self.clock() + max(0, float(token.get('expires_in', 3600))-60)
        return self.access_token

    def call(self, path, **kwargs):
        # Official live limits: 100 requests/minute, one concurrent request.
        pause = .7 - (self.clock() - self.last_call)
        if pause > 0:
            self.sleep(pause)
        self.last_call = self.clock()
        self.calls += 1
        return self.fetch(FUEL_BASE + path, **kwargs)

    def page(self, path):
        token = self.token()
        try:
            return self.call(path, headers={'Authorization': 'Bearer ' + token})
        except ServiceError as error:
            if error.status not in (401, 403):
                raise
            token = self.token(force=True)
            return self.call(path, headers={'Authorization': 'Bearer ' + token})

    def fetch_all(self, path, since=None):
        all_rows = {}
        incremental = since is not None
        suffix = '&effective-start-timestamp=' + urllib.parse.quote(dt.datetime.fromtimestamp(since, dt.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')) if incremental else ''
        for batch in range(1, 101):
            rows = None
            for attempt in range(3):
                try:
                    payload = self.page(path + '?batch-number=' + str(batch) + suffix)
                except ServiceError as error:
                    if error.status == 404 and (batch > 1 or incremental):
                        return list(all_rows.values())
                    raise
                rows = payload if isinstance(payload, list) else payload.get('data') if isinstance(payload, dict) else None
                if not isinstance(rows, list):
                    raise ServiceError('INVALID_UPSTREAM_PAGE')
                if rows:
                    break
                # An empty 200 can be a transient response, not proof of end.
                self.sleep(attempt + 1)
            if not rows:
                raise ServiceError('EMPTY_UPSTREAM_PAGE')
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get('node_id'), str):
                    raise ServiceError('INVALID_UPSTREAM_RECORD')
                all_rows[row['node_id']] = row
            # Continue after short pages: provider order and page boundaries are
            # not a reliable end marker. Only a terminal 404 finishes ingestion.
        raise ServiceError('PAGINATION_LIMIT_EXCEEDED')


class FuelStore:
    def __init__(self, path, clock=time.time):
        self.path, self.clock = path, clock
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY,raw TEXT NOT NULL); CREATE TABLE IF NOT EXISTS prices (id TEXT PRIMARY KEY,raw TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS polls (started REAL,finished REAL,success INTEGER,site_count INTEGER,price_count INTEGER,api_calls INTEGER,error_code TEXT); CREATE TABLE IF NOT EXISTS postcode_centres (postcode TEXT PRIMARY KEY,raw TEXT,checked REAL);')

    def meta(self, key):
        with self.lock:
            value = self.db.execute('SELECT value FROM metadata WHERE key=?', (key,)).fetchone()
            return value[0] if value else None

    def commit(self, sites, prices, started, full):
        if full and (not sites or not prices):
            raise ServiceError('INCOMPLETE_BASELINE')
        for row in sites + prices:
            if not isinstance(row, dict) or not isinstance(row.get('node_id'), str):
                raise ServiceError('INVALID_UPSTREAM_RECORD')
        # Validate all price arrays before publishing any part of a cycle.
        if any(not isinstance(row.get('fuel_prices'), list) for row in prices):
            raise ServiceError('INVALID_UPSTREAM_PRICES')
        with self.lock, self.db:
            for table, rows in [('sites', sites), ('prices', prices)]:
                if full:
                    self.db.execute('DELETE FROM ' + table)
                for row in rows:
                    if not full:
                        previous = self.db.execute('SELECT raw FROM ' + table + ' WHERE id=?', (row['node_id'],)).fetchone()
                        if previous:
                            old = json.loads(previous[0])
                            merged = {**old, **row}
                            if table == 'prices':
                                grades = {p['fuel_type']: p for p in old.get('fuel_prices', [])}
                                for price in row['fuel_prices']:
                                    grades[price['fuel_type']] = {**grades.get(price['fuel_type'], {}), **price}
                                merged['fuel_prices'] = list(grades.values())
                            elif isinstance(row.get('location'), dict):
                                merged['location'] = {**(old.get('location') or {}), **row['location']}
                            row = merged
                    self.db.execute('INSERT OR REPLACE INTO ' + table + ' VALUES (?,?)', (row['node_id'], json.dumps(row)))
            self.db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('checkedAt', str(started)))
            self.db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('cursor', str(started)))
            if full:
                self.db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('fullAt', str(started)))

    def fresh(self):
        checked = float(self.meta('checkedAt') or 0)
        return 0 <= self.clock() - checked < 300

    def audit(self, started, success, sites=0, prices=0, calls=0, error=None):
        with self.lock, self.db:
            self.db.execute('INSERT INTO polls VALUES (?,?,?,?,?,?,?)', (started, self.clock(), int(success), sites, prices, calls, error))
            self.db.execute('DELETE FROM polls WHERE started<?', (self.clock()-90*86400,))
        log('fuel.sync.completed' if success else 'fuel.sync.failed', startedAt=iso(started), sites=sites, prices=prices, apiCalls=calls, errorCode=error)

    def health(self):
        with self.lock:
            counts = {table: self.db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in ('sites', 'prices')}
            successes = [row[0] for row in self.db.execute('SELECT started FROM polls WHERE success=1 AND started>? ORDER BY started', (self.clock()-86400,))]
            attempts = self.db.execute('SELECT count(*),sum(success) FROM polls WHERE started>?', (self.clock()-86400,)).fetchone()
        gaps = [b-a for a, b in zip(successes, successes[1:])]
        checked = float(self.meta('checkedAt') or 0)
        return {'status': 'ready' if self.fresh() else 'syncing' if not checked else 'stale', 'checkedAt': iso(checked) if checked else None,
                'stations': counts['sites'], 'priceRecords': counts['prices'], 'pollIntervalSeconds': 240,
                'last24Hours': {'attempts': attempts[0], 'successes': attempts[1] or 0,
                                'averageSuccessfulGapSeconds': sum(gaps)/len(gaps) if gaps else None,
                                'maximumSuccessfulGapSeconds': max(gaps) if gaps else None}}

    def validate_locations(self, rows):
        # A live provider record was found with a Lancashire postcode and London
        # coordinates. Check postcode consistency objectively for every supplier;
        # retain all original records/prices and never invent replacement pins.
        postcodes = sorted({re.sub(r'\s+', '', str((row.get('location') or {}).get('postcode', ''))).upper() for row in rows})
        with self.lock:
            cached = {row[0]: json.loads(row[1]) if row[1] else None for row in self.db.execute('SELECT postcode,raw FROM postcode_centres WHERE checked>?', (self.clock()-30*86400,))}
        missing = [p for p in postcodes if p and p not in cached]
        for offset in range(0, len(missing), 100):
            data = http_json('https://api.postcodes.io/postcodes', json.dumps({'postcodes': missing[offset:offset+100]}).encode(), {'Content-Type': 'application/json'}, timeout=8)
            if not isinstance(data.get('result'), list):
                raise ServiceError('GEO_VALIDATION_UNAVAILABLE')
            with self.lock, self.db:
                for item in data['result']:
                    key = re.sub(r'\s+', '', item['query']).upper()
                    value = item.get('result')
                    cached[key] = value
                    self.db.execute('INSERT OR REPLACE INTO postcode_centres VALUES (?,?,?)', (key, json.dumps(value) if value else None, self.clock()))
        valid = []
        for row in rows:
            loc = row.get('location') or {}
            key = re.sub(r'\s+', '', str(loc.get('postcode', ''))).upper()
            centre = cached.get(key)
            if centre is not None and centre.get('latitude') is not None and centre.get('longitude') is not None:
                try:
                    if distance(coordinate(loc.get('latitude'), loc.get('longitude')), coordinate(centre['latitude'], centre['longitude'])) > 5000:
                        continue
                except (ValueError, TypeError, ServiceError):
                    continue
            valid.append(row)
        return valid

    def nearby(self, center, radius):
        if not self.meta('checkedAt'):
            raise ServiceError('FUEL_SYNCING')
        with self.lock:
            rows = [json.loads(row[0]) for row in self.db.execute('SELECT raw FROM sites')]
        found = []
        for site in rows:
            loc = site.get('location') or {}
            try:
                pos = coordinate(loc.get('latitude'), loc.get('longitude'))
            except (TypeError, ValueError, ServiceError):
                continue
            metres = distance(center, pos)
            if metres > radius:
                continue
            closure = 'Permanently closed' if site.get('permanent_closure') else 'Temporarily closed' if site.get('temporary_closure') else 'Fuel station'
            found.append((metres, site, {'id': 'fuel-finder-' + site['node_id'], 'fuelStationId': site['node_id'], 'name': site.get('trading_name') or site.get('brand_name') or 'Fuel station',
                                  'category': 'fuel', 'latitude': pos[0], 'longitude': pos[1], 'detail': ' · '.join(filter(None, [closure, loc.get('address_line_1'), loc.get('postcode')])),
                                  'source': 'Fuel Finder'}))
        found = sorted(found, key=lambda pair: (pair[0], pair[2]['id']))
        valid_ids = {row['node_id'] for row in self.validate_locations([site for _, site, _ in found[:160]])}
        return [point for _, site, point in found[:160] if site['node_id'] in valid_ids][:80]

    def corridor_elements(self, route):
        points = [coordinate(p['latitude'], p['longitude']) for p in route]
        min_lat, max_lat = min(p[0] for p in points)-.003, max(p[0] for p in points)+.003
        min_lon, max_lon = min(p[1] for p in points)-.01, max(p[1] for p in points)+.01
        with self.lock:
            rows = [json.loads(row[0]) for row in self.db.execute('SELECT raw FROM sites')]
        candidates = []
        for site in rows:
            loc = site.get('location') or {}
            try:
                pos = coordinate(loc.get('latitude'), loc.get('longitude'))
            except (ValueError, TypeError, ServiceError):
                continue
            if not min_lat <= pos[0] <= max_lat or not min_lon <= pos[1] <= max_lon:
                continue
            scale = math.cos(math.radians(pos[0]))
            for start, end in zip(points, points[1:]):
                dx, dy = (end[1]-start[1])*scale, end[0]-start[0]
                length = dx*dx+dy*dy
                fraction = max(0, min(1, ((pos[1]-start[1])*scale*dx+(pos[0]-start[0])*dy)/length)) if length else 0
                nearest = (start[0]+dy*fraction, start[1]+(end[1]-start[1])*fraction)
                if distance(pos, nearest) <= 250:
                    candidates.append((site, {'id': site['node_id'], 'type': 'fuel-finder', 'lat': pos[0], 'lon': pos[1],
                                    'tags': {'name': site.get('trading_name') or site.get('brand_name') or 'Fuel station',
                                             'amenity': 'fuel', 'fuel_station_id': site['node_id']}}))
                    break
        valid_ids = {row['node_id'] for row in self.validate_locations([site for site, _ in candidates])}
        return [element for site, element in candidates if site['node_id'] in valid_ids]

    def snapshot(self, station_id):
        if not self.fresh():
            raise ServiceError('FUEL_PRICES_STALE')
        with self.lock:
            site = self.db.execute('SELECT raw FROM sites WHERE id=?', (station_id,)).fetchone()
            row = self.db.execute('SELECT raw FROM prices WHERE id=?', (station_id,)).fetchone()
            checked = float(self.meta('checkedAt'))
        if not site or not row:
            raise ServiceError('STATION_NOT_FOUND', 404)
        site, row = json.loads(site[0]), json.loads(row[0])
        loc = site.get('location') or {}
        pos = coordinate(loc.get('latitude'), loc.get('longitude'))
        entries = row['fuel_prices']
        if not entries:
            raise ServiceError('NO_PUBLISHED_PRICES', 404)
        prices = []
        updates = []
        for entry in entries:
            amount, updated = entry.get('price'), entry.get('price_last_updated')
            # Missing grades are explicit unavailable values, not silently removed.
            if amount is not None:
                try:
                    if not math.isfinite(float(amount)) or float(amount) <= 0 or timestamp(updated) > checked + 60:
                        raise ValueError()
                except (TypeError, ValueError):
                    raise ServiceError('INVALID_PUBLISHED_PRICE') from None
            if updated:
                try:
                    updates.append((timestamp(updated), updated))
                except ValueError:
                    raise ServiceError('INVALID_PUBLISHED_TIMESTAMP') from None
            prices.append({'fuel': entry.get('fuel_type'), 'amount': amount, 'updatedAt': updated,
                           'effectiveAt': entry.get('price_change_effective_timestamp')})
        # The API may omit site-update metadata. Do not invent an upstream site
        # timestamp: use the latest original price timestamp and label its basis.
        latest = max(updates, default=(0, None))[1]
        return {'stationId': station_id, 'name': site.get('trading_name'), 'latitude': pos[0], 'longitude': pos[1],
                'checkedAt': iso(checked), 'updatedAt': latest, 'updatedAtBasis': 'latest-price-update',
                'source': 'Fuel Finder', 'currency': 'GBP', 'unit': 'pence/litre', 'prices': prices,
                'reportUrl': DISCREPANCY, 'licenceUrl': LICENCE}


def sync_once(store, client):
    started = client.clock()
    cursor = store.meta('cursor')
    full = not cursor or started-float(store.meta('fullAt') or 0) >= 3600
    since = None if full else float(cursor)-60
    initial_calls = client.calls
    log('fuel.sync.started', full=full, since=iso(since) if since else None)
    try:
        prices = client.fetch_all('/pfs/fuel-prices', since)
        sites = client.fetch_all('/pfs', since)
        store.commit(sites, prices, started, full)
        store.audit(started, True, len(sites), len(prices), client.calls-initial_calls)
    except Exception as error:
        code = error.code if isinstance(error, ServiceError) else type(error).__name__
        store.audit(started, False, calls=client.calls-initial_calls, error=code)
        raise


def poll(store, client, stop):
    failures = 0
    while not stop.is_set():
        started = time.monotonic()
        wait = 240
        try:
            sync_once(store, client)
            failures = 0
        except Exception as error:
            failures += 1
            wait = max(300, error.retry_after or 0) if isinstance(error, ServiceError) and error.status in (403, 429) else min(240, 30 * 2**min(failures-1, 3))
        stop.wait(max(1, wait-(time.monotonic()-started)))


class Cache:
    def __init__(self):
        self.values = collections.OrderedDict()
        self.lock = threading.Lock()
        self.work = threading.Semaphore(2)

    def get(self, key, loader, ttl=300):
        with self.lock:
            item = self.values.get(key)
            if item and item[0] > time.time():
                return item[1]
        if not self.work.acquire(timeout=1):
            raise ServiceError('POI_BUSY', 429)
        try:
            with self.lock:
                item = self.values.get(key)
                if item and item[0] > time.time():
                    return item[1]
            value = loader()
            with self.lock:
                self.values[key] = (time.time()+ttl, value)
                while len(self.values) > 256:
                    self.values.popitem(last=False)
            return value
        finally:
            self.work.release()


def overpass(query):
    for provider, endpoint in enumerate(OVERPASS):
        try:
            value = http_json(endpoint, urllib.parse.urlencode({'data': query}).encode(), {'Content-Type': 'application/x-www-form-urlencoded'}, timeout=25)
            if not isinstance(value.get('elements'), list) or value.get('remark'):
                log('poi.lookup.incomplete', provider=provider)
                continue
            return value['elements']
        except ServiceError as error:
            log('poi.lookup.failed', provider=provider, errorCode=error.code)
            continue
    raise ServiceError('POI_UPSTREAM_UNAVAILABLE')


def mapped_poi(element, category):
    tags = element.get('tags') or {}
    center = element.get('center') or {}
    try:
        lat, lon = coordinate(element.get('lat', center.get('lat')), element.get('lon', center.get('lon')))
    except (ValueError, TypeError, ServiceError):
        return None
    url = None
    if category == 'meet':
        venue = next((v for v in VENUES if re.search(v[0], tags.get('name', ''), re.I) and abs(lat-v[1]) < .015 and abs(lon-v[2]) < .02), None)
        if not venue:
            return None
        url = venue[3]
    wiki = tags.get('wikipedia', '')
    match = re.fullmatch(r'([a-z-]+):(.+)', wiki)
    if match and not url:
        url = 'https://' + match[1] + '.wikipedia.org/wiki/' + urllib.parse.quote(match[2])
    if category == 'sight' and not url:
        url = 'https://www.openstreetmap.org/' + element['type'] + '/' + str(element['id'])
    image = tags.get('image')
    commons = tags.get('wikimedia_commons', '')
    if commons.startswith('File:'):
        image = 'https://commons.wikimedia.org/wiki/Special:FilePath/' + urllib.parse.quote(commons[5:]) + '?width=400'
    if not image or not image.startswith('https://'):
        image = None
    detail = 'Regular biker gathering venue' if category == 'meet' else next((tags[k] for k in ['description', 'tourism', 'amenity', 'historic', 'natural', 'landuse'] if tags.get(k)), category).replace('_', ' ')
    return {'id': element['type'] + '-' + str(element['id']), 'latitude': lat, 'longitude': lon, 'category': category,
            'name': tags.get('name') or tags.get('brand') or category.capitalize(), 'detail': detail,
            'imageUrl': image, 'moreUrl': url, 'wikipedia': wiki or None, 'source': 'OpenStreetMap'}


def closed_rings(pieces):
    pending = [list(piece) for piece in pieces if len(piece) >= 2]
    rings = []
    while pending:
        ring = pending.pop()
        while ring[0] != ring[-1]:
            match = next(((i, False) for i, piece in enumerate(pending) if piece[0] == ring[-1]), None)
            if match is None:
                match = next(((i, True) for i, piece in enumerate(pending) if piece[-1] == ring[-1]), None)
            if match is None:
                break
            i, reverse = match
            piece = pending.pop(i)
            ring.extend((list(reversed(piece)) if reverse else piece)[1:])
        if len(ring) >= 4 and ring[0] == ring[-1]:
            rings.append(ring)
    return rings


def in_ring(point, ring):
    result = False
    for a, b in zip(ring, ring[1:]):
        if (a['lat'] > point['lat']) != (b['lat'] > point['lat']) and point['lon'] < (b['lon']-a['lon'])*(point['lat']-a['lat'])/(b['lat']-a['lat'])+a['lon']:
            result = not result
    return result


def forest_rings(forest):
    if forest.get('type') == 'relation':
        members = forest.get('members', [])
        outer = closed_rings([m.get('geometry', []) for m in members if m.get('role', '') in ('outer', '')])
        inner = closed_rings([m.get('geometry', []) for m in members if m.get('role') == 'inner'])
    else:
        outer = closed_rings([forest.get('geometry') or []])
        inner = []
    return outer, inner


def forest_size(forest):
    outer, inner = forest_rings(forest)
    def area(ring):
        scale = math.cos(math.radians(sum(p['lat'] for p in ring)/len(ring)))
        return abs(sum(a['lon']*b['lat']-b['lon']*a['lat'] for a,b in zip(ring,ring[1:]))) * .5 * 111000**2 * scale
    return sum(area(r) for r in outer)-sum(area(r) for r in inner)


def forest_pois(elements):
    def road_allowed(element):
        tags = element.get('tags') or {}
        return re.fullmatch(ROAD_TYPES, tags.get('highway', '')) and tags.get('noexit') != 'yes' and not any(tags.get(k) in ('no', 'private', 'agricultural', 'forestry', 'destination', 'customers') for k in ('access', 'vehicle', 'motor_vehicle', 'motorcycle')) and tags.get('surface') not in ('unpaved', 'gravel', 'dirt', 'ground', 'sand', 'mud')
    roads = [road for road in elements if road_allowed(road)]
    landscape = [forest_rings(f) for f in elements if (f.get('tags', {}).get('natural') == 'wood' or f.get('tags', {}).get('landuse') == 'forest') and forest_size(f) >= 250000]
    def wooded(point):
        return any(any(in_ring(point, ring) for ring in outer) and not any(in_ring(point, ring) for ring in inner) for outer, inner in landscape)
    results = []
    for forest in elements:
        tags = forest.get('tags') or {}
        if not tags.get('name') or not (tags.get('natural') == 'wood' or tags.get('landuse') == 'forest'):
            continue
        outer, inner = forest_rings(forest)
        # Exclude pocket woods/copses and neighbourhood streets that merely
        # brush a park boundary. At least 25 hectares of named woodland.
        if not outer or forest_size(forest) < 250000:
            continue
        def inside(point):
            return any(in_ring(point, ring) for ring in outer) and not any(in_ring(point, ring) for ring in inner)
        for road in roads:
            def through_woodland(point):
                if inside(point):
                    return True
                # OSM wood polygons often stop at road edges. A real forest
                # road can occupy a narrow polygon gap: verify woodland on
                # opposing sides, not just a road passing one park edge.
                latitude_step = 40/111000
                longitude_step = latitude_step/max(.1, math.cos(math.radians(point['lat'])))
                for dx, dy in ((1,0),(0,1),(.707,.707),(.707,-.707)):
                    a = {'lat':point['lat']+dy*latitude_step,'lon':point['lon']+dx*longitude_step}
                    b = {'lat':point['lat']-dy*latitude_step,'lon':point['lon']-dx*longitude_step}
                    if (inside(a) or inside(b)) and wooded(a) and wooded(b):
                        return True
                return False
            vertex = next((p for p in road.get('geometry', []) if through_woodland(p)), None)
            if vertex:
                poi = mapped_poi({**forest, **vertex}, 'forest')
                if poi:
                    poi['detail'] = 'Public road through forest' + (' · ' + road['tags']['name'] if road['tags'].get('name') else '')
                    results.append(poi)
                break
    return results


def reviewed_forest_roads(center, radius):
    candidates = [forest for forest in FOREST_ROADS if distance(center,forest['center']) <= radius+2000]
    if not candidates:
        return []
    query = '[out:json][timeout:15];(' + ''.join('way["ref"="%s"](around:2000,%.6f,%.6f);' % (forest['ref'],*forest['center']) for forest in candidates) + ');out geom 80;'
    roads = overpass(query)
    results = []
    for forest in candidates:
        vertices = []
        for road in roads:
            tags = road.get('tags') or {}
            if tags.get('ref') != forest['ref'] or not re.fullmatch(ROAD_TYPES,tags.get('highway','')):
                continue
            if any(tags.get(key) in ('no','private','agricultural','forestry','destination','customers') for key in ('access','vehicle','motor_vehicle','motorcycle')):
                continue
            vertices.extend(road.get('geometry', []))
        if vertices:
            point = min(vertices,key=lambda p:distance(forest['center'],(p['lat'],p['lon'])))
            if distance(center,(point['lat'],point['lon'])) <= radius:
                results.append({'id':'forest-road-'+forest['id'],'name':forest['name'],'category':'forest','latitude':point['lat'],'longitude':point['lon'],
                                'detail':'Public road through forest · '+forest['ref'],'moreUrl':forest['url'],'source':'Reviewed forest road with OpenStreetMap road geometry'})
    return results


def nearby_pois(category, center, radius):
    if category == 'meet':
        names = ['Ace Cafe London', 'Squires Biker Cafe', 'Loomies Moto Cafe']
        return [{'id': 'biker-venue-' + str(i), 'category': 'meet', 'name': names[i], 'latitude': venue[1], 'longitude': venue[2],
                 'detail': 'Regular biker gathering venue', 'moreUrl': venue[3], 'source': 'Reviewed venue catalogue'}
                for i, venue in sorted(enumerate(VENUES), key=lambda pair: distance(center, (pair[1][1], pair[1][2])))
                if distance(center, (venue[1], venue[2])) <= radius]
    around = '(around:%d,%.6f,%.6f)' % (radius, *center)
    statements = ['nwr' + f + around + ';' for f in FILTERS[category]]
    if category == 'forest':
        reviewed = reviewed_forest_roads(center,radius)
        if reviewed:
            return reviewed
        margin = radius/110000
        lon_margin = margin/max(.1, math.cos(math.radians(center[0])))
        bounds = '%.6f,%.6f,%.6f,%.6f' % (center[0]-margin,center[1]-lon_margin,center[0]+margin,center[1]+lon_margin)
        statements = [kind + f + '(' + bounds + ');' for kind in ('way','rel') for f in FILTERS['forest']]
        forests = [f for f in overpass('[out:json][timeout:20];(' + ''.join(statements) + ');out geom 60;') if forest_size(f) >= 250000]
        road_queries = []
        for forest in forests:
            geometry = forest.get('geometry', []) + [p for member in forest.get('members', []) for p in member.get('geometry', [])]
            if geometry:
                box = (min(p['lat'] for p in geometry),min(p['lon'] for p in geometry),max(p['lat'] for p in geometry),max(p['lon'] for p in geometry))
                road_queries.append('way(%.6f,%.6f,%.6f,%.6f)["highway"];' % (box[0]-.0005,box[1]-.0008,box[2]+.0005,box[3]+.0008))
        roads = overpass('[out:json][timeout:20];(' + ''.join(road_queries) + ');out geom 1000;') if road_queries else []
        elements = forests + roads
    else:
        query = '[out:json][timeout:20];(' + ''.join(statements) + ');out center 80;'
        elements = overpass(query)
    results = forest_pois(elements) if category == 'forest' else [p for e in elements if (p := mapped_poi(e, category))]
    unique = []
    for p in results:
        if not any(p['name'].lower() == other['name'].lower() and distance((p['latitude'], p['longitude']), (other['latitude'], other['longitude'])) < 100 for other in unique):
            unique.append(p)
    return sorted([p for p in unique if distance(center,(p['latitude'],p['longitude'])) <= radius], key=lambda p: distance(center, (p['latitude'], p['longitude'])))[:80]


def near_route(pos, points, limit=250):
    scale = math.cos(math.radians(pos[0]))
    for start, end in zip(points, points[1:]):
        dx, dy = (end[1]-start[1])*scale, end[0]-start[0]
        length = dx*dx+dy*dy
        fraction = max(0, min(1, ((pos[1]-start[1])*scale*dx+(pos[0]-start[0])*dy)/length)) if length else 0
        if distance(pos, (start[0]+dy*fraction, start[1]+(end[1]-start[1])*fraction)) <= limit:
            return True
    return False


def route_elements(route):
    if not isinstance(route, list) or not 2 <= len(route) <= 1200:
        raise ServiceError('INVALID_ROUTE', 400)
    points = [coordinate(p.get('latitude'), p.get('longitude')) for p in route if isinstance(p, dict)]
    if len(points) != len(route) or sum(distance(a, b) for a, b in zip(points, points[1:])) > 1000000:
        raise ServiceError('INVALID_ROUTE', 400)
    line = ','.join('%.6f,%.6f' % p for p in points)
    filters = FILTERS['sight'] + FILTERS['pass']
    query = '[out:json][timeout:20];(' + ''.join('nwr' + f + '["name"](around:350,' + line + ');' for f in filters) + ');out center 1000;'
    elements = overpass(query)
    # Apply the reviewed meet catalogue to corridor searches too.
    results = [e for e in elements if e.get('tags', {}).get('amenity') not in ('cafe', 'pub', 'restaurant') or mapped_poi(e, 'meet')]
    for i, venue in enumerate(VENUES):
        if near_route((venue[1], venue[2]), points):
            results.append({'id': 'biker-venue-' + str(i), 'type': 'node', 'lat': venue[1], 'lon': venue[2],
                            'tags': {'name': ['Ace Cafe London', 'Squires Biker Cafe', 'Loomies Moto Cafe'][i], 'amenity': 'cafe'}})
    return results


def photo(wiki):
    match = re.fullmatch(r'([a-z-]{2,20}):([^\x00-\x1f]{1,300})', wiki)
    if not match:
        raise ServiceError('INVALID_WIKIPEDIA', 400)
    query = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'prop': 'pageimages', 'piprop': 'thumbnail', 'pithumbsize': 400, 'titles': match[2]})
    value = http_json('https://' + match[1] + '.wikipedia.org/w/api.php?' + query, timeout=8)
    for page in value.get('query', {}).get('pages', {}).values():
        url = page.get('thumbnail', {}).get('source')
        if url and url.startswith('https://upload.wikimedia.org/'):
            return {'imageUrl': url}
    return {'imageUrl': None}


class PoiServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, store):
        self.store, self.cache = store, Cache()
        self.rates, self.rate_lock = {}, threading.Lock()
        self.slots = threading.BoundedSemaphore(12)
        super().__init__(address, Handler)

    def allow(self, key):
        minute = int(time.time()/60)
        with self.rate_lock:
            self.rates = {k: v for k, v in self.rates.items() if v[0] == minute}
            total = sum(v[1] for v in self.rates.values())
            count = self.rates.get(key, (minute, 0))[1]
            if count >= 60 or total >= 600:
                return False
            self.rates[key] = (minute, count+1)
            return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, value):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def handle_request(self):
        if not self.server.allow(self.headers.get('X-Routing-Client-IP', self.client_address[0])):
            return self.send(429, {'code': 'RATE_LIMITED'})
        if not self.server.slots.acquire(blocking=False):
            return self.send(429, {'code': 'BUSY'})
        started = time.monotonic()
        try:
            self.connection.settimeout(15)
            url = urllib.parse.urlsplit(self.path)
            qs = urllib.parse.parse_qs(url.query)
            def arg(key, default=None):
                return qs.get(key, [default])[0]
            if self.command == 'GET' and url.path == '/poi-health':
                return self.send(200, self.server.store.health())
            if self.command == 'GET' and url.path == '/fuel-prices':
                station = arg('stationId')
                if not station or len(station) > 128:
                    raise ServiceError('STATION_ID_REQUIRED', 400)
                return self.send(200, self.server.store.snapshot(station))
            if self.command == 'GET' and url.path == '/pois':
                category = arg('category')
                if category not in RADII:
                    raise ServiceError('INVALID_CATEGORY', 400)
                center = coordinate(arg('latitude'), arg('longitude'))
                radius = float(arg('radius', RADII[category]))
                if not math.isfinite(radius) or not 1 <= radius <= RADII[category]:
                    raise ServiceError('INVALID_RADIUS', 400)
                results = self.server.store.nearby(center, radius) if category == 'fuel' else self.server.cache.get(('nearby', category, center, radius), lambda: nearby_pois(category, center, radius))
                return self.send(200, {'points': results, 'source': 'Fuel Finder' if category == 'fuel' else 'OpenStreetMap', 'reportUrl': DISCREPANCY if category == 'fuel' else None})
            if self.command == 'GET' and url.path == '/poi-photo':
                wiki = arg('wikipedia', '')
                return self.send(200, self.server.cache.get(('photo', wiki), lambda: photo(wiki), 86400))
            if self.command == 'POST' and url.path == '/route-pois':
                length = int(self.headers.get('Content-Length', 0))
                if not 1 <= length <= 150000:
                    raise ServiceError('INVALID_BODY', 400)
                payload = json.loads(self.rfile.read(length))
                route = payload.get('route')
                key = ('route', hashlib.sha256(json.dumps(route).encode()).hexdigest())
                return self.send(200, {'elements': self.server.cache.get(key, lambda: route_elements(route)) + self.server.store.corridor_elements(route)})
            return self.send(404, {'code': 'NOT_FOUND'})
        except ServiceError as error:
            return self.send(error.status if error.status in (400, 404, 429) else 503, {'code': error.code, 'reportUrl': DISCREPANCY})
        except (ValueError, TypeError, KeyError):
            return self.send(400, {'code': 'INVALID_REQUEST'})
        except Exception as error:
            log('poi.request.failed', errorType=type(error).__name__)
            return self.send(503, {'code': 'POI_UNAVAILABLE'})
        finally:
            self.server.slots.release()
            log('poi.request.completed', method=self.command, milliseconds=round((time.monotonic()-started)*1000))

    do_GET = handle_request
    do_POST = handle_request


def main():
    path = os.getenv('FUEL_DB', '/var/lib/bendbound-poi/fuel.sqlite')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    store = FuelStore(path)
    stop = threading.Event()
    threading.Thread(target=poll, args=(store, FuelClient(), stop), daemon=True).start()
    server = PoiServer((os.getenv('POI_BIND', '127.0.0.1'), int(os.getenv('POI_PORT', '8090'))), store)
    log('poi.server.started', port=server.server_address[1])
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()


if __name__ == '__main__':
    main()
