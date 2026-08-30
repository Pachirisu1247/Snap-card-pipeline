const FALLBACK_SIZE = 176;

export class ImageAnalyzer {
  constructor(workerUrl = '/static/ai-worker.js') {
    this.worker = null;
    this.workerUrl = workerUrl;
    this.jobs = new Map();
    this.nextJob = 1;
  }

  async analyze(source, { characterName = '', advanced = true, onProgress = () => {} } = {}) {
    onProgress({ stage: 'saliency', value: 0.04, message: 'Inspecting image structure' });
    const { bitmap, dataUrl } = await loadBitmap(source);
    let fallback;
    try {
      fallback = await analyzeBitmap(bitmap);
    } finally {
      bitmap.close?.();
    }
    if (!advanced || typeof Worker === 'undefined') return fallback;

    try {
      const ai = await this.runWorker('analyze', {
        source: dataUrl || absoluteSource(source),
        characterName,
        image: fallback.image,
      }, onProgress);
      return mergeAnalysis(fallback, ai);
    } catch (error) {
      return {
        ...fallback,
        fallback: true,
        quality_flags: [...new Set([...fallback.quality_flags, 'advanced_ai_unavailable'])],
        errors: [...(fallback.errors || []), error.message || String(error)],
      };
    }
  }

  async rank(candidates, characterName, onProgress = () => {}) {
    if (typeof Worker === 'undefined') throw new Error('Browser workers are unavailable.');
    return this.runWorker('rank', { candidates, characterName }, onProgress);
  }

  cancelAll() {
    for (const jobId of this.jobs.keys()) this.worker?.postMessage({ type: 'cancel', jobId });
    for (const job of this.jobs.values()) job.reject(new Error('Cancelled'));
    this.jobs.clear();
  }

  runWorker(type, payload, onProgress) {
    if (!this.worker) {
      this.worker = new Worker(this.workerUrl);
      this.worker.addEventListener('message', event => this.handleWorkerMessage(event.data || {}));
      this.worker.addEventListener('error', event => {
        const location = [event.filename, event.lineno, event.colno].filter(Boolean).join(':');
        const error = new Error(`${event.message || 'AI worker failed to load'}${location ? ` (${location})` : ''}`);
        console.error('Art Desk AI worker error:', error.message);
        for (const job of this.jobs.values()) job.reject(error);
        this.jobs.clear();
        this.worker?.terminate();
        this.worker = null;
      });
    }
    const jobId = this.nextJob++;
    return new Promise((resolve, reject) => {
      this.jobs.set(jobId, { resolve, reject, onProgress, type });
      this.worker.postMessage({ type, jobId, ...payload });
    });
  }

  handleWorkerMessage(message) {
    const job = this.jobs.get(message.jobId);
    if (!job) return;
    if (message.type === 'progress') job.onProgress(message);
    if (message.type === 'model-progress') job.onProgress({ stage: 'model-download', value: message.data?.progress, message: `${message.model}: ${message.data?.status || 'loading'}` });
    if (message.type === 'analysis-result') {
      this.jobs.delete(message.jobId);
      job.resolve(message.result);
    }
    if (message.type === 'ranking-result') {
      this.jobs.delete(message.jobId);
      job.resolve(message.results);
    }
    if (message.type === 'error') {
      this.jobs.delete(message.jobId);
      job.reject(new Error(message.error || 'AI worker failed.'));
    }
  }
}

export async function analyzeSourceFallback(source) {
  const { bitmap } = await loadBitmap(source);
  try { return await analyzeBitmap(bitmap); }
  finally { bitmap.close?.(); }
}

export async function perceptualHash(source) {
  const { bitmap } = await loadBitmap(source);
  try {
    const canvas = new OffscreenCanvas(9, 8);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, 9, 8);
    const data = context.getImageData(0, 0, 9, 8).data;
    let bits = '';
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const left = luminance(data, (y * 9 + x) * 4);
        const right = luminance(data, (y * 9 + x + 1) * 4);
        bits += left > right ? '1' : '0';
      }
    }
    return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
  } finally { bitmap.close?.(); }
}

export function hashDistance(left, right) {
  if (!/^[0-9a-f]{16}$/i.test(left || '') || !/^[0-9a-f]{16}$/i.test(right || '')) return 64;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

export function analyzeImageData(imageData) {
  const { width, height, data } = imageData;
  const pixels = width * height;
  const luma = new Float32Array(pixels);
  const red = new Float32Array(pixels);
  const green = new Float32Array(pixels);
  const blue = new Float32Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    red[index] = data[offset]; green[index] = data[offset + 1]; blue[index] = data[offset + 2];
    luma[index] = 0.2126 * red[index] + 0.7152 * green[index] + 0.0722 * blue[index];
  }

  const borderColor = averageBorder(red, green, blue, width, height);
  const integral = makeIntegral(luma, width, height);
  const saliency = new Float32Array(pixels);
  const contrastValues = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const local = boxMean(integral, width, height, x, y, 7);
      const contrast = Math.abs(luma[index] - local) / 255;
      const gx = Math.abs(luma[index + 1] - luma[index - 1]) / 255;
      const gy = Math.abs(luma[index + width] - luma[index - width]) / 255;
      const colorDistance = Math.sqrt((red[index] - borderColor.r) ** 2 + (green[index] - borderColor.g) ** 2 + (blue[index] - borderColor.b) ** 2) / 441.67;
      const nx = (x + 0.5) / width - 0.5;
      const ny = (y + 0.5) / height - 0.45;
      const centerPrior = Math.max(0, 1 - Math.hypot(nx / 0.75, ny / 0.82));
      saliency[index] = 0.5 * contrast + 0.18 * Math.min(1, gx + gy) + 0.26 * colorDistance + 0.06 * centerPrior;
      contrastValues.push(saliency[index]);
    }
  }

  const threshold = percentile(contrastValues, 0.67);
  let mask = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) mask[index] = saliency[index] >= threshold ? 1 : 0;
  mask = erode(dilate(mask, width, height), width, height);
  const components = connectedComponents(mask, saliency, width, height);
  const retained = selectComponents(components, width, height);
  const retainedSet = new Set(retained.map(component => component.id));
  const foregroundMask = new Uint8Array(pixels);
  let minX = width, minY = height, maxX = 0, maxY = 0, sumX = 0, sumY = 0, sumWeight = 0, edgePixels = 0, keptPixels = 0;
  for (const component of components) {
    if (!retainedSet.has(component.id)) continue;
    for (const index of component.pixels) {
      foregroundMask[index] = 1;
      const x = index % width, y = Math.floor(index / width), weight = Math.max(0.001, saliency[index]);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      sumX += x * weight; sumY += y * weight; sumWeight += weight; keptPixels += 1;
      if (x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2) edgePixels += 1;
    }
  }
  if (!retained.length || keptPixels < pixels * 0.008) {
    minX = Math.round(width * 0.12); minY = Math.round(height * 0.08); maxX = Math.round(width * 0.88); maxY = Math.round(height * 0.92);
    sumX = width / 2; sumY = height * 0.47; sumWeight = 1; keptPixels = Math.round(pixels * 0.5);
  }
  const box = { x: minX / width, y: minY / height, width: (maxX - minX + 1) / width, height: (maxY - minY + 1) / height };
  const centroid = { x: sumX / sumWeight / width, y: sumY / sumWeight / height };
  const spread = percentile(contrastValues, 0.9) - percentile(contrastValues, 0.3);
  const confidence = clamp(0.34 + spread * 0.9 + Math.min(0.18, keptPixels / pixels * 0.4) - Math.min(0.15, retained.length * 0.015), 0.28, 0.72);
  const qualityFlags = [];
  if (spread < 0.08) qualityFlags.push('low_visual_contrast');
  if (retained.length > 8) qualityFlags.push('fragmented_foreground');
  if (edgePixels / Math.max(1, keptPixels) > 0.08) qualityFlags.push('subject_touches_image_edge');
  const upperFocus = upperFocusRegion(foregroundMask, saliency, box, width, height);

  return {
    foreground: { box, centroid, coverage: keptPixels / pixels, edge_contact: edgePixels / Math.max(1, keptPixels), confidence },
    critical_regions: upperFocus ? [upperFocus] : [],
    quality_flags: qualityFlags,
  };
}

async function analyzeBitmap(bitmap) {
  const scale = Math.min(1, FALLBACK_SIZE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(32, Math.round(bitmap.width * scale));
  const height = Math.max(32, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  const result = analyzeImageData(context.getImageData(0, 0, width, height));
  const faces = await detectFaces(bitmap);
  return {
    version: 4,
    image: { width: bitmap.width, height: bitmap.height },
    ...result,
    critical_regions: faces.length ? faces : result.critical_regions,
    providers: ['saliency-v1', ...(faces.length ? ['browser-face-detector'] : [])],
    fallback: true,
    errors: [],
  };
}

async function detectFaces(bitmap) {
  if (typeof globalThis.FaceDetector !== 'function') return [];
  try {
    const detector = new globalThis.FaceDetector({ fastMode: true, maxDetectedFaces: 6 });
    const faces = await detector.detect(bitmap);
    return faces.map(face => ({
      label: 'face', score: 0.82,
      box: { x: face.boundingBox.x / bitmap.width, y: face.boundingBox.y / bitmap.height, width: face.boundingBox.width / bitmap.width, height: face.boundingBox.height / bitmap.height },
      critical: true, weight: 2.3,
    }));
  } catch { return []; }
}

function mergeAnalysis(fallback, ai) {
  const foreground = ai?.foreground || fallback.foreground;
  const critical = [...(ai?.critical_regions || []), ...(fallback.critical_regions || [])];
  const deduped = critical.filter((item, index) => !critical.slice(0, index).some(other => boxIoU(item.box, other.box) > 0.72));
  const providers = [...new Set([...(fallback.providers || []), ...(ai?.providers || [])])];
  const errors = [...(fallback.errors || []), ...(ai?.errors || [])];
  return {
    ...fallback,
    foreground,
    critical_regions: deduped,
    providers,
    fallback: !(ai?.foreground || ai?.critical_regions?.length),
    quality_flags: [...new Set([...fallback.quality_flags, ...(errors.length ? ['partial_ai_failure'] : [])])],
    errors,
  };
}

async function loadBitmap(source) {
  if (source instanceof Blob) return { bitmap: await createImageBitmap(source), dataUrl: await blobToDataUrl(source) };
  if (source instanceof File) return { bitmap: await createImageBitmap(source), dataUrl: await blobToDataUrl(source) };
  const response = await fetch(source, { cache: 'no-store' });
  if (!response.ok) throw new Error('Selected artwork could not be loaded for analysis.');
  const blob = await response.blob();
  return { bitmap: await createImageBitmap(blob), dataUrl: String(source).startsWith('data:') ? String(source) : null };
}

function absoluteSource(source) {
  if (typeof source !== 'string') throw new Error('AI analysis requires an image URL.');
  return new URL(source, window.location.href).href;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
    reader.readAsDataURL(blob);
  });
}

function upperFocusRegion(mask, saliency, foreground, width, height) {
  const top = Math.floor(foreground.y * height);
  const bottom = Math.min(height, Math.ceil((foreground.y + foreground.height * 0.58) * height));
  let sumX = 0, sumY = 0, weight = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      const value = saliency[index] ** 2;
      sumX += x * value; sumY += y * value; weight += value;
    }
  }
  if (weight <= 0) return null;
  const centerX = sumX / weight / width;
  const centerY = sumY / weight / height;
  const regionWidth = clamp(foreground.width * 0.34, 0.1, 0.28);
  const regionHeight = clamp(foreground.height * 0.2, 0.08, 0.22);
  return {
    label: 'upper focal region', score: 0.46, critical: true, weight: 0.72,
    box: { x: clamp(centerX - regionWidth / 2, 0, 1 - regionWidth), y: clamp(centerY - regionHeight / 2, 0, 1 - regionHeight), width: regionWidth, height: regionHeight },
  };
}

function connectedComponents(mask, scores, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const directions = [-1, 1, -width, width];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const id = components.length;
    const stack = [start], pixels = [];
    let score = 0;
    visited[start] = 1;
    while (stack.length) {
      const index = stack.pop(); pixels.push(index); score += scores[index];
      const x = index % width;
      for (const step of directions) {
        const next = index + step;
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        if ((step === -1 && x === 0) || (step === 1 && x === width - 1)) continue;
        visited[next] = 1; stack.push(next);
      }
    }
    components.push({ id, pixels, area: pixels.length, score: score / pixels.length });
  }
  return components;
}

function selectComponents(components, width, height) {
  const minArea = width * height * 0.0025;
  const ranked = components.filter(component => component.area >= minArea).map(component => ({ ...component, rank: component.area * (0.6 + component.score) })).sort((a, b) => b.rank - a.rank);
  if (!ranked.length) return [];
  const cutoff = ranked[0].rank * 0.07;
  return ranked.filter((component, index) => index < 10 && component.rank >= cutoff);
}

function dilate(mask, width, height) {
  const output = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const index = y * width + x;
    output[index] = mask[index] || mask[index - 1] || mask[index + 1] || mask[index - width] || mask[index + width] ? 1 : 0;
  }
  return output;
}

function erode(mask, width, height) {
  const output = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const index = y * width + x;
    output[index] = mask[index] && mask[index - 1] && mask[index + 1] && mask[index - width] && mask[index + width] ? 1 : 0;
  }
  return output;
}

function averageBorder(red, green, blue, width, height) {
  const thickness = Math.max(1, Math.round(Math.min(width, height) * 0.04));
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (x >= thickness && x < width - thickness && y >= thickness && y < height - thickness) continue;
    const index = y * width + x; r += red[index]; g += green[index]; b += blue[index]; count += 1;
  }
  return { r: r / count, g: g / count, b: b / count };
}

function makeIntegral(values, width, height) {
  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let row = 0;
    for (let x = 1; x <= width; x += 1) { row += values[(y - 1) * width + x - 1]; integral[y * stride + x] = integral[(y - 1) * stride + x] + row; }
  }
  return integral;
}

function boxMean(integral, width, height, x, y, radius) {
  const stride = width + 1, left = Math.max(0, x - radius), top = Math.max(0, y - radius), right = Math.min(width, x + radius + 1), bottom = Math.min(height, y + radius + 1);
  const sum = integral[bottom * stride + right] - integral[top * stride + right] - integral[bottom * stride + left] + integral[top * stride + left];
  return sum / Math.max(1, (right - left) * (bottom - top));
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function luminance(data, offset) { return 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function boxIoU(a, b) { const left = Math.max(a.x, b.x), top = Math.max(a.y, b.y), right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height); const overlap = Math.max(0, right - left) * Math.max(0, bottom - top); return overlap / Math.max(1e-9, a.width * a.height + b.width * b.height - overlap); }
