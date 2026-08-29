import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCrop, migrateRecord, migrateState, normalizeCrop } from '../static/state.js';

test('manual defaults preserve nullable analysis metadata', () => {
  const normalized = normalizeCrop(defaultCrop());
  assert.equal(normalized.mode, 'manual');
  assert.equal(normalized.analysis_version, null);
  assert.equal(normalized.confidence, null);
  assert.equal(normalized.manual_revision, true);
});

test('legacy records migrate without losing source and note fields', () => {
  const record = migrateRecord({
    status: 'selected', source_url: 'https://example.test/source', note: 'keep me',
    crop: { scale: 1.25, pan_x: 9, pan_y: -4, mode: 'manual' },
  });
  assert.equal(record.source_url, 'https://example.test/source');
  assert.equal(record.note, 'keep me');
  assert.equal(record.crop.scale, 1.25);
  assert.equal(record.analysis, null);
  assert.equal(record.candidate_id, '');
});

test('crop values are finite and clamped at storage boundaries', () => {
  assert.deepEqual(normalizeCrop({ scale: 99, pan_x: -800, pan_y: 'bad', mode: 'auto', confidence: 0.7 }), {
    scale: 3,
    pan_x: -100,
    pan_y: 0,
    mode: 'auto',
    analysis_version: null,
    confidence: 0.7,
    manual_revision: false,
  });
});

test('state migration handles empty and multiple card records', () => {
  assert.deepEqual(migrateState(null), {});
  const state = migrateState({ a: { crop: {} }, b: { crop: { mode: 'auto' }, candidate_id: 42 } });
  assert.deepEqual(Object.keys(state), ['a', 'b']);
  assert.equal(state.b.candidate_id, '42');
});
