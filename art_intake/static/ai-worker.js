// Keep the worker itself a classic script, then load the ESM inference bundle
// lazily. This works in browser shells that support workers but reject module
// workers, and it lets the cheap saliency path stay available immediately.
let transformersPromise = null;

async function getTransformers() {
  if (!transformersPromise) {
    transformersPromise = import('./vendor/transformers.js').then(module => {
      module.env.allowRemoteModels = true;
      module.env.allowLocalModels = false;
      module.env.useBrowserCache = true;
      // Inference already runs off the UI thread. A nested ONNX proxy worker
      // obscures execution-provider changes when WebGPU falls back to WASM.
      if (module.env.backends?.onnx?.wasm) module.env.backends.onnx.wasm.proxy = false;
      return module;
    });
  }
  return transformersPromise;
}

const MODELS = Object.freeze({
  foreground: 'Xenova/modnet',
  detector: 'Xenova/yolos-tiny',
  classifier: 'Xenova/clip-vit-base-patch32',
});

let activePipeline = null;
let cancelledJob = null;

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'cancel') {
    cancelledJob = message.jobId;
    return;
  }
  if (message.type === 'analyze') runAnalysis(message).catch(error => fail(message.jobId, error));
  if (message.type === 'rank') runRanking(message).catch(error => fail(message.jobId, error));
});

async function runAnalysis(message) {
  const { jobId, source, characterName, image } = message;
  cancelledJob = null;
  const errors = [];
  let foreground = null;
  let detections = [];

  progress(jobId, 'foreground-model', 0, 'Loading foreground model');
  try {
    const output = await runPipeline(jobId, 'image-segmentation', MODELS.foreground, async segmenter => {
      checkCancelled(jobId);
      progress(jobId, 'foreground-inference', 0.35, 'Separating subject from background');
      return segmenter(source);
    });
    foreground = foregroundFromOutput(output, image);
  } catch (error) {
    errors.push(`foreground: ${error.message || error}`);
  } finally {
    await disposeActive();
  }

  progress(jobId, 'detector-model', 0.5, 'Loading subject detector');
  try {
    const cleanName = String(characterName || '').replaceAll('-', ' ').trim();
    const output = await runPipeline(jobId, 'object-detection', MODELS.detector, async detector => {
      checkCancelled(jobId);
      progress(jobId, 'detector-inference', 0.72, 'Finding faces and important subject regions');
      return detector(source, { threshold: 0.08 });
    });
    detections = normalizeDetections(output, image, cleanName);
  } catch (error) {
    errors.push(`detector: ${error.message || error}`);
  } finally {
    await disposeActive();
  }

  checkCancelled(jobId);
  self.postMessage({
    type: 'analysis-result',
    jobId,
    result: {
      foreground,
      critical_regions: detections.filter(item => item.critical),
      subject_regions: detections,
      providers: [foreground && MODELS.foreground, detections.length && MODELS.detector].filter(Boolean),
      errors,
    },
  });
}

async function runRanking(message) {
  const { jobId, candidates, characterName } = message;
  cancelledJob = null;
  const cleanName = String(characterName || '').replaceAll('-', ' ').trim();
  const labels = [
    `${cleanName} Marvel character`,
    `high quality comic book illustration of ${cleanName}`,
    'professional full character artwork',
    'unrelated character or random image',
    'logo, screenshot, trading card, collage, or text poster',
    'low quality or blurry image',
  ];
  const positive = new Set(labels.slice(0, 3));
  const results = [];

  progress(jobId, 'ranking-model', 0, 'Loading character relevance model');
  try {
    const ranked = await runPipeline(jobId, 'zero-shot-image-classification', MODELS.classifier, async classifier => {
      const attemptResults = [];
      for (let index = 0; index < candidates.length; index += 1) {
        checkCancelled(jobId);
        const candidate = candidates[index];
        progress(jobId, 'ranking-inference', index / Math.max(1, candidates.length), `Ranking ${index + 1} of ${candidates.length}`);
        try {
          const output = await classifier(candidate.source, labels);
          const scores = Object.fromEntries(output.map(item => [item.label, Number(item.score)]));
          const relevance = [...positive].reduce((sum, label) => sum + (scores[label] || 0), 0);
          attemptResults.push({ id: candidate.id, relevance, scores });
        } catch (error) {
          if (isRuntimeFailure(error)) throw error;
          attemptResults.push({ id: candidate.id, relevance: 0, scores: {}, error: error.message || String(error) });
        }
      }
      return attemptResults;
    });
    results.push(...ranked);
  } finally {
    await disposeActive();
  }
  self.postMessage({ type: 'ranking-result', jobId, results });
}

async function runPipeline(jobId, task, model, invoke) {
  const { pipeline } = await getTransformers();
  const progress_callback = data => {
    const fraction = Number.isFinite(data.progress) ? data.progress / 100 : null;
    self.postMessage({ type: 'model-progress', jobId, model, task, data: { status: data.status, file: data.file, progress: fraction } });
  };
  const wasmDtype = 'q8';
  // Analysis favors the broadly compatible quantized WASM graphs. This avoids
  // hardware-specific WebGPU shader/session failures found during calibration;
  // CLIP ranking remains eligible for WebGPU where throughput matters most.
  const analysisModel = model === MODELS.foreground || model === MODELS.detector;
  const attempts = !analysisModel && navigator.gpu
    ? [{ device: 'webgpu', dtype: 'fp16' }, { device: 'wasm', dtype: wasmDtype }]
    : [{ device: 'wasm', dtype: wasmDtype }];
  let lastError;
  for (const options of attempts) {
    try {
      await disposeActive();
      progress(jobId, `${task}-${options.device}`, 0, `Trying ${options.device.toUpperCase()} inference`);
      activePipeline = await pipeline(task, model, { ...options, progress_callback });
      const result = await invoke(activePipeline, options);
      await disposeActive();
      return result;
    } catch (error) {
      lastError = new Error(`${options.device}: ${error.message || error}`);
      await disposeActive();
    }
  }
  throw lastError || new Error(`Could not load ${model}`);
}

function isRuntimeFailure(error) {
  return /OrtRun|create a session|webgpu|shader|execution provider|provider type|wasm/i.test(error?.message || String(error));
}

async function disposeActive() {
  const current = activePipeline;
  activePipeline = null;
  if (current?.dispose) {
    try { await current.dispose(); } catch { /* cleanup must not hide the real result */ }
  }
}

function foregroundFromOutput(output, image) {
  const candidate = Array.isArray(output) ? output[0] : output;
  const mask = candidate?.mask || candidate;
  if (!mask) throw new Error('Foreground model returned no mask.');
  const data = mask.data || mask._data;
  const width = Number(mask.width || candidate?.width);
  const height = Number(mask.height || candidate?.height);
  const channels = Number(mask.channels || (data?.length / Math.max(1, width * height)) || 1);
  if (!data || !(width > 0 && height > 0)) throw new Error('Foreground mask had invalid dimensions.');

  let max = 0;
  const alphaIndex = channels >= 4 ? 3 : 0;
  for (let index = alphaIndex; index < data.length; index += channels) max = Math.max(max, Number(data[index]));
  const threshold = max > 1 ? max * 0.28 : 0.28;
  let minX = width, minY = height, maxX = -1, maxY = -1, sumX = 0, sumY = 0, weight = 0, border = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Number(data[(y * width + x) * channels + alphaIndex]);
      if (value <= threshold) continue;
      const normalized = max ? value / max : 1;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      sumX += x * normalized; sumY += y * normalized; weight += normalized;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border += normalized;
    }
  }
  if (maxX < minX || maxY < minY || weight <= 0) throw new Error('Foreground model produced an empty mask.');
  const box = { x: minX / width, y: minY / height, width: (maxX - minX + 1) / width, height: (maxY - minY + 1) / height };
  return {
    box,
    centroid: { x: sumX / weight / width, y: sumY / weight / height },
    coverage: Math.min(1, weight / (width * height)),
    edge_contact: Math.min(1, border / Math.max(1, weight)),
    confidence: Math.min(0.94, 0.58 + Math.min(0.3, weight / (width * height))),
    source_size: { width: Number(image.width), height: Number(image.height) },
  };
}

function normalizeDetections(output, image, characterName) {
  const width = Number(image.width);
  const height = Number(image.height);
  return (output || []).flatMap(item => {
    const box = item.box || {};
    const label = String(item.label || '').toLowerCase();
    const normalized = {
      x: clamp(Number(box.xmin) / width, 0, 1),
      y: clamp(Number(box.ymin) / height, 0, 1),
      width: clamp((Number(box.xmax) - Number(box.xmin)) / width, 0, 1),
      height: clamp((Number(box.ymax) - Number(box.ymin)) / height, 0, 1),
    };
    const isFace = /face|head|helmet/.test(label);
    const isNamed = characterName && label.includes(characterName.toLowerCase());
    const isFigure = /person|bird|cat|dog|horse|sheep|cow|elephant|bear|zebra|giraffe/.test(label);
    const detection = {
      label: item.label,
      score: Number(item.score || 0),
      box: normalized,
      critical: isFace || isNamed,
      weight: isFace ? 2.2 : isNamed ? 1.35 : 0.8,
    };
    if (!isFigure || isFace || isNamed) return [detection];
    const headWidth = normalized.width * 0.46;
    const inferredHead = {
      label: `${item.label} upper focal region`,
      score: Number(item.score || 0) * 0.78,
      box: {
        x: clamp(normalized.x + normalized.width * 0.27, 0, 1),
        y: normalized.y,
        width: clamp(headWidth, 0, 1),
        height: clamp(normalized.height * 0.3, 0, 1),
      },
      critical: true,
      inferred: true,
      weight: 1.35,
    };
    return [detection, inferredHead];
  }).filter(item => item.box.width > 0.015 && item.box.height > 0.015 && item.score >= 0.045);
}

function progress(jobId, stage, value, message) {
  self.postMessage({ type: 'progress', jobId, stage, value, message });
}

function checkCancelled(jobId) {
  if (cancelledJob === jobId) throw new Error('Cancelled');
}

function fail(jobId, error) {
  self.postMessage({ type: 'error', jobId, error: error?.message || String(error) });
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
