"""Checks for crawlable product facts and safe structured-data delivery."""
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from handler import handler, ROOT


def get(path):
    return handler({'rawPath': path, 'requestContext': {'http': {'method': 'GET'}}}, None)


class DiscoveryTests(unittest.TestCase):
    def test_discovery_documents_are_readable_with_canonical_links(self):
        for path, mime in [('/llms.txt', 'text/plain'), ('/index.md', 'text/markdown'),
                           ('/robots.txt', 'text/plain'), ('/sitemap.xml', 'application/xml'),
                           ('/assets/social-card.png', 'image/png')]:
            with self.subTest(path=path):
                response = get(path)
                self.assertEqual(response['statusCode'], 200)
                self.assertTrue(response['headers']['content-type'].startswith(mime))
                self.assertGreater(len(base64.b64decode(response['body'])), 20)
        for path in ['/', '/index.md']:
            links = get(path)['headers']['link']
            self.assertIn('<https://bendboundapp.com/>; rel="canonical"', links)
            self.assertIn('type="text/markdown"', links)
            self.assertIn('/llms.txt', links)

    def test_json_ld_describes_beta_without_inventing_an_offer_or_reviews(self):
        html = base64.b64decode(get('/')['body']).decode()
        blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
        self.assertEqual(len(blocks), 1)
        graph = json.loads(blocks[0])['@graph']
        entities = {entity['@id']: entity for entity in graph}
        page = next(entity for entity in graph if entity['@type'] == 'WebPage')
        self.assertIn(page['mainEntity']['@id'], entities)
        app = entities[page['mainEntity']['@id']]
        self.assertEqual(app['@type'], 'MobileApplication')
        self.assertEqual(app['creativeWorkStatus'], 'Early beta')
        self.assertEqual(app['operatingSystem'], 'iOS')
        for unsupported in ['offers', 'aggregateRating', 'review', 'downloadUrl', 'installUrl']:
            self.assertNotIn(unsupported, app)
        policy = get('/')['headers']['content-security-policy']
        digest = base64.b64encode(hashlib.sha256(blocks[0].encode()).digest()).decode()
        self.assertIn("'sha256-" + digest + "'", policy)
        self.assertNotIn("'unsafe-inline'", policy)
        self.assertIn("connect-src 'none'", policy)

    def test_search_and_retrieval_bots_can_read_product_and_assets(self):
        robots = RobotFileParser()
        robots.parse((ROOT / 'robots.txt').read_text().splitlines())
        for bot in ['Googlebot', 'bingbot', 'OAI-SearchBot', 'ChatGPT-User',
                    'PerplexityBot', 'Claude-SearchBot']:
            for path in ['/', '/llms.txt', '/index.md', '/site.js', '/styles.css']:
                self.assertTrue(robots.can_fetch(bot, 'https://bendboundapp.com' + path), (bot, path))
        self.assertIn('https://bendboundapp.com/sitemap.xml', robots.site_maps())

    def test_sitemap_uses_only_canonical_public_pages(self):
        sitemap = ET.fromstring((ROOT / 'sitemap.xml').read_text())
        locations = sitemap.findall('{http://www.sitemaps.org/schemas/sitemap/0.9}url/{http://www.sitemaps.org/schemas/sitemap/0.9}loc')
        self.assertEqual([location.text for location in locations], ['https://bendboundapp.com/'])
        self.assertNotIn('noindex', (ROOT / 'index.html').read_text())


if __name__ == '__main__':
    unittest.main()
