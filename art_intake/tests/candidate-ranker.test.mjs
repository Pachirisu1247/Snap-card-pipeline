import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateCandidates,
  deterministicFilter,
  normalizeCandidateUrl,
  rankCandidates,
  resolutionScore,
} from '../static/candidate-ranker.js';

test('URL normalization strips tracking and rejects unsafe schemes', () => {
  assert.equal(normalizeCandidateUrl('javascript:alert(1)'), '');
  assert.equal(
    normalizeCandidateUrl('https://example.com/art.jpg?utm_source=x&keep=1#fragment'),
    'https://example.com/art.jpg?keep=1',
  );
});

test('deterministic filtering rejects duplicate, low-resolution, extreme, and text-heavy results', () => {
  const filtered = deterministicFilter([
    { id: 'good', original_url: 'https://a.test/a.jpg', thumbnail_url: 'https://a.test/a-thumb.jpg', width: 1800, height: 2400, title: 'Character illustration' },
    { id: 'duplicate', original_url: 'https://a.test/a.jpg', thumbnail_url: 'https://a.test/b-thumb.jpg', width: 1800, height: 2400 },
    { id: 'small', original_url: 'https://a.test/small.jpg', thumbnail_url: 'https://a.test/small-thumb.jpg', width: 300, height: 500 },
    { id: 'wide', original_url: 'https://a.test/wide.jpg', thumbnail_url: 'https://a.test/wide-thumb.jpg', width: 4000, height: 500 },
    { id: 'text', original_url: 'https://etsy.test/card.jpg', thumbnail_url: 'https://a.test/text-thumb.jpg', width: 1800, height: 2400, title: 'wallpaper download trading card poster collage screenshot' },
  ]);
  assert.equal(filtered[0].rejected, false);
  assert.deepEqual(filtered.slice(1).map(item => item.rejected), [true, true, true, true]);
});

test('perceptual hash deduplication keeps the first provider result', () => {
  const input = [
    { id: 'first', hash: '0000000000000000' },
    { id: 'near', hash: '0000000000000001' },
    { id: 'different', hash: 'ffffffffffffffff' },
  ];
  const result = deduplicateCandidates(input, 5);
  assert.deepEqual(result.unique.map(item => item.id), ['first', 'different']);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.groups[0].duplicates, ['near']);
});

test('semantic relevance and composition outrank provider order', () => {
  const ranked = rankCandidates([
    { id: 'weak', width: 1800, height: 2200, provider_rank: 1, semantic_relevance: 0.1, composition_confidence: 0.2 },
    { id: 'strong', width: 1800, height: 2200, provider_rank: 40, semantic_relevance: 0.98, composition_confidence: 0.94 },
  ]);
  assert.equal(ranked[0].id, 'strong');
  assert.deepEqual(ranked.map(item => item.display_rank), [1, 2]);
});

test('ranking dozens of candidates is complete and deterministic', () => {
  const candidates = Array.from({ length: 48 }, (_, index) => ({
    id: `candidate-${String(index).padStart(2, '0')}`,
    width: 900 + index * 37,
    height: 1200 + index * 41,
    provider_rank: index + 1,
    semantic_relevance: ((index * 17) % 47) / 46,
    composition_confidence: ((index * 29) % 43) / 42,
    diversity_score: 1 - (index % 6) * 0.05,
  }));
  const first = rankCandidates(candidates);
  const second = rankCandidates([...candidates].reverse());
  assert.equal(first.length, 48);
  assert.deepEqual(first.map(item => item.id), second.map(item => item.id));
  assert.deepEqual(first.map(item => item.display_rank), Array.from({ length: 48 }, (_, index) => index + 1));
  assert.ok(first.every((item, index) => index === 0 || first[index - 1].fused_score >= item.fused_score));
});

test('resolution score rewards useful print dimensions', () => {
  assert.ok(resolutionScore(2400, 3000) > resolutionScore(600, 750));
  assert.ok(resolutionScore(1800, 2100) > 0.45);
});
