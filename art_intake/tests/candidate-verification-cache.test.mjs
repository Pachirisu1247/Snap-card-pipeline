import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateSetFingerprint,
  createVerificationSnapshot,
  restoreVerificationSnapshot,
} from '../static/candidate-verification-cache.js';

const raw = [
  { id: 'good', original_url: 'https://images.test/havok.jpg', title: 'Havok art' },
  { id: 'bad', original_url: 'https://images.test/hydra-bob.jpg', title: 'Wrong character' },
];

test('candidate fingerprints are deterministic but change with provider results', () => {
  assert.equal(candidateSetFingerprint(raw), candidateSetFingerprint([...raw].reverse()));
  assert.notEqual(candidateSetFingerprint(raw), candidateSetFingerprint(raw.slice(0, 1)));
  assert.notEqual(candidateSetFingerprint(raw), candidateSetFingerprint([{ ...raw[0], original_url: 'https://images.test/changed.jpg' }, raw[1]]));
});

test('verification snapshots reload only accepted candidates from the exact ranked set', () => {
  const verified = [{ ...raw[0], semantic_identity: 0.8, composition_confidence: 0.72, display_rank: 1 }];
  const snapshot = createVerificationSnapshot(raw, verified, 4, { input_count: 2, filtered_count: 1 });
  const restored = restoreVerificationSnapshot(raw, raw, snapshot, 4);
  assert.deepEqual(restored.candidates.map(candidate => candidate.id), ['good']);
  assert.equal(restored.candidates[0].semantic_identity, 0.8);
  assert.equal(restored.summary.filtered_count, 1);
});

test('stale model versions, changed provider sets, and newly ineligible candidates fail closed', () => {
  const snapshot = createVerificationSnapshot(raw, [raw[0]], 4);
  assert.equal(restoreVerificationSnapshot(raw, raw, snapshot, 5), null);
  assert.equal(restoreVerificationSnapshot(raw.slice(0, 1), raw.slice(0, 1), snapshot, 4), null);
  assert.equal(restoreVerificationSnapshot(raw, [raw[1]], snapshot, 4), null);
});

test('an empty verified result remains a valid fail-closed snapshot', () => {
  const snapshot = createVerificationSnapshot(raw, [], 4, { semantic_filtered_count: 2 });
  const restored = restoreVerificationSnapshot(raw, raw, snapshot, 4);
  assert.deepEqual(restored.candidates, []);
  assert.equal(restored.summary.semantic_filtered_count, 2);
});
