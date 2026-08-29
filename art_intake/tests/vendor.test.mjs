import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

test('compressed Transformers vendor expands to a complete browser bundle', async () => {
  const compressed = await readFile(new URL('../static/vendor/transformers.js.gz', import.meta.url));
  const source = gunzipSync(compressed).toString('utf8');
  assert.ok(source.length > 400_000);
  assert.doesNotMatch(source, /from\s*["']onnxruntime-(?:web|common)/);
  assert.ok(!source.includes(['42e32852', 'f24243b7', '48ae6bc1', 'f985b13a'].join('')));
});
