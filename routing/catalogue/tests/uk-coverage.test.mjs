import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inUkArea } from '../service/policy.mjs';
test('UK extract coverage includes all four nations and distant islands without admitting foreign capitals', () => {
  for (const p of [{latitude:51.5074,longitude:-.1278},{latitude:51.4816,longitude:-3.1791},{latitude:55.9533,longitude:-3.1883},{latitude:54.5973,longitude:-5.9301},{latitude:50.118,longitude:-5.537},{latitude:60.155,longitude:-1.145}]) assert.equal(inUkArea(p),true);
  for (const p of [{latitude:53.3498,longitude:-6.2603},{latitude:48.8566,longitude:2.3522},{latitude:NaN,longitude:0},{latitude:55,longitude:360}]) assert.equal(inUkArea(p),false);
});
