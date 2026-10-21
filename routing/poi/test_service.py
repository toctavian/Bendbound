import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
import service as api


class FuelTests(unittest.TestCase):
    def setUp(self):
        self.now = 1791806400.0
        self.store = api.FuelStore(':memory:', clock=lambda: self.now)
        self.site = {'node_id': 'station-a', 'trading_name': 'Independent', 'location': {'latitude': 51.5, 'longitude': -.1, 'postcode': 'AB1'}}
        self.price = {'node_id': 'station-a', 'fuel_prices': [
            {'fuel_type': 'E10', 'price': '0139.9500', 'price_last_updated': '2026-10-01T10:00:00', 'price_change_effective_timestamp': '2026-10-01T09:55:00Z'},
            {'fuel_type': 'E5', 'price': None, 'price_last_updated': None}]}
        self.store.commit([self.site], [self.price], self.now, True)
        for postcode in ['AB1','AB2']:
            self.store.db.execute('INSERT INTO postcode_centres VALUES (?,?,?)', (postcode,json.dumps({'latitude':51.5,'longitude':-.1}),self.now))
        self.store.db.commit()

    def tearDown(self):
        self.store.db.close()

    def test_stable_ids_and_original_prices(self):
        pois = self.store.nearby((51.5, -.1), 1000)
        self.assertEqual(pois[0]['fuelStationId'], 'station-a')
        snapshot = self.store.snapshot('station-a')
        self.assertEqual(snapshot['prices'][0]['amount'], '0139.9500')
        self.assertEqual(snapshot['prices'][0]['updatedAt'], '2026-10-01T10:00:00')
        self.assertEqual(snapshot['prices'][1]['amount'], None)
        self.assertEqual(snapshot['updatedAtBasis'], 'latest-price-update')
        self.assertEqual(snapshot['reportUrl'], api.DISCREPANCY)
        with self.assertRaises(api.ServiceError) as error:
            self.store.snapshot('nearby-name-is-not-an-id')
        self.assertEqual(error.exception.status, 404)

    def test_provider_postcode_coordinate_mismatch_is_not_a_false_map_pin(self):
        wrong = {**self.site, 'node_id': 'wrong', 'location': {'latitude': 51.5, 'longitude': -.1, 'postcode': 'PR4 6UD'}}
        self.store.db.execute('INSERT INTO postcode_centres VALUES (?,?,?)', ('PR46UD', json.dumps({'latitude':53.68,'longitude':-2.83}),self.now))
        self.store.commit([wrong], [], self.now, False)
        pins = self.store.nearby((51.5,-.1),1000)
        self.assertEqual([p['fuelStationId'] for p in pins],['station-a'])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM sites WHERE id="wrong"').fetchone()[0],1)

    def test_expiry_uses_verified_time_not_old_price_date(self):
        self.assertTrue(self.store.fresh())
        self.now += 300
        self.assertFalse(self.store.fresh())
        with self.assertRaises(api.ServiceError):
            self.store.snapshot('station-a')

    def test_incremental_merge_preserves_all_grades_and_location(self):
        self.now += 240
        self.store.commit([{'node_id': 'station-a', 'location': {'postcode': 'AB2'}}],
                          [{'node_id': 'station-a', 'fuel_prices': [{'fuel_type': 'E10', 'price': '140.123'}]}], self.now, False)
        snapshot = self.store.snapshot('station-a')
        self.assertEqual(len(snapshot['prices']), 2)
        self.assertEqual(snapshot['prices'][0]['amount'], '140.123')
        self.assertEqual(snapshot['prices'][0]['updatedAt'], '2026-10-01T10:00:00')
        self.assertEqual(snapshot['latitude'], 51.5)
        self.assertEqual(snapshot['prices'][1]['amount'], None)

    def test_failed_cycle_keeps_cursor_and_does_not_publish_partial_prices(self):
        class Client:
            calls = 0
            clock = lambda _: self.now + 240
            def fetch_all(_, path, since):
                if path == '/pfs':
                    raise api.ServiceError('UPSTREAM_UNAVAILABLE')
                return [{'node_id': 'station-a', 'fuel_prices': []}]
        cursor = self.store.meta('cursor')
        with self.assertRaises(api.ServiceError):
            api.sync_once(self.store, Client())
        self.assertEqual(self.store.meta('cursor'), cursor)
        self.assertEqual(self.store.snapshot('station-a')['prices'][0]['amount'], '0139.9500')

    def test_pagination_short_pages_empty_blips_and_token_reuse(self):
        calls = []
        replies = [[{'node_id': 'a'}], [], [{'node_id': 'b'}]]
        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            if 'generate_access_token' in url:
                return {'data': {'access_token': 'not-logged', 'expires_in': 3600}}
            if replies:
                return replies.pop(0)
            raise api.ServiceError('UPSTREAM_HTTP_404', 404)
        client = api.FuelClient(fetch=fetch, secret_loader=lambda: {'client_id': 'id', 'client_secret': 'secret'}, clock=lambda: self.now, sleep=lambda _: None)
        rows = client.fetch_all('/pfs')
        self.assertEqual([r['node_id'] for r in rows], ['a', 'b'])
        self.assertEqual(sum('generate_access_token' in url for url, _ in calls), 1)
        self.assertTrue(all(kwargs['headers']['Authorization'] == 'Bearer not-logged' for url, kwargs in calls if '/pfs?' in url))

    def test_incremental_no_updates_terminal_404_is_complete(self):
        client = api.FuelClient(clock=lambda: self.now, sleep=lambda _: None)
        client.page = lambda _: (_ for _ in ()).throw(api.ServiceError('UPSTREAM_HTTP_404', 404))
        self.assertEqual(client.fetch_all('/pfs', self.now-60), [])
        with self.assertRaises(api.ServiceError):
            client.fetch_all('/pfs')

    def test_http_ids_input_validation_no_freshness_claim_on_missing_baseline(self):
        server = api.PoiServer(('127.0.0.1', 0), self.store)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:' + str(server.server_address[1])
        try:
            with urllib.request.urlopen(base+'/pois?category=fuel&latitude=51.5&longitude=-.1') as response:
                self.assertEqual(json.load(response)['points'][0]['fuelStationId'], 'station-a')
            with urllib.request.urlopen(base+'/fuel-prices?stationId=station-a') as response:
                self.assertEqual(json.load(response)['stationId'], 'station-a')
            for path in ['/fuel-prices?name=Independent', '/pois?category=bad', '/pois?category=fuel&latitude=nan&longitude=0']:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(base+path)
                self.assertEqual(error.exception.code, 400)
        finally:
            server.shutdown()
            server.server_close()


class PoiTests(unittest.TestCase):
    def test_meets_reject_generic_pubs_and_namesakes(self):
        venue = {'id': 1, 'type': 'node', 'lat': 51.5406, 'lon': -.2786, 'tags': {'name': 'Ace Cafe'}}
        self.assertIsNotNone(api.mapped_poi(venue, 'meet'))
        self.assertIsNone(api.mapped_poi({**venue, 'tags': {'name': 'The Red Lion'}}, 'meet'))
        self.assertIsNone(api.mapped_poi({**venue, 'lat': 55}, 'meet'))

    def test_curated_meets_do_not_depend_on_public_overpass(self):
        with patch.object(api, 'overpass', side_effect=AssertionError('No broad pub search')):
            venues = api.nearby_pois('meet',(51.5074,-.1278),60000)
            self.assertEqual([p['name'] for p in venues],['Ace Cafe London'])

    def test_forests_require_inside_public_road_and_exclude_parks_tracks_private(self):
        forest = {'id': 1, 'type': 'way', 'tags': {'name': 'Wood', 'natural': 'wood'},
                  'geometry': [{'lat': 0, 'lon': 0}, {'lat': 0, 'lon': 1}, {'lat': 1, 'lon': 1}, {'lat': 1, 'lon': 0}, {'lat': 0, 'lon': 0}]}
        road = {'id': 2, 'type': 'way', 'tags': {'highway': 'secondary', 'name': 'Through Road'}, 'geometry': [{'lat': .5, 'lon': .5}]}
        self.assertEqual(api.forest_pois([forest, road])[0]['latitude'], .5)
        for tags in [{'highway': 'track'}, {'highway': 'secondary', 'access': 'private'}, {'highway': 'secondary', 'motorcycle': 'no'}, {'highway': 'secondary', 'noexit': 'yes'}]:
            self.assertEqual(api.forest_pois([forest, {**road, 'tags': tags}]), [])
        self.assertEqual(api.forest_pois([{**forest, 'tags': {'name': 'Park', 'leisure': 'nature_reserve'}}, road]), [])

    def test_reviewed_forest_roads_use_actual_public_road_geometry(self):
        road = {'tags':{'ref':'A104','highway':'primary'},'geometry':[{'lat':51.67,'lon':.05}]}
        with patch.object(api,'overpass',return_value=[road]):
            points=api.reviewed_forest_roads((51.67,.05),10000)
            self.assertEqual(points[0]['name'],'Epping Forest')
            self.assertEqual(points[0]['latitude'],51.67)
        road['tags']['motorcycle']='no'
        with patch.object(api,'overpass',return_value=[road]):
            self.assertEqual(api.reviewed_forest_roads((51.67,.05),10000),[])

    def test_small_urban_woods_and_residential_edges_are_excluded(self):
        forest = {'id':1,'type':'way','tags':{'name':'Pocket Copse','natural':'wood'},'geometry':[
            {'lat':0,'lon':0},{'lat':0,'lon':.001},{'lat':.001,'lon':.001},{'lat':.001,'lon':0},{'lat':0,'lon':0}]}
        road = {'id':2,'type':'way','tags':{'highway':'secondary'},'geometry':[{'lat':.0005,'lon':.0005}]}
        self.assertEqual(api.forest_pois([forest,road]),[])
        forest['geometry']=[{'lat':0,'lon':0},{'lat':0,'lon':1},{'lat':1,'lon':1},{'lat':1,'lon':0},{'lat':0,'lon':0}]
        road['tags']={'highway':'residential'}
        self.assertEqual(api.forest_pois([forest,road]),[])

    def test_forest_relations_join_outer_members_and_exclude_holes(self):
        forest = {'id':7,'type':'relation','tags':{'name':'Forest','landuse':'forest'},'members':[
            {'role':'outer','geometry':[{'lat':0,'lon':0},{'lat':0,'lon':1},{'lat':1,'lon':1}]},
            {'role':'outer','geometry':[{'lat':0,'lon':0},{'lat':1,'lon':0},{'lat':1,'lon':1}]},
            {'role':'inner','geometry':[{'lat':.4,'lon':.4},{'lat':.4,'lon':.6},{'lat':.6,'lon':.6},{'lat':.6,'lon':.4},{'lat':.4,'lon':.4}]},
        ]}
        road = {'id':8,'type':'way','tags':{'highway':'secondary'},'geometry':[{'lat':.5,'lon':.5}]}
        self.assertEqual(api.forest_pois([forest,road]),[])
        road['geometry']=[{'lat':.2,'lon':.2}]
        self.assertEqual(api.forest_pois([forest,road])[0]['latitude'],.2)

    def test_route_and_photo_reject_unbounded_or_injected_input(self):
        for route in [[], [{'latitude': float('nan'), 'longitude': 0}]*2, [{}]*1201]:
            with self.assertRaises((api.ServiceError, TypeError)):
                api.route_elements(route)
        with self.assertRaises(api.ServiceError):
            api.photo('evil.com:Thing')
        with patch.object(api, 'overpass', return_value=[]) as upstream:
            self.assertEqual(api.route_elements([{'latitude': 51.5, 'longitude': -.1}, {'latitude': 51.51, 'longitude': -.11}]), [])
            self.assertIn('around:350', upstream.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
