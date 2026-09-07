import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCandidateIdentity,
  buildArtSearchQuery,
  candidateContentFlags,
  deduplicateCandidates,
  deterministicFilter,
  normalizeCandidateUrl,
  rankCandidates,
  resolutionScore,
  semanticVerificationFlags,
} from '../static/candidate-ranker.js';

test('art-only query expansion preserves identity and anchors discovery to character artwork', () => {
  const query = buildArtSearchQuery('Havok', 'Havok Alex Summers X-Men');
  assert.match(query, /Havok Alex Summers X-Men/);
  assert.match(query, /Marvel character comic artwork illustration/);
  assert.doesNotMatch(query, /Marvel Snap|variants/);
  assert.doesNotMatch(query, /-toy|-statue|-figurine|-collectible/);
  assert.ok(query.length <= 390);
  assert.ok(query.split(/\s+/).length <= 48);
  assert.equal(buildArtSearchQuery('Havok', query), query);
});

test('art-only query expansion remains within Brave query limits for long custom input', () => {
  const query = buildArtSearchQuery('Havok', Array.from({ length: 80 }, (_, index) => `term${index}`).join(' '));
  assert.match(query, /Marvel character comic artwork illustration/);
  assert.ok(query.length <= 390);
  assert.ok(query.split(/\s+/).length <= 48);
});

test('default queries add focused identity hints for ambiguous calibration characters', () => {
  assert.match(buildArtSearchQuery('Havok'), /"Havok" Alex Summers X-Men/);
  assert.match(buildArtSearchQuery('Headpool'), /"Headpool" Marvel Snap Deadpool/);
  assert.match(buildArtSearchQuery('Galactus First Steps'), /"Galactus First Steps" Fantastic Four Galactus/);
});

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

test('deterministic filtering hard-rejects toys, storefronts, cosplay, and tutorials but keeps comic art', () => {
  const base = { width: 1800, height: 2400, thumbnail_url: 'https://images.test/thumb.jpg' };
  const filtered = deterministicFilter([
    { ...base, id: 'statue', original_url: 'https://images.test/havok-statue.jpg', source_page_url: 'https://collectors.test/havok', title: 'Havok Art Scale BDS Statue by Iron Studios (Limited Ed)' },
    { ...base, id: 'figure', original_url: 'https://images.test/headpool.jpg', source_page_url: 'https://shop.test/headpool', title: 'Headpool Marvel Legends action figure collectible in stock' },
    { ...base, id: 'store', original_url: 'https://i.etsystatic.com/havok-print.jpg', source_page_url: 'https://www.etsy.com/listing/123/havok', title: 'Havok wall art' },
    { ...base, id: 'cosplay', original_url: 'https://images.test/cosplay.jpg', source_page_url: 'https://photos.test/havok', title: 'Havok cosplay costume photoshoot' },
    { ...base, id: 'tutorial', original_url: 'https://images.test/draw.jpg', source_page_url: 'https://draw.test/havok', title: 'How to draw Havok step-by-step drawing tutorial' },
    { ...base, id: 'cover', original_url: 'https://images.test/cover.jpg', source_page_url: 'https://comicartfans.com/havok', title: 'Havok X-Men dynamic comic cover illustration by Neal Adams' },
  ]);
  assert.deepEqual(filtered.slice(0, 5).map(item => item.rejected), [true, true, true, true, true]);
  assert.equal(filtered[5].rejected, false);
  assert.deepEqual(candidateContentFlags(filtered[5]), []);
});

test('identity verification trusts the image title or filename, never a matching results page alone', () => {
  assert.deepEqual(assessCandidateIdentity({ title: 'Havok dynamic comic illustration', original_url: 'https://images.test/opaque-123.jpg' }, 'Havok'), { verified: true, evidence: ['title'] });
  assert.deepEqual(assessCandidateIdentity({ title: '', original_url: 'https://images.test/Havok_09.webp' }, 'Havok'), { verified: true, evidence: ['image_filename'] });
  assert.deepEqual(assessCandidateIdentity({ title: 'Shadow King card', original_url: 'https://images.test/shadow-king.jpg', source_page_url: 'https://site.test/havok-guide' }, 'Havok'), { verified: false, evidence: [] });
  assert.deepEqual(assessCandidateIdentity({ title: '', original_url: 'https://images.test/HydraBob.webp', source_page_url: 'https://site.test/cards/havok' }, 'Havok'), { verified: false, evidence: [] });
  assert.equal(assessCandidateIdentity({ title: 'Galactus comic cover' }, 'Galactus First Steps').verified, true);
});

test('strict filtering rejects wrong-character page leakage and rendered card assets', () => {
  const base = { width: 1000, height: 1200, thumbnail_url: 'https://images.test/thumb.jpg' };
  const filtered = deterministicFilter([
    { ...base, id: 'wrong', title: '', original_url: 'https://marvelsnapzone.com/assets/media/cards/hydra-bob.webp', source_page_url: 'https://marvelsnapzone.com/cards/havok/' },
    { ...base, id: 'card', title: 'Havok Hellfire Gala variant', original_url: 'https://snapjson.untapped.gg/art/render/framebreak/common/1024/Havok_04.webp' },
    { ...base, id: 'art', title: 'Havok dynamic X-Men comic artwork', original_url: 'https://artist.test/gallery/painted-scene.jpg' },
  ], { characterName: 'Havok' });
  assert.equal(filtered[0].rejected, true);
  assert.ok(filtered[0].filter_flags.includes('identity_unverified'));
  assert.ok(filtered[0].filter_flags.includes('rendered_card'));
  assert.equal(filtered[1].rejected, true);
  assert.ok(filtered[1].filter_flags.includes('rendered_card'));
  assert.equal(filtered[2].rejected, false);
  assert.equal(filtered[2].identity_verified, true);
});

test('visual verification rejects only confident wrong-character or rendered-card classifications', () => {
  assert.deepEqual(semanticVerificationFlags({ semantic_identity: 0.1, semantic_artwork: 0.2, semantic_wrong_character: 0.5, semantic_rendered_card: 0.05 }), ['wrong_character_visual']);
  assert.deepEqual(semanticVerificationFlags({ semantic_identity: 0.5, semantic_artwork: 0.1, semantic_wrong_character: 0.05, semantic_rendered_card: 0.5 }), ['rendered_card_visual']);
  assert.deepEqual(semanticVerificationFlags({ semantic_identity: 0.1, semantic_artwork: 0.2, semantic_wrong_character: 0.25, semantic_rendered_card: 0.05 }), []);
  assert.deepEqual(semanticVerificationFlags({ identity_evidence: ['title', 'image_filename'], semantic_identity: 0.05, semantic_artwork: 0.3, semantic_wrong_character: 0.6, semantic_rendered_card: 0.05 }), []);
  assert.deepEqual(semanticVerificationFlags({ semantic_identity: 0.4, semantic_artwork: 0.1, semantic_photo: 0.5 }), ['photo_visual']);
  assert.deepEqual(semanticVerificationFlags({ semantic_identity: 0.4, semantic_artwork: 0.1, semantic_merchandise: 0.5 }), ['merchandise_visual']);
  assert.deepEqual(semanticVerificationFlags({ semantic_identity: 0.4, semantic_artwork: 0.1, semantic_tutorial: 0.5 }), ['tutorial_visual']);
  assert.deepEqual(semanticVerificationFlags({ semantic_identity: 0.38, semantic_artwork: 0.3, semantic_wrong_character: 0.08, semantic_rendered_card: 0.06 }), []);
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
