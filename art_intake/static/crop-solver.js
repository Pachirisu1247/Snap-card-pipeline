export const ART_VIEWPORT = Object.freeze({ width: 1792, height: 2006 });
export const CONFIDENCE_THRESHOLDS = Object.freeze({ high: 0.78, medium: 0.55 });

const SCALE_STEPS = Object.freeze([1, 1.08, 1.16, 1.28, 1.42, 1.6, 1.85, 2.15, 2.4]);
const OCCLUSIONS = Object.freeze([
  { id: 'cost', x: 0, y: 0, width: 0.24, height: 0.19, weight: 1.55 },
  { id: 'power', x: 0.76, y: 0, width: 0.24, height: 0.19, weight: 1.55 },
  { id: 'logo-rules', x: 0, y: 0.69, width: 1, height: 0.31, weight: 1.8 },
]);

export function confidenceBand(confidence) {
  if (confidence >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (confidence >= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  return 'low';
}

export function solveCrop(analysis, options = {}) {
  const image = normalizeImage(analysis?.image);
  const foreground = normalizeForeground(analysis?.foreground);
  const critical = (analysis?.critical_regions || []).map(normalizeCritical).filter(Boolean);
  const viewport = options.viewport || ART_VIEWPORT;
  const scales = options.scales || SCALE_STEPS;
  const anchors = buildAnchors(foreground, critical);
  const proposals = [];

  for (const scale of scales) {
    for (const anchor of anchors) {
      const crop = cropForAnchor(image, viewport, scale, anchor.source, anchor.target);
      const evaluation = scoreCrop(crop, image, foreground, critical, viewport);
      proposals.push({ crop, evaluation, anchor: anchor.id });
    }
  }

  proposals.sort((a, b) => a.evaluation.penalty - b.evaluation.penalty || a.crop.scale - b.crop.scale || a.crop.pan_y - b.crop.pan_y || a.crop.pan_x - b.crop.pan_x);
  const best = proposals[0];
  const second = proposals[1] || best;
  const confidence = calculateConfidence(analysis, best.evaluation, second.evaluation);
  const reasons = buildReasons(analysis, best, confidence);

  return {
    crop: {
      scale: round(best.crop.scale, 2),
      pan_x: round(best.crop.pan_x, 0),
      pan_y: round(best.crop.pan_y, 0),
      mode: 'auto',
      analysis_version: 2,
      confidence: round(confidence, 3),
      manual_revision: false,
    },
    confidence: round(confidence, 3),
    band: confidenceBand(confidence),
    reasons,
    evaluation: best.evaluation,
    proposal_count: proposals.length,
    winning_anchor: best.anchor,
  };
}

export function cropForAnchor(imageInput, viewport, scale, source, target) {
  const image = normalizeImage(imageInput);
  const base = Math.max(viewport.width / image.width, viewport.height / image.height);
  const drawWidth = image.width * base * scale;
  const drawHeight = image.height * base * scale;
  const centerX = (viewport.width - drawWidth) / 2;
  const centerY = (viewport.height - drawHeight) / 2;
  const desiredX = target.x * viewport.width - source.x * drawWidth;
  const desiredY = target.y * viewport.height - source.y * drawHeight;
  const legalX = clamp(desiredX, viewport.width - drawWidth, 0);
  const legalY = clamp(desiredY, viewport.height - drawHeight, 0);
  return {
    scale,
    pan_x: clamp((legalX - centerX) / viewport.width * 100, -100, 100),
    pan_y: clamp((legalY - centerY) / viewport.height * 100, -100, 100),
  };
}

export function placementForCrop(crop, imageInput, viewport = ART_VIEWPORT) {
  const image = normalizeImage(imageInput);
  const base = Math.max(viewport.width / image.width, viewport.height / image.height);
  const drawWidth = image.width * base * Number(crop.scale);
  const drawHeight = image.height * base * Number(crop.scale);
  const unclampedX = (viewport.width - drawWidth) / 2 + Number(crop.pan_x) / 100 * viewport.width;
  const unclampedY = (viewport.height - drawHeight) / 2 + Number(crop.pan_y) / 100 * viewport.height;
  return {
    x: clamp(unclampedX, viewport.width - drawWidth, 0),
    y: clamp(unclampedY, viewport.height - drawHeight, 0),
    width: drawWidth,
    height: drawHeight,
  };
}

export function projectBox(boxInput, crop, image, viewport = ART_VIEWPORT) {
  const box = normalizeBox(boxInput);
  const placement = placementForCrop(crop, image, viewport);
  return {
    x: placement.x + box.x * placement.width,
    y: placement.y + box.y * placement.height,
    width: box.width * placement.width,
    height: box.height * placement.height,
  };
}

export function visibleFraction(box, viewport = ART_VIEWPORT) {
  const intersection = intersect(box, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  const area = Math.max(1e-9, box.width * box.height);
  return clamp(intersection.width * intersection.height / area, 0, 1);
}

export function unionBoxes(boxes) {
  if (!boxes.length) return null;
  const normalized = boxes.map(normalizeBox);
  const left = Math.min(...normalized.map(box => box.x));
  const top = Math.min(...normalized.map(box => box.y));
  const right = Math.max(...normalized.map(box => box.x + box.width));
  const bottom = Math.max(...normalized.map(box => box.y + box.height));
  return normalizeBox({ x: left, y: top, width: right - left, height: bottom - top });
}

function scoreCrop(crop, image, foreground, critical, viewport) {
  const projectedForeground = projectBox(foreground.box, crop, image, viewport);
  const foregroundRetained = visibleFraction(projectedForeground, viewport);
  const normalizedForegroundHeight = projectedForeground.height / viewport.height;
  let penalty = (1 - foregroundRetained) * 900;
  let criticalRetained = 1;
  let criticalOcclusion = 0;

  for (const region of critical) {
    const projected = projectBox(region.box, crop, image, viewport);
    const retained = visibleFraction(projected, viewport);
    criticalRetained = Math.min(criticalRetained, retained);
    penalty += (1 - retained) * 2200 * region.weight;
    for (const danger of OCCLUSIONS) {
      const dangerPixels = toPixels(danger, viewport);
      const overlap = overlapFraction(projected, dangerPixels);
      criticalOcclusion += overlap * danger.weight * region.weight;
      penalty += overlap * 1850 * danger.weight * region.weight;
    }
    const center = centerOf(projected);
    const targetDistance = Math.hypot(center.x / viewport.width - 0.5, center.y / viewport.height - 0.35);
    penalty += targetDistance * 95 / Math.max(0.35, region.weight);
  }

  if (normalizedForegroundHeight < 0.46) penalty += (0.46 - normalizedForegroundHeight) * 440;
  if (normalizedForegroundHeight > 1.48) penalty += (normalizedForegroundHeight - 1.48) * 180;

  const projectedCentroid = {
    x: placementForCrop(crop, image, viewport).x + foreground.centroid.x * placementForCrop(crop, image, viewport).width,
    y: placementForCrop(crop, image, viewport).y + foreground.centroid.y * placementForCrop(crop, image, viewport).height,
  };
  const centroidDistance = Math.hypot(projectedCentroid.x / viewport.width - 0.5, projectedCentroid.y / viewport.height - 0.43);
  penalty += centroidDistance * 90;
  penalty += Math.max(0, crop.scale - 1) * 18;

  return {
    penalty: round(penalty, 3),
    foreground_retained: round(foregroundRetained, 4),
    critical_retained: round(criticalRetained, 4),
    critical_occlusion: round(criticalOcclusion, 4),
    subject_height: round(normalizedForegroundHeight, 4),
  };
}

function buildAnchors(foreground, critical) {
  const anchors = [
    { id: 'foreground-centroid', source: foreground.centroid, target: { x: 0.5, y: 0.43 } },
    { id: 'foreground-center', source: centerOf(foreground.box), target: { x: 0.5, y: 0.45 } },
    { id: 'center-cover', source: { x: 0.5, y: 0.5 }, target: { x: 0.5, y: 0.5 } },
  ];
  for (const [index, region] of critical.entries()) {
    const source = centerOf(region.box);
    anchors.push({ id: `critical-${index}-center`, source, target: { x: 0.5, y: 0.34 } });
    anchors.push({ id: `critical-${index}-third`, source, target: { x: source.x < 0.5 ? 0.39 : 0.61, y: 0.34 } });
  }
  const union = unionBoxes(critical.map(region => region.box));
  if (union) anchors.push({ id: 'critical-union', source: centerOf(union), target: { x: 0.5, y: 0.37 } });
  return uniqueAnchors(anchors);
}

function calculateConfidence(analysis, best, second) {
  const providerConfidence = clamp(Number(analysis?.foreground?.confidence ?? 0.46), 0, 1);
  const providerCount = new Set(analysis?.providers || []).size;
  const agreementBonus = Math.min(0.12, Math.max(0, providerCount - 1) * 0.06);
  const retention = 0.54 * best.foreground_retained + 0.46 * best.critical_retained;
  const occlusionQuality = clamp(1 - best.critical_occlusion, 0, 1);
  const margin = clamp((second.penalty - best.penalty) / Math.max(30, second.penalty), 0, 1);
  const fallbackPenalty = analysis?.fallback ? 0.1 : 0;
  const flagPenalty = Math.min(0.18, (analysis?.quality_flags || []).length * 0.035);
  let confidence = clamp(0.23 * providerConfidence + 0.42 * retention + 0.17 * occlusionQuality + 0.08 * margin + agreementBonus - fallbackPenalty - flagPenalty, 0.05, 0.98);

  // A numerical provider score cannot overrule an unsafe crop. High confidence
  // is reserved for crops that actually retain the detected subject and keep
  // its critical regions clear of the printed card UI. Missing a reliable
  // face/head region similarly requires human review.
  if (!(analysis?.critical_regions || []).length) confidence = Math.min(confidence, 0.68);
  if (best.foreground_retained < 0.92 || best.critical_retained < 0.98 || best.critical_occlusion > 0.05) confidence = Math.min(confidence, 0.77);
  if (best.foreground_retained < 0.72 || best.critical_retained < 0.9 || best.critical_occlusion > 0.14) confidence = Math.min(confidence, 0.54);
  return confidence;
}

function buildReasons(analysis, best, confidence) {
  const reasons = [];
  const evaluation = best.evaluation;
  if (evaluation.critical_retained >= 0.98) reasons.push('critical subject retained');
  if (evaluation.critical_occlusion <= 0.03) reasons.push('clear of card overlays');
  if (evaluation.foreground_retained >= 0.96) reasons.push('foreground retained');
  if (best.crop.scale <= 1.16) reasons.push('minimal extra zoom');
  if ((analysis?.critical_regions || []).length === 0) reasons.push('no reliable face/head box');
  if (analysis?.fallback) reasons.push('local saliency fallback');
  for (const flag of analysis?.quality_flags || []) reasons.push(String(flag).replaceAll('_', ' '));
  reasons.push(`${confidenceBand(confidence)} confidence`);
  return [...new Set(reasons)];
}

function normalizeImage(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!(width > 0 && height > 0)) throw new Error('Image dimensions must be positive.');
  return { width, height };
}

function normalizeForeground(value) {
  const box = normalizeBox(value?.box || { x: 0.12, y: 0.08, width: 0.76, height: 0.84 });
  const centroid = normalizePoint(value?.centroid || centerOf(box));
  return { ...value, box, centroid, confidence: clamp(Number(value?.confidence ?? 0.46), 0, 1) };
}

function normalizeCritical(value) {
  if (!value?.box) return null;
  return { ...value, box: normalizeBox(value.box), weight: clamp(Number(value.weight ?? 1), 0.25, 3) };
}

function normalizeBox(value) {
  const x = clamp(Number(value?.x ?? 0), 0, 1);
  const y = clamp(Number(value?.y ?? 0), 0, 1);
  const width = clamp(Number(value?.width ?? 0), 0, 1 - x);
  const height = clamp(Number(value?.height ?? 0), 0, 1 - y);
  return { x, y, width, height };
}

function normalizePoint(value) {
  return { x: clamp(Number(value?.x ?? 0.5), 0, 1), y: clamp(Number(value?.y ?? 0.5), 0, 1) };
}

function uniqueAnchors(anchors) {
  const seen = new Set();
  return anchors.filter(anchor => {
    const key = `${round(anchor.source.x, 3)}|${round(anchor.source.y, 3)}|${round(anchor.target.x, 3)}|${round(anchor.target.y, 3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toPixels(box, viewport) {
  return { x: box.x * viewport.width, y: box.y * viewport.height, width: box.width * viewport.width, height: box.height * viewport.height };
}

function overlapFraction(box, region) {
  const overlap = intersect(box, region);
  return clamp(overlap.width * overlap.height / Math.max(1e-9, box.width * box.height), 0, 1);
}

function intersect(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function centerOf(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function round(value, digits) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
