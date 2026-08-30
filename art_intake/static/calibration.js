export const CALIBRATION_VERSION = 1;
export const CHECKPOINT_SIZE = 12;
export const MINOR_DELTA_LIMIT = 12;

const round = (value, digits = 3) => Number(Number(value || 0).toFixed(digits));

export function confidenceBand(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 'unknown';
  if (confidence >= 0.78) return 'high';
  if (confidence >= 0.55) return 'medium';
  return 'low';
}

export function cropDelta(baseline, finalCrop) {
  if (!baseline || !finalCrop) return null;
  const baseScale = Math.max(0.01, Number(baseline.scale) || 1);
  const finalScale = Math.max(0.01, Number(finalCrop.scale) || 1);
  const scalePercent = Math.abs(finalScale / baseScale - 1) * 100;
  const panX = (Number(finalCrop.pan_x) || 0) - (Number(baseline.pan_x) || 0);
  const panY = (Number(finalCrop.pan_y) || 0) - (Number(baseline.pan_y) || 0);
  const panDistance = Math.hypot(panX, panY);
  return {
    scale_percent: round(scalePercent),
    pan_distance: round(panDistance),
    score: round(scalePercent + panDistance * 0.5),
  };
}

export function classifyOutcome(card) {
  if (!card || !['approved', 'needs_review', 'skipped'].includes(card.status)) return 'unreviewed';
  if (card.status === 'skipped') return 'skipped';
  const band = card.confidence_band || confidenceBand(card.baseline_confidence);
  const delta = cropDelta(card.baseline_crop, card.final_crop);
  if (!delta) return card.status === 'needs_review' ? 'needs_review' : 'unknown';
  const manuallyRevised = Boolean(card.final_crop?.manual_revision);
  if (card.status === 'approved' && band !== 'low' && !manuallyRevised && delta.score <= 0.5) return 'zero_touch';
  if (card.status === 'needs_review') return 'needs_review';
  return delta.score <= MINOR_DELTA_LIMIT ? 'minor_adjustment' : 'major_adjustment';
}

function metricFromAnalysis(card, names) {
  const analysis = card?.latest_analysis || {};
  const layers = [analysis.solution?.evaluation, analysis.solution, analysis.metrics, analysis];
  for (const layer of layers) {
    for (const name of names) {
      const value = Number(layer?.[name]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

export function summarizeCalibration(session, queue = []) {
  const cards = session?.cards || {};
  const queueIds = queue.map(item => typeof item === 'string' ? item : item.id);
  const ids = queueIds.length ? queueIds : Object.keys(cards);
  const rows = ids.map(id => {
    const card = cards[id] || {};
    const outcome = classifyOutcome(card);
    return {
      card_id: id,
      status: card.status || 'unreviewed',
      confidence_band: card.confidence_band || confidenceBand(card.baseline_confidence),
      outcome,
      fallback: Boolean(card.fallback),
      crop_delta: cropDelta(card.baseline_crop, card.final_crop),
      critical_retention: metricFromAnalysis(card, ['critical_retained', 'critical_retention', 'critical_visibility']),
      critical_occlusion: metricFromAnalysis(card, ['critical_occlusion', 'critical_occlusion_ratio']),
      candidate_count: Number(card.candidate_count) || 0,
      provider_failures: Number(card.provider_failures) || 0,
    };
  });
  const reviewed = rows.filter(row => row.outcome !== 'unreviewed');
  const analyzed = rows.filter(row => row.confidence_band !== 'unknown');
  const eligible = reviewed.filter(row => !['low', 'unknown'].includes(row.confidence_band) && !['skipped', 'needs_review', 'unknown'].includes(row.outcome));
  const zeroTouch = eligible.filter(row => row.outcome === 'zero_touch').length;
  const hardFailures = rows.filter(row => row.confidence_band === 'high' && (
    (row.critical_retention !== null && row.critical_retention < 0.98)
    || (row.critical_occlusion !== null && row.critical_occlusion > 0.05)
  ));
  const fallbackCount = analyzed.filter(row => row.fallback).length;
  const nextCheckpoint = reviewed.length >= ids.length
    ? ids.length
    : Math.min(ids.length, (Math.floor(reviewed.length / CHECKPOINT_SIZE) + 1) * CHECKPOINT_SIZE);
  return {
    version: CALIBRATION_VERSION,
    target_count: ids.length,
    analyzed_count: analyzed.length,
    reviewed_count: reviewed.length,
    next_checkpoint: nextCheckpoint,
    confidence: Object.fromEntries(['high', 'medium', 'low', 'unknown'].map(band => [band, rows.filter(row => row.confidence_band === band).length])),
    outcomes: Object.fromEntries(['zero_touch', 'minor_adjustment', 'major_adjustment', 'needs_review', 'skipped', 'unknown', 'unreviewed'].map(outcome => [outcome, rows.filter(row => row.outcome === outcome).length])),
    zero_touch_rate: eligible.length ? round(zeroTouch / eligible.length, 4) : null,
    fallback_rate: analyzed.length ? round(fallbackCount / analyzed.length, 4) : null,
    hard_failures: hardFailures.map(row => row.card_id),
    gates: {
      safety: hardFailures.length === 0,
      pilot_zero_touch: reviewed.length < 12 || eligible.length === 0 ? null : zeroTouch / eligible.length >= 0.85,
      fallback: analyzed.length === 0 ? null : fallbackCount / analyzed.length <= 0.10,
    },
    rows,
  };
}

export function calibrationCsv(summary) {
  const headers = ['card_id', 'status', 'confidence_band', 'outcome', 'fallback', 'delta_score', 'scale_percent', 'pan_distance', 'critical_retention', 'critical_occlusion', 'candidate_count', 'provider_failures'];
  const cells = value => value === null || value === undefined ? '' : String(value);
  const lines = summary.rows.map(row => [
    row.card_id, row.status, row.confidence_band, row.outcome, row.fallback,
    row.crop_delta?.score, row.crop_delta?.scale_percent, row.crop_delta?.pan_distance,
    row.critical_retention, row.critical_occlusion, row.candidate_count, row.provider_failures,
  ].map(cells).join(','));
  return `${headers.join(',')}\n${lines.join('\n')}\n`;
}
