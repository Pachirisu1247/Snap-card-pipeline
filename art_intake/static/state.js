export const ANALYSIS_VERSION = 4;

export function defaultCrop(mode = 'manual') {
  return {
    scale: 1,
    pan_x: 0,
    pan_y: 0,
    mode,
    analysis_version: mode === 'auto' ? ANALYSIS_VERSION : null,
    framing_profile: mode === 'auto' ? 'snap-extended-v1' : null,
    background_mode: 'cover',
    extension_feather: 0,
    confidence: null,
    manual_revision: mode === 'manual',
  };
}

export function normalizeCrop(value) {
  const input = value && typeof value === 'object' ? value : {};
  const mode = input.mode === 'auto' ? 'auto' : 'manual';
  return {
    scale: finiteRange(input.scale, 0.5, 3, 1),
    pan_x: finiteRange(input.pan_x, -100, 100, 0),
    pan_y: finiteRange(input.pan_y, -100, 100, 0),
    mode,
    analysis_version: numberOrNull(input.analysis_version),
    framing_profile: input.framing_profile ? String(input.framing_profile) : null,
    background_mode: input.background_mode === 'extend' ? 'extend' : 'cover',
    extension_feather: finiteRange(input.extension_feather, 0, 0.2, 0),
    confidence: numberOrNull(input.confidence),
    manual_revision: Boolean(input.manual_revision ?? mode === 'manual'),
  };
}

export function migrateRecord(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...value,
    crop: normalizeCrop(value.crop),
    analysis: value.analysis && typeof value.analysis === 'object' ? value.analysis : null,
    candidate_id: String(value.candidate_id || ''),
  };
}

export function migrateState(cards) {
  const output = {};
  for (const [id, value] of Object.entries(cards || {})) output[id] = migrateRecord(value);
  return output;
}

function finiteRange(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
