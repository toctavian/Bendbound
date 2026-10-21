import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { createCleanupHandler } from '../src/cleanupWorker.mjs';

// Synthetic sentinels only: never use real request data to exercise redaction.
const sentinel = 'SYNTHETIC_PRIVATE_ERROR_SENTINEL';
const failure = () => Object.assign(new Error(sentinel), {
  cause: new Error(sentinel), request: { authorization: sentinel },
});
const outcome = { deleted: 1, examined: 2, more: false, oldestOverdueMs: 3 };

for (const entity of ['Points', 'Rooms']) {
  for (const stage of ['store', 'success-metric', 'failure-metric', 'both-metrics']) {
    test(`${entity} cleanup redacts ${stage} failures even when monitoring fails`, async () => {
      const lines = []; let emits = 0, cleanups = 0;
      const handler = createCleanupHandler({ entity, functionName: 'synthetic-cleanup', now: () => 1000,
        store: { cleanup: async () => { cleanups++; if (['store', 'failure-metric'].includes(stage)) throw failure(); return outcome; } },
        emit: (line) => {
          lines.push(line); emits++;
          if (stage === 'both-metrics' || stage === 'failure-metric' || (stage === 'success-metric' && emits === 1)) throw failure();
        },
      });
      await assert.rejects(handler({ privatePayload: sentinel }), (error) => {
        assert.equal(error.message, entity === 'Rooms' ? 'GROUP_ROOM_CLEANUP_FAILED' : 'GROUP_LOCATION_CLEANUP_FAILED');
        assert.equal(Object.hasOwn(error, 'cause'), false);
        assert.equal(inspect(error).includes(sentinel), false);
        assert.deepEqual(Object.keys(error), []);
        return true;
      });
      assert.equal(cleanups, 1); // Monitoring failure must never replay cleanup.
      assert.equal(emits, ['store', 'failure-metric'].includes(stage) ? 1 : 2);
      assert.equal(lines.join('').includes(sentinel), false);
      const last = JSON.parse(lines.at(-1));
      assert.equal(last.CleanupFailed, 1); assert.equal(last.CleanupSucceeded, 0);
    });
  }
}

test('failure-metric clock exceptions are sanitized without another store call', async () => {
  let clocks = 0, cleanups = 0, emits = 0;
  const handler = createCleanupHandler({ functionName: 'synthetic-cleanup',
    now: () => { if (++clocks > 1) throw failure(); return 1000; },
    store: { cleanup: async () => { cleanups++; throw failure(); } }, emit: () => { emits++; },
  });
  await assert.rejects(handler({}), (error) => {
    assert.equal(error.message, 'GROUP_LOCATION_CLEANUP_FAILED');
    assert.equal(inspect(error).includes(sentinel), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
  assert.equal(cleanups, 1); assert.equal(emits, 0); assert.equal(clocks, 2);
});
