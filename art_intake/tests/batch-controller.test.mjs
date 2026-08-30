import test from 'node:test';
import assert from 'node:assert/strict';
import { BatchController } from '../static/batch-controller.js';

test('batch retries transient failures and continues past permanent ones', async () => {
  const attempts = new Map();
  const controller = new BatchController({
    delay: async () => {},
    retryDelays: [1, 2],
    runTask: async item => {
      attempts.set(item, (attempts.get(item) || 0) + 1);
      if (item === 'retry' && attempts.get(item) < 2) throw Object.assign(new Error('rate limited'), { status: 429 });
      if (item === 'bad') throw Object.assign(new Error('invalid'), { status: 400 });
      return `${item}-done`;
    },
  });
  const result = await controller.start(['ok', 'retry', 'bad', 'after']);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.completed.map(entry => entry.item), ['ok', 'retry', 'after']);
  assert.deepEqual(result.failed.map(entry => entry.item), ['bad']);
  assert.equal(attempts.get('retry'), 2);
  assert.equal(attempts.get('bad'), 1);
});

test('batch pause/resume preserves order and cancel preserves unfinished work', async () => {
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const controller = new BatchController({ runTask: async item => { if (item === 'a') await firstBlocked; return item; } });
  const run = controller.start(['a', 'b', 'c']);
  controller.pause();
  releaseFirst();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(controller.snapshot().status, 'paused');
  assert.deepEqual(controller.snapshot().remaining, ['b', 'c']);
  controller.resume();
  const done = await run;
  assert.deepEqual(done.completed.map(entry => entry.item), ['a', 'b', 'c']);

  const cancelled = new BatchController({ runTask: async item => item });
  cancelled.pause = BatchController.prototype.pause.bind(cancelled);
  const secondRun = cancelled.start(['x', 'y']);
  cancelled.cancel();
  const stopped = await secondRun;
  assert.equal(stopped.status, 'cancelled');
  assert.ok(stopped.remaining.length <= 2);
});
