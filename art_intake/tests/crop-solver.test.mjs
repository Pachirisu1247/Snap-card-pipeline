import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ART_VIEWPORT,
  confidenceBand,
  placementForCrop,
  projectBox,
  solveCrop,
  visibleFraction,
} from '../static/crop-solver.js';

function analysis(overrides = {}) {
  return {
    image: { width: 3000, height: 1800 },
    foreground: {
      box: { x: 0.34, y: 0.04, width: 0.32, height: 0.92 },
      centroid: { x: 0.5, y: 0.45 },
      confidence: 0.94,
    },
    critical_regions: [{ box: { x: 0.43, y: 0.08, width: 0.14, height: 0.19 }, weight: 2 }],
    providers: ['foreground-segmentation', 'zero-shot-detector', 'face-detector'],
    quality_flags: [],
    fallback: false,
    ...overrides,
  };
}

test('solver is deterministic and returns a legal cover crop', () => {
  const input = analysis();
  const first = solveCrop(input);
  const second = solveCrop(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.crop.mode, 'auto');
  assert.equal(first.crop.analysis_version, 3);
  assert.equal(first.crop.framing_profile, 'snap-loose-v1');
  assert.ok(first.proposal_count >= 27);

  const placement = placementForCrop(first.crop, input.image);
  assert.ok(placement.x <= 0 && placement.y <= 0);
  assert.ok(placement.x + placement.width >= ART_VIEWPORT.width - 0.001);
  assert.ok(placement.y + placement.height >= ART_VIEWPORT.height - 0.001);
});

test('well-supported safe crop can receive high confidence', () => {
  const result = solveCrop(analysis());
  assert.equal(result.band, 'high');
  assert.ok(result.evaluation.foreground_retained >= 0.92);
  assert.ok(result.evaluation.critical_retained >= 0.98);
  assert.ok(result.evaluation.critical_occlusion <= 0.05);
});

test('missing a reliable critical region forces review', () => {
  const result = solveCrop(analysis({ critical_regions: [] }));
  assert.ok(result.confidence <= 0.68);
  assert.notEqual(result.band, 'high');
  assert.ok(result.reasons.includes('no reliable face/head box'));
});

test('a heavily clipped foreground can never be high confidence', () => {
  const input = analysis({
    image: { width: 1200, height: 1800 },
    foreground: { box: { x: 0.1, y: 0.02, width: 0.8, height: 0.96 }, centroid: { x: 0.5, y: 0.45 }, confidence: 0.97 },
    critical_regions: [{ box: { x: 0.35, y: 0.08, width: 0.3, height: 0.2 }, weight: 2 }],
  });
  const result = solveCrop(input);
  assert.ok(result.evaluation.foreground_retained < 0.92);
  assert.ok(result.confidence <= 0.77);
  assert.notEqual(confidenceBand(result.confidence), 'high');
});

test('a narrow portrait that forces a tight crop is downgraded and explained', () => {
  const result = solveCrop(analysis({
    image: { width: 825, height: 1275 },
    foreground: {
      box: { x: 0.018, y: 0, width: 0.982, height: 0.964 },
      centroid: { x: 0.508, y: 0.586 },
      confidence: 0.88,
    },
    critical_regions: [{ box: { x: 0.343, y: 0.128, width: 0.37, height: 0.254 }, weight: 1.35 }],
  }));
  assert.equal(result.crop.scale, 1);
  assert.equal(result.band, 'low');
  assert.ok(result.evaluation.foreground_retained < 0.86);
  assert.ok(result.reasons.includes('source forces a tight crop—prefer wider dynamic art'));
  assert.ok(Math.abs(result.crop.pan_y) <= 15);
});

test('critical region remains visible in the selected crop', () => {
  const input = analysis({
    foreground: { box: { x: 0.55, y: 0.08, width: 0.4, height: 0.86 }, centroid: { x: 0.76, y: 0.43 }, confidence: 0.84 },
    critical_regions: [{ box: { x: 0.7, y: 0.1, width: 0.16, height: 0.16 }, weight: 2.5 }],
  });
  const result = solveCrop(input);
  const projected = projectBox(input.critical_regions[0].box, result.crop, input.image);
  assert.ok(visibleFraction(projected) >= 0.98);
  assert.ok(result.evaluation.critical_occlusion <= 0.14);
});

test('invalid image dimensions fail explicitly', () => {
  assert.throws(() => solveCrop(analysis({ image: { width: 0, height: 100 } })), /dimensions must be positive/i);
});
