import { getJson, postJson } from './api.js';
import { ANALYSIS_VERSION, migrateState, normalizeCrop, defaultCrop } from './state.js';
import { solveCrop, confidenceBand } from './crop-solver.js';
import { ImageAnalyzer, analyzeSourceFallback, perceptualHash } from './image-analysis.js';
import { buildArtSearchQuery, deterministicFilter, deduplicateCandidates, rankCandidates, semanticVerificationFlags, RANKING_VERSION } from './candidate-ranker.js';
import { createVerificationSnapshot, restoreVerificationSnapshot } from './candidate-verification-cache.js';
import { PhotopeaClient } from './photopea-client.js';
import { summarizeCalibration } from './calibration.js';
import { BatchController } from './batch-controller.js';

const $ = id => document.getElementById(id);
const app = {
  queue: [], state: {}, index: 0, template: null, capabilities: {},
  localDataUrl: null, localToken: 0, importing: false, analyzing: false,
  analysis: {}, stagedCrop: {}, liveTimer: null, liveQueued: false,
  candidates: [], showAllCandidates: false, candidateRun: 0,
  calibration: { version: 1, cards: {} }, candidateInventory: {}, batchState: { status: 'idle' }, lastSavedAt: null,
  duplicateArt: {},
};
const batch = new BatchController({
  runTask: async card => {
    const count = Math.max(1, Math.min(200, Number($('searchCount').value) || 80));
    const query = buildArtSearchQuery(displayName(card.id));
    const data = await postJson('/api/search-candidates', { card_id: card.id, query, count });
    app.calibration = data.calibration || app.calibration;
    app.candidateInventory[card.id] = { count: (data.candidates || []).length, query, updated_at: new Date().toISOString() };
    markSaved(); renderCalibration();
    return { count: (data.candidates || []).length };
  },
  onUpdate: state => { app.batchState = state; renderBatchState(); syncControls(); },
});
const analyzer = new ImageAnalyzer();
const photopea = new PhotopeaClient($('photopea'), {
  onStatus: message => { $('previewStatus').textContent = message; syncControls(); },
  onReady: () => { setChip($('photopeaStatus'), 'Photopea ready', 'good'); syncControls(); },
  onPreview: source => setPreview(source),
  onError: message => { toast(message, true); setChip($('photopeaStatus'), 'Photopea retry available', 'warn'); syncControls(); },
});

function active() { return app.queue[app.index]; }
function record(card = active()) { return card ? app.state[card.id] || null : null; }
function crop(card = active()) { return normalizeCrop(app.stagedCrop[card?.id] || record(card)?.crop || defaultCrop()); }
function analysis(card = active()) { return card ? app.analysis[card.id] || record(card)?.analysis || null : null; }
function duplicateConflict(card = active()) { return card ? app.duplicateArt[card.id] || null : null; }
function hasArt() { return Boolean((app.localDataUrl || record()?.image_filename) && !duplicateConflict()); }
function artSource() { const card = active(), saved = record(); return app.localDataUrl || (saved?.image_filename ? `/art/${encodeURIComponent(card.id)}?v=${encodeURIComponent(saved.updated_at)}` : ''); }
function artKey() { const saved = record(); return app.localDataUrl ? `local-${app.localToken}` : `${saved?.image_filename || 'none'}-${saved?.updated_at || 0}`; }

function displayName(id) {
  return String(id || '').replace(/^skill\d+-/, '').replace(/^program\d+-/, '').replaceAll('-', ' ').replace(/\b\w/g, value => value.toUpperCase());
}

function setChip(element, text, tone = 'neutral') {
  element.textContent = text;
  element.className = `status-chip ${tone}`;
}

function toast(message, error = false) {
  const element = $('toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => element.classList.add('hidden'), 5200);
}

function setPreview(source) {
  const image = $('realPsdPreview');
  if (source) {
    image.src = source;
    image.classList.remove('hidden');
    $('artEmpty').classList.add('hidden');
  } else {
    image.removeAttribute('src');
    image.classList.add('hidden');
    $('artEmpty').classList.remove('hidden');
  }
}

function renderQueue() {
  const reviewed = app.queue.filter(card => ['approved', 'skipped', 'needs_review'].includes(app.state[card.id]?.status)).length;
  const approved = app.queue.filter(card => app.state[card.id]?.status === 'approved').length;
  $('progressText').textContent = `${reviewed} of ${app.queue.length} reviewed`;
  $('unresolvedText').textContent = `${approved} approved`;
  $('progressBar').style.width = `${app.queue.length ? reviewed / app.queue.length * 100 : 0}%`;
  $('queueList').replaceChildren(...app.queue.map((card, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `queue-item${index === app.index ? ' active' : ''}`;
    const label = document.createElement('span'); label.textContent = displayName(card.id);
    const dot = document.createElement('i'); dot.className = `dot ${app.duplicateArt[card.id] ? 'duplicate' : app.state[card.id]?.status || ''}`;
    button.append(label, dot);
    button.addEventListener('click', () => navigate(index));
    return button;
  }));
}

function percent(value) { return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`; }

function renderCalibration() {
  const summary = summarizeCalibration(app.calibration, app.queue);
  $('calibrationReviewed').textContent = `${summary.reviewed_count} / ${summary.target_count}`;
  $('zeroTouchMetric').textContent = percent(summary.zero_touch_rate);
  $('fallbackMetric').textContent = percent(summary.fallback_rate);
  $('safetyMetric').textContent = summary.gates.safety ? 'Clear' : `${summary.hard_failures.length} failure${summary.hard_failures.length === 1 ? '' : 's'}`;
  $('safetyMetric').classList.toggle('bad', !summary.gates.safety);
  const atCheckpoint = summary.reviewed_count > 0 && summary.reviewed_count % 12 === 0;
  $('checkpointText').textContent = atCheckpoint
    ? `Checkpoint reached at ${summary.reviewed_count}: inspect gates before continuing.`
    : `Next checkpoint: ${summary.next_checkpoint} reviewed${summary.gates.pilot_zero_touch === false ? ' · pilot zero-touch gate needs analysis' : ''}`;
  $('lastSavedText').textContent = app.lastSavedAt ? `Last local save ${app.lastSavedAt.toLocaleTimeString()}` : 'Local evidence loaded at startup';
}

function markSaved() { app.lastSavedAt = new Date(); }

function downloadReport(format) {
  const link = document.createElement('a'); link.href = `/api/calibration-report.${format}`;
  link.download = `art-desk-calibration.${format}`;
  link.className = 'hidden'; document.body.append(link); link.click();
  setTimeout(() => link.remove(), 1000);
}

function renderAnalysis() {
  const current = analysis();
  const badge = $('confidenceBadge');
  if (!current?.solution) {
    badge.classList.add('hidden');
    $('analysisSummary').textContent = hasArt() ? 'Artwork selected. Run Auto-frame to detect and position its subject.' : 'Choose artwork, then Art Desk can detect and position its subject.';
    $('analysisReasons').replaceChildren();
    return;
  }
  const confidence = Number(current.solution.confidence || 0);
  const band = confidenceBand(confidence);
  const extended = current.solution.crop?.background_mode === 'extend';
  badge.textContent = `${Math.round(confidence * 100)}% ${band}`;
  badge.className = `confidence ${band}`;
  $('analysisSummary').textContent = current.fallback
    ? `A conservative local saliency crop was applied${extended ? ' with a softened extended backdrop' : ''}. Advanced detection was unavailable or still needs review.`
    : `Subject-aware ${extended ? 'fit-and-extend composition' : 'cover crop'} applied using ${current.providers.length} analysis provider${current.providers.length === 1 ? '' : 's'}.`;
  $('analysisReasons').replaceChildren(...(current.solution.reasons || []).map(reason => {
    const span = document.createElement('span'); span.className = 'reason'; span.textContent = reason; return span;
  }));
}

function render() {
  cancelLivePreview();
  const card = active(), saved = record(), currentCrop = crop();
  const duplicate = duplicateConflict(card);
  setPreview('');
  $('cardName').textContent = displayName(card.id);
  $('cardRules').textContent = card.rules || 'No rules text in the current database.';
  setChip($('cardStatus'), duplicate ? 'duplicate art' : saved?.status || 'unstarted', duplicate ? 'bad' : saved?.status === 'approved' ? 'good' : saved?.status === 'skipped' ? 'bad' : saved?.status ? 'warn' : 'neutral');
  $('artEmpty').textContent = duplicate ? `Blocked: this saved file is identical to ${displayName(duplicate.owner_card_id)} art. Choose the correct image.` : 'Choose artwork or run Art Scout.';
  $('previewStatus').textContent = app.importing ? 'Importing artwork…' : duplicate ? `Duplicate-art safety block: ${saved?.image_filename} is identical to ${displayName(duplicate.owner_card_id)}.` : hasArt() ? `Artwork selected: ${saved?.image_filename || 'local image'}.` : 'No artwork selected.';
  setCropControls(currentCrop);
  $('urlInput').value = '';
  $('sourceInput').value = saved?.source_url || '';
  $('noteInput').value = saved?.note || '';
  $('searchQuery').value = buildArtSearchQuery(displayName(card.id));
  $('backButton').disabled = app.index === 0;
  $('nextButton').disabled = app.index === app.queue.length - 1;
  renderQueue(); renderAnalysis(); renderCalibration(); syncControls();
  photopea.prefetch(app.queue[app.index + 1]);
  loadSavedCandidates().catch(() => {});
}

function syncControls() {
  const busy = app.importing || app.analyzing;
  $('urlButton').disabled = busy;
  $('autoFrameButton').disabled = busy || !hasArt();
  $('previewPsdButton').disabled = busy || !hasArt() || !photopea.ready || photopea.isBusy();
  $('acceptButton').disabled = busy || !hasArt();
  $('reviewButton').disabled = busy;
  $('skipButton').disabled = busy;
  $('searchButton').disabled = busy || !app.capabilities.search_configured;
  const batchActive = ['running', 'paused'].includes(app.batchState.status);
  $('batchPilotButton').disabled = busy || batchActive || !app.capabilities.search_configured;
  $('batchAllButton').disabled = busy || batchActive || !app.capabilities.search_configured;
  $('searchSetup').classList.toggle('hidden', Boolean(app.capabilities.search_configured));
}

function navigate(index) {
  if (index < 0 || index >= app.queue.length || index === app.index) return;
  analyzer.cancelAll();
  photopea.cancelPending();
  app.index = index; app.localDataUrl = null; app.candidates = []; app.showAllCandidates = false;
  render();
}

function setCropControls(value) {
  setControl('scaleInput', value.scale); setControl('panXInput', value.pan_x); setControl('panYInput', value.pan_y); syncCropValues();
}

function setControl(id, value) {
  const input = $(id), number = Number(value), min = Number(input.min), max = Number(input.max);
  input.value = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function syncCropValues() {
  const scale = Number($('scaleInput').value), panX = Number($('panXInput').value), panY = Number($('panYInput').value);
  $('scaleValue').value = scale.toFixed(2); $('panXValue').value = String(panX); $('panYValue').value = String(panY);
  return { scale, pan_x: panX, pan_y: panY };
}

function stageManualCrop() {
  const values = syncCropValues();
  const previous = crop();
  const backgroundMode = values.scale < 1 || previous.background_mode === 'extend' ? 'extend' : 'cover';
  app.stagedCrop[active().id] = {
    ...values, mode: 'manual', analysis_version: ANALYSIS_VERSION,
    framing_profile: analysis()?.solution?.framing_profile ?? previous.framing_profile,
    background_mode: backgroundMode,
    extension_feather: backgroundMode === 'extend' ? (previous.extension_feather || 0.055) : 0,
    confidence: analysis()?.solution?.confidence ?? null, manual_revision: true,
  };
  $('previewStatus').textContent = `Manual ${backgroundMode === 'extend' ? 'fit-and-extend' : 'cover'} placement — ${values.scale.toFixed(2)}×, X ${signed(values.pan_x)}, Y ${signed(values.pan_y)}. Updating PSD…`;
  queueLivePreview();
}

async function autoFrame({ advanced = true, quiet = false } = {}) {
  if (!hasArt() || app.analyzing) return;
  const card = active(), source = artSource(), runCard = card.id;
  app.analyzing = true; syncControls();
  setChip($('modelStatus'), 'Analyzing subject', 'warn');
  try {
    const fallback = await analyzeSourceFallback(source);
    if (active().id !== runCard) return;
    applyAnalysis(fallback, true);
    setChip($('modelStatus'), advanced ? 'Loading advanced detection' : 'Saliency ready', advanced ? 'warn' : 'good');
    if (advanced) {
      const full = await analyzer.analyze(source, {
        characterName: displayName(card.id), advanced: true,
        onProgress: event => {
          const percent = Number.isFinite(event.value) ? ` ${Math.round(event.value * 100)}%` : '';
          setChip($('modelStatus'), `${event.message || 'Advanced detection'}${percent}`, 'warn');
        },
      });
      if (active().id !== runCard) return;
      applyAnalysis(full, false);
    }
    await persistAnalysis();
    setChip($('modelStatus'), analysis()?.fallback ? 'Fallback crop ready' : 'Advanced crop ready', analysis()?.fallback ? 'warn' : 'good');
    if (!quiet) toast('Subject-aware crop applied.');
    queueLivePreview();
  } catch (error) {
    setChip($('modelStatus'), 'Auto-frame needs review', 'bad');
    toast(`Auto-frame failed: ${error.message}`, true);
  } finally {
    app.analyzing = false; syncControls();
  }
}

function applyAnalysis(result, provisional) {
  const solution = solveCrop(result);
  const combined = { ...result, solution, provisional };
  app.analysis[active().id] = combined;
  app.stagedCrop[active().id] = solution.crop;
  setCropControls(solution.crop);
  renderAnalysis();
}

async function persistAnalysis() {
  if (!record()?.image_filename) return;
  const data = await postJson('/api/analysis', { card_id: active().id, crop: crop(), analysis: analysis() });
  if (data.record) app.state[active().id] = data.record;
  if (data.calibration) app.calibration = data.calibration;
  markSaved(); renderCalibration();
}

function queueLivePreview() {
  if (!photopea.ready || photopea.isBusy() || !hasArt()) { app.liveQueued = true; return; }
  app.liveQueued = true;
  clearTimeout(app.liveTimer);
  app.liveTimer = setTimeout(() => renderPsd('interactive'), 650);
}

function cancelLivePreview() { clearTimeout(app.liveTimer); app.liveTimer = null; app.liveQueued = false; }

async function renderPsd(mode = 'full') {
  cancelLivePreview();
  try {
    await photopea.render({ card: active(), artUrl: artSource(), artKey: artKey(), crop: crop(), mode });
  } catch (error) { toast(error.message, true); }
  finally { syncControls(); }
}

async function uploadFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) { toast('Choose an image under 25 MB.', true); return; }
  app.importing = true; syncControls(); $('previewStatus').textContent = 'Uploading and verifying local artwork…';
  try {
    const dataUrl = await fileToDataUrl(file);
    const uploaded = await postJson('/api/upload-image', { card_id: active().id, image_data_url: dataUrl, source_kind: 'local_file', source_url: $('sourceInput').value.trim() });
    app.state[active().id] = uploaded.record; app.localDataUrl = null; app.localToken += 1;
    delete app.duplicateArt[active().id];
    clearCardDerivedState(); render();
    await autoFrame({ advanced: true, quiet: true });
  } catch (error) { toast(`Could not import that file: ${error.message}`, true); }
  finally { app.importing = false; $('fileInput').value = ''; syncControls(); }
}

async function importUrl() {
  const imageUrl = $('urlInput').value.trim();
  if (!imageUrl) { toast('Paste a direct image URL first.', true); return; }
  app.importing = true; syncControls(); $('previewStatus').textContent = 'Downloading and verifying direct artwork…';
  try {
    const imported = await postJson('/api/import-url', { card_id: active().id, image_url: imageUrl, source_url: $('sourceInput').value.trim() });
    app.state[active().id] = imported.record; app.localDataUrl = null; app.localToken += 1;
    delete app.duplicateArt[active().id];
    clearCardDerivedState(); render();
    await autoFrame({ advanced: true, quiet: true });
  } catch (error) { toast(`Could not import that image: ${error.message}`, true); }
  finally { app.importing = false; syncControls(); }
}

function clearCardDerivedState() { delete app.analysis[active().id]; delete app.stagedCrop[active().id]; }

async function saveDecision(status, goNext) {
  if (status === 'approved' && !hasArt()) { toast('Choose artwork before approving.', true); return; }
  try {
    const data = await postJson('/api/decision', {
      card_id: active().id, status,
      source_kind: record()?.source_kind || 'local_file', source_url: $('sourceInput').value.trim(), note: $('noteInput').value,
      crop: crop(), analysis: analysis(), candidate_id: record()?.candidate_id || '',
    });
    app.state[active().id] = data.record;
    if (data.calibration) app.calibration = data.calibration;
    markSaved(); renderCalibration();
    toast(status === 'approved' ? 'Approved — moving to next card.' : 'Decision saved locally.');
    if (goNext && app.index < app.queue.length - 1) navigate(app.index + 1); else render();
  } catch (error) { toast(error.message, true); }
}

async function saveSearchKey() {
  const key = $('braveKeyInput').value.trim();
  if (!key) { toast('Paste a Brave Search API key first.', true); return; }
  try {
    const data = await postJson('/api/settings/search', { brave_api_key: key });
    $('braveKeyInput').value = '';
    app.capabilities.search_configured = Boolean(data.search_configured);
    syncControls(); toast('Search key saved locally.');
  } catch (error) { toast(error.message, true); }
}

async function searchCandidates() {
  const card = active(), query = buildArtSearchQuery(displayName(active().id), $('searchQuery').value.trim()), count = Number($('searchCount').value);
  if (!query) { toast('Enter an image search query.', true); return; }
  $('searchQuery').value = query;
  const run = ++app.candidateRun;
  showCandidateProgress(0.02, 'Requesting image candidates…');
  $('searchButton').disabled = true;
  try {
    const data = await postJson('/api/search-candidates', { card_id: card.id, query, count });
    if (run !== app.candidateRun || active().id !== card.id) return;
    if (data.calibration) app.calibration = data.calibration;
    app.candidateInventory[card.id] = { count: (data.candidates || []).length, query, updated_at: new Date().toISOString() };
    markSaved(); renderCalibration();
    await prepareCandidates(data.candidates || [], run);
  } catch (error) { toast(`Art Scout search failed: ${error.message}`, true); hideCandidateProgress(); }
  finally { syncControls(); }
}

async function loadSavedCandidates() {
  const card = active(), run = ++app.candidateRun;
  const data = await getJson(`/api/candidates/${encodeURIComponent(card.id)}`);
  if (run !== app.candidateRun || active().id !== card.id) return;
  const raw = data.candidates || [];
  if (!raw.length) { app.candidates = []; renderCandidates(); return; }
  const eligible = deterministicFilter(raw, { characterName: displayName(card.id) }).filter(item => !item.rejected);
  const restored = restoreVerificationSnapshot(raw, eligible, readVerificationSnapshot(card.id), RANKING_VERSION);
  if (restored) {
    app.candidates = rankCandidates(restored.candidates); renderCandidates();
    renderScoutSummary(restored.summary, app.candidates.length);
    return;
  }
  app.candidates = []; renderCandidates();
  $('scoutSummary').textContent = 'Saved candidates found · verifying identity and artwork before anything is shown…';
  await prepareCandidates(raw, run);
}

async function prepareCandidates(input, run) {
  const filtered = deterministicFilter(input, { characterName: displayName(active().id) });
  const usableAll = filtered.filter(candidate => !candidate.rejected);
  const filteredCount = filtered.length - usableAll.length;
  // Spend the expensive hashing/framing/model budget on the strongest
  // metadata candidates, not merely the provider's first 24 results.
  const usable = rankCandidates(usableAll).slice(0, 24);
  const prepared = [];
  for (let index = 0; index < usable.length; index += 1) {
    if (run !== app.candidateRun) return;
    const candidate = usable[index], source = candidateSource(candidate);
    showCandidateProgress(0.05 + index / Math.max(1, usable.length) * 0.5, `Inspecting candidate ${index + 1} of ${usable.length}`);
    try {
      const [hash, candidateAnalysis] = await Promise.all([perceptualHash(source), analyzeSourceFallback(source)]);
      const solution = solveCrop(candidateAnalysis);
      prepared.push({ ...candidate, hash, analysis: candidateAnalysis, suggested_crop: solution.crop, composition_confidence: solution.confidence, unavailable: false });
    } catch (error) {
      prepared.push({ ...candidate, unavailable: true, error: error.message || String(error), composition_confidence: 0 });
    }
  }
  const available = prepared.filter(candidate => !candidate.unavailable);
  const unavailableCount = prepared.length - available.length;
  const deduped = deduplicateCandidates(available);
  let ranked = rankCandidates(deduped.unique);
  let semanticFilteredCount = 0;

  if (ranked.length) {
    showCandidateProgress(0.62, 'Measuring character relevance…');
    try {
      const semantic = await analyzer.rank(ranked.map(candidate => ({ id: candidate.id, source: candidateSource(candidate) })), displayName(active().id), event => showCandidateProgress(0.62 + (Number(event.value) || 0) * 0.34, event.message || 'Ranking candidates'));
      const byId = new Map(semantic.map(item => [item.id, item]));
      const verified = ranked.map(candidate => {
        const result = byId.get(candidate.id) || {};
        const enriched = {
          ...candidate, semantic_relevance: result.relevance ?? 0.35, semantic_scores: result.scores || {},
          semantic_identity: result.identity_score, semantic_artwork: result.artwork_score,
          semantic_wrong_character: result.wrong_character_score, semantic_rendered_card: result.rendered_card_score,
          semantic_merchandise: result.merchandise_score, semantic_photo: result.photo_score,
          semantic_tutorial: result.tutorial_score,
        };
        const semanticFlags = semanticVerificationFlags(enriched);
        return { ...enriched, filter_flags: [...new Set([...(enriched.filter_flags || []), ...semanticFlags])], semantic_rejected: semanticFlags.length > 0 };
      });
      semanticFilteredCount = verified.filter(candidate => candidate.semantic_rejected).length;
      ranked = rankCandidates(verified.filter(candidate => !candidate.semantic_rejected));
    } catch (error) {
      toast(`Semantic ranking used deterministic fallback: ${error.message}`, true);
    }
  }
  const summary = {
    input_count: input.length, filtered_count: filteredCount, semantic_filtered_count: semanticFilteredCount,
    available_count: available.length, shortlisted_count: usable.length, unavailable_count: unavailableCount,
    duplicate_count: deduped.removed,
  };
  writeVerificationSnapshot(active().id, createVerificationSnapshot(input, ranked, RANKING_VERSION, summary));
  app.candidates = ranked; renderCandidates(); hideCandidateProgress(); renderScoutSummary(summary, ranked.length);
  if (!available.length && usable.length) toast('No shortlisted thumbnails could be inspected. The saved discovery set is intact; retry when image hosts are reachable.', true);
}

function renderScoutSummary(summary, finalistCount) {
  const visible = Math.min(6, finalistCount);
  $('scoutSummary').textContent = `${summary.input_count || 0} discovered · ${summary.filtered_count || 0} metadata mismatch${summary.filtered_count === 1 ? '' : 'es'} filtered · ${summary.semantic_filtered_count || 0} visual mismatch${summary.semantic_filtered_count === 1 ? '' : 'es'} filtered · ${summary.available_count || 0}/${summary.shortlisted_count || 0} thumbnails inspected · ${summary.unavailable_count || 0} unavailable · ${summary.duplicate_count || 0} near-duplicate${summary.duplicate_count === 1 ? '' : 's'} removed · showing ${visible} verified finalist${visible === 1 ? '' : 's'}`;
}

function verificationStorageKey(cardId) { return `art-desk.candidate-verification.v1.${cardId}`; }
function readVerificationSnapshot(cardId) {
  try { return JSON.parse(localStorage.getItem(verificationStorageKey(cardId)) || 'null'); }
  catch { return null; }
}
function writeVerificationSnapshot(cardId, snapshot) {
  try { localStorage.setItem(verificationStorageKey(cardId), JSON.stringify(snapshot)); }
  catch { /* verification still applies for the current session */ }
}

function unresolvedWithoutCandidates() {
  return app.queue.filter(card => !['approved', 'skipped'].includes(app.state[card.id]?.status) && !app.candidateInventory[card.id]?.count);
}

function startBatch(limit = null) {
  const cards = unresolvedWithoutCandidates();
  const selected = limit ? cards.slice(0, limit) : cards;
  if (!selected.length) { toast('Every unresolved card already has a saved candidate set.'); return; }
  batch.start(selected).then(result => {
    const found = result.completed.reduce((sum, entry) => sum + Number(entry.result?.count || 0), 0);
    toast(`Batch ${result.status}: ${result.completed.length} cards, ${found} candidates, ${result.failed.length} failures.`, result.failed.length > 0);
  }).catch(error => toast(error.message, true));
}

function renderBatchState() {
  const state = app.batchState;
  const activeState = ['running', 'paused'].includes(state.status);
  $('batchPauseButton').classList.toggle('hidden', !activeState);
  $('batchCancelButton').classList.toggle('hidden', !activeState);
  $('batchPauseButton').textContent = state.status === 'paused' ? 'Resume' : 'Pause';
  if (state.status === 'idle') return;
  const processed = (state.completed?.length || 0) + (state.failed?.length || 0);
  const current = state.current ? ` · ${displayName(state.current.id)}` : '';
  $('batchStatus').textContent = `${state.status[0].toUpperCase()}${state.status.slice(1)} · ${processed}/${state.total} processed · ${state.failed?.length || 0} failed${current}`;
}

function candidateSource(candidate) { return `/candidate-thumb/${encodeURIComponent(active().id)}/${encodeURIComponent(candidate.id)}`; }

function renderCandidates() {
  const visible = app.showAllCandidates ? app.candidates : app.candidates.slice(0, 6);
  $('candidateGrid').replaceChildren(...visible.map(candidate => {
    const card = document.createElement('article'); card.className = `candidate-card${record()?.candidate_id === candidate.id ? ' selected' : ''}`;
    const imageWrap = document.createElement('div'); imageWrap.className = 'candidate-image';
    const image = document.createElement('img'); image.loading = 'lazy'; image.src = candidateSource(candidate); image.alt = candidate.title || 'Artwork candidate';
    const rank = document.createElement('span'); rank.className = 'candidate-rank'; rank.textContent = `#${candidate.display_rank || '?'}`;
    imageWrap.append(image, rank);
    const body = document.createElement('div'); body.className = 'candidate-body';
    const title = document.createElement('p'); title.className = 'candidate-title'; title.textContent = candidate.title || 'Untitled candidate';
    const metrics = document.createElement('div'); metrics.className = 'candidate-metrics';
    metrics.append(metric(`${candidate.width || '?'}×${candidate.height || '?'}`), metric('identity matched'), metric('art-only'), metric(`${Math.round((candidate.composition_confidence || 0) * 100)}% framing`));
    const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = 'Use this artwork'; choose.addEventListener('click', () => selectCandidate(candidate));
    const source = document.createElement('a'); source.href = candidate.source_page_url || candidate.original_url; source.target = '_blank'; source.rel = 'noreferrer'; source.textContent = 'Open source page';
    body.append(title, metrics, choose, source); card.append(imageWrap, body); return card;
  }));
  $('showAllCandidatesButton').classList.toggle('hidden', app.candidates.length <= 6);
  $('showAllCandidatesButton').textContent = app.showAllCandidates ? 'Show top six' : `Show all ${app.candidates.length}`;
}

function metric(text) { const span = document.createElement('span'); span.textContent = text; return span; }

async function selectCandidate(candidate) {
  app.importing = true; syncControls(); $('previewStatus').textContent = 'Downloading selected full-resolution artwork…';
  try {
    const data = await postJson('/api/select-candidate', { card_id: active().id, candidate_id: candidate.id });
    app.state[active().id] = data.record; delete app.duplicateArt[active().id]; clearCardDerivedState(); render();
    if (candidate.analysis && candidate.suggested_crop) {
      const solution = solveCrop(candidate.analysis);
      app.analysis[active().id] = { ...candidate.analysis, solution, provisional: true };
      app.stagedCrop[active().id] = solution.crop;
    }
    await autoFrame({ advanced: true, quiet: true });
  } catch (error) { toast(`Could not select candidate: ${error.message}`, true); }
  finally { app.importing = false; syncControls(); }
}

function showCandidateProgress(value, text) { const container = $('candidateProgress'); container.classList.remove('hidden'); container.querySelector('div').style.width = `${Math.max(0, Math.min(1, value || 0)) * 100}%`; container.querySelector('span').textContent = text; }
function hideCandidateProgress() { $('candidateProgress').classList.add('hidden'); }

function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error || new Error('Could not read file.')); reader.readAsDataURL(file); }); }
function signed(value) { return value > 0 ? `+${value}` : String(value); }

function bindEvents() {
  $('fileInput').addEventListener('change', event => uploadFile(event.target.files?.[0]));
  $('urlButton').addEventListener('click', importUrl);
  $('autoFrameButton').addEventListener('click', () => autoFrame({ advanced: true }));
  $('resetCropButton').addEventListener('click', () => { app.stagedCrop[active().id] = defaultCrop('manual'); setCropControls(app.stagedCrop[active().id]); stageManualCrop(); });
  $('previewPsdButton').addEventListener('click', () => renderPsd('full'));
  $('backButton').addEventListener('click', () => navigate(app.index - 1));
  $('nextButton').addEventListener('click', () => navigate(app.index + 1));
  $('acceptButton').addEventListener('click', () => saveDecision('approved', true));
  $('reviewButton').addEventListener('click', () => saveDecision('needs_review', false));
  $('skipButton').addEventListener('click', () => saveDecision('skipped', true));
  $('saveSearchKeyButton').addEventListener('click', saveSearchKey);
  $('searchButton').addEventListener('click', searchCandidates);
  $('batchPilotButton').addEventListener('click', () => startBatch(12));
  $('batchAllButton').addEventListener('click', () => startBatch());
  $('batchPauseButton').addEventListener('click', () => app.batchState.status === 'paused' ? batch.resume() : batch.pause());
  $('batchCancelButton').addEventListener('click', () => batch.cancel());
  $('exportJsonButton').addEventListener('click', () => downloadReport('json'));
  $('exportCsvButton').addEventListener('click', () => downloadReport('csv'));
  $('showAllCandidatesButton').addEventListener('click', () => { app.showAllCandidates = !app.showAllCandidates; renderCandidates(); });
  for (const [rangeId, numberId] of [['scaleInput', 'scaleValue'], ['panXInput', 'panXValue'], ['panYInput', 'panYValue']]) {
    const range = $(rangeId), number = $(numberId);
    const fromRange = () => { number.value = rangeId === 'scaleInput' ? Number(range.value).toFixed(2) : range.value; stageManualCrop(); };
    const fromNumber = () => { if (number.value === '') return; setControl(rangeId, number.value); fromRange(); };
    range.addEventListener('input', fromRange); range.addEventListener('change', fromRange);
    number.addEventListener('input', fromNumber); number.addEventListener('change', fromNumber);
  }
  document.addEventListener('keydown', event => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (event.key.toLowerCase() === 'a') saveDecision('approved', true);
    if (event.key.toLowerCase() === 's') saveDecision('skipped', true);
    if (event.key === 'ArrowLeft') navigate(app.index - 1);
    if (event.key === 'ArrowRight') navigate(app.index + 1);
  });
}

async function bootstrap() {
  bindEvents(); photopea.start();
  try {
    const data = await getJson('/api/bootstrap');
    app.queue = (Array.isArray(data.queue) ? data.queue : data.queue?.value || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { sensitivity: 'base' }));
    app.state = migrateState(data.state || {}); app.template = data.template; app.capabilities = data.capabilities || {};
    app.calibration = data.calibration || { version: 1, cards: {} }; app.candidateInventory = data.candidate_inventory || {}; app.duplicateArt = data.duplicate_art || {};
    const unfinished = app.queue.findIndex(card => !app.state[card.id]?.status || ['selected', 'needs_review'].includes(app.state[card.id]?.status));
    app.index = unfinished >= 0 ? unfinished : 0;
    $('queueKind').textContent = data.queue_kind || 'Real-PSD calibration queue';
    $('templateInfo').textContent = `${data.template.width} × ${data.template.height} document · ${data.template.source}`;
    setChip($('modelStatus'), 'Saliency ready · advanced AI on first use', 'good');
    render();
  } catch (error) { toast(`Could not start Art Desk: ${error.message}`, true); setChip($('modelStatus'), 'Startup failed', 'bad'); }
}

bootstrap();
