import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationCsv, classifyOutcome, cropDelta, summarizeCalibration } from '../static/calibration.js';

const autoCrop = { scale: 1.2, pan_x: 3, pan_y: -4, manual_revision: false };

test('crop delta is stable and classifies untouched automatic approvals', () => {
  assert.deepEqual(cropDelta(autoCrop, { ...autoCrop }), { scale_percent: 0, pan_distance: 0, score: 0 });
  assert.equal(classifyOutcome({ status: 'approved', confidence_band: 'high', baseline_crop: autoCrop, final_crop: { ...autoCrop } }), 'zero_touch');
});

test('low confidence never counts as zero-touch and revisions are graded', () => {
  assert.equal(classifyOutcome({ status: 'approved', confidence_band: 'low', baseline_crop: autoCrop, final_crop: { ...autoCrop } }), 'minor_adjustment');
  assert.equal(classifyOutcome({ status: 'approved', confidence_band: 'high', baseline_crop: autoCrop, final_crop: { ...autoCrop, pan_x: 7, manual_revision: true } }), 'minor_adjustment');
  assert.equal(classifyOutcome({ status: 'approved', confidence_band: 'high', baseline_crop: autoCrop, final_crop: { ...autoCrop, scale: 1.8, pan_x: 50, manual_revision: true } }), 'major_adjustment');
});

test('summary detects safety failures and checkpoint gates', () => {
  const cards = {};
  for (let index = 0; index < 12; index += 1) {
    cards[`c${index}`] = {
      status: 'approved', confidence_band: 'high', baseline_confidence: 0.9,
      baseline_crop: autoCrop, final_crop: { ...autoCrop }, fallback: index === 0,
      latest_analysis: { solution: { evaluation: { critical_retained: index === 11 ? 0.95 : 1, critical_occlusion: 0 } } },
    };
  }
  cards.c10.final_crop = { ...autoCrop, pan_x: 60, manual_revision: true };
  const summary = summarizeCalibration({ cards }, Object.keys(cards));
  assert.equal(summary.reviewed_count, 12);
  assert.equal(summary.next_checkpoint, 12);
  assert.equal(summary.gates.pilot_zero_touch, true);
  assert.deepEqual(summary.hard_failures, ['c11']);
  assert.equal(summary.gates.safety, false);
  assert.match(calibrationCsv(summary), /^card_id,status,/);
  assert.equal(calibrationCsv(summary).trim().split('\n').length, 13);
});

test('empty and partially migrated sessions summarize safely', () => {
  const summary = summarizeCalibration(null, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(summary.reviewed_count, 0);
  assert.equal(summary.zero_touch_rate, null);
  assert.equal(summary.next_checkpoint, 2);
});
