import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhotopeaCrop, photopeaCompositionKey } from '../static/photopea-client.js';

test('sub-cover crops always activate bounded background extension', () => {
  assert.deepEqual(normalizePhotopeaCrop({
    scale: 0.82, pan_x: 7, pan_y: -9, extension_feather: 0.5,
  }), {
    scale: 0.82,
    x: 7,
    y: -9,
    backgroundMode: 'extend',
    feather: 0.12,
  });
});

test('composition cache separates cover and extended layer stacks', () => {
  const cover = normalizePhotopeaCrop({ scale: 1, background_mode: 'cover' });
  const extend = normalizePhotopeaCrop({ scale: 1, background_mode: 'extend', extension_feather: 0.055 });
  assert.notEqual(photopeaCompositionKey('havok', 'art-1', cover), photopeaCompositionKey('havok', 'art-1', extend));
  assert.equal(cover.feather, 0);
  assert.equal(extend.feather, 0.055);
});
