import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../service/rate-limit.mjs';

test('one client hitting its quota does not block another client', () => {
  const limit = createRateLimiter({ perClient: 2, global: 4, now: () => 0 });
  assert.equal(limit('a').allowed, true);
  assert.equal(limit('a').allowed, true);
  assert.deepEqual(limit('a'), { allowed: false, retryAfter: 60 });
  assert.equal(limit('b').allowed, true);
});

test('global budget caps requests even when clients keep changing', () => {
  const limit = createRateLimiter({ perClient: 2, global: 3, now: () => 0 });
  for (const client of ['a', 'b', 'c']) assert.equal(limit(client).allowed, true);
  assert.equal(limit('d').allowed, false);
  assert.equal(limit('a').allowed, false);
});

test('retry time counts down and both quotas recover at window boundary', () => {
  let time = 0;
  const limit = createRateLimiter({ perClient: 1, global: 1, now: () => time });
  assert.equal(limit('a').allowed, true);
  time = 59001;
  assert.deepEqual(limit('a'), { allowed: false, retryAfter: 1 });
  time = 60000;
  assert.equal(limit('a').allowed, true);
  time = 120000;
  assert.equal(limit('b').allowed, true);
});
