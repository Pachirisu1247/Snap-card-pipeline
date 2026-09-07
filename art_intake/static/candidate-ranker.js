import { hashDistance } from './image-analysis.js';

export const RANKING_VERSION = 2;
export const RANKING_WEIGHTS = Object.freeze({ relevance: 0.35, composition: 0.25, resolution: 0.15, diversity: 0.1, cleanliness: 0.1, provider: 0.05 });

// Brave Images currently returns *more* merchandise when negative product
// tokens are supplied. Anchoring searches to Marvel Snap variants yields a
// much cleaner visual pool; deterministic content gates below do the excluding.
const ART_QUERY_POSITIVES = Object.freeze(['Marvel Snap', 'variants', 'artwork', 'comic illustration']);

const CONTENT_PATTERNS = Object.freeze({
  merchandise: [
    /\baction figures?\b/i, /\btoys?\b/i, /\bfigurines?\b/i, /\bstatues?\b/i,
    /\bcollectibles?\b/i, /\bmodel kits?\b/i, /\bresin kits?\b/i, /\bmaquettes?\b/i,
    /\bvinyl figures?\b/i, /\bfunko(?: pop)?\b/i, /\bmarvel legends?\b/i,
    /\bhot toys?\b/i, /\bsideshow collectibles?\b/i, /\biron studios?\b/i,
    /\bdiamond select\b/i, /\b(?:1\/\d+|one[- ]sixth) scale\b/i,
    /\bpre[- ]?orders?\b/i, /\bin stock\b/i, /\badd to cart\b/i, /\bunboxing\b/i,
  ],
  cosplay_photo: [
    /\bcosplay(?:er)?\b/i, /\blive[- ]action\b/i,
    /\bmovie stills?\b/i, /\bset photos?\b/i, /\bred carpet\b/i,
    /\bbehind the scenes\b/i, /\bactor portraits?\b/i,
  ],
  tutorial: [
    /\bhow to draw\b/i, /\bdrawing tutorials?\b/i, /\bstep[- ]by[- ]step drawing\b/i,
    /\bcoloring pages?\b/i, /\bdraw (?:easy|for beginners)\b/i,
  ],
});

const STOREFRONT_HOSTS = Object.freeze([
  'amazon.', 'ebay.', 'etsy.', 'walmart.', 'target.', 'aliexpress.', 'temu.', 'mercari.',
  'bigbadtoystore.', 'sideshow.', 'ironstudios.', 'entertainmentearth.', 'gamestop.', 'shopdisney.',
]);

export function buildArtSearchQuery(characterName, input = '') {
  const cleanName = String(characterName || '').replaceAll('-', ' ').replace(/\s+/g, ' ').trim();
  const raw = String(input || '').replace(/\s+/g, ' ').trim();
  const base = boundQueryPart(raw || (cleanName ? `"${cleanName.replaceAll('"', '')}"` : ''), 32, 240);
  const parts = [base].filter(Boolean);
  const current = () => parts.join(' ');

  for (const term of ART_QUERY_POSITIVES) {
    if (!new RegExp(`\\b${escapeRegExp(term).replaceAll('\\ ', '\\s+')}\\b`, 'i').test(current())) parts.push(term);
  }
  const bounded = [];
  let words = 0;
  for (const part of parts) {
    const partWords = part.split(/\s+/).length;
    const next = [...bounded, part].join(' ');
    if (words + partWords > 48 || next.length > 390) break;
    bounded.push(part);
    words += partWords;
  }
  return bounded.join(' ');
}

export function normalizeCandidateUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return ''; }
}

export function deterministicFilter(candidates, { minWidth = 600, minHeight = 600 } = {}) {
  const seenUrls = new Set();
  return (candidates || []).map(candidate => {
    const original = normalizeCandidateUrl(candidate.original_url);
    const thumbnail = normalizeCandidateUrl(candidate.thumbnail_url);
    const flags = [];
    if (!original || !thumbnail) flags.push('invalid_url');
    if (original && seenUrls.has(original)) flags.push('duplicate_url');
    if (original) seenUrls.add(original);
    const width = Number(candidate.width || 0), height = Number(candidate.height || 0);
    if (width && width < minWidth) flags.push('low_width');
    if (height && height < minHeight) flags.push('low_height');
    const aspect = width > 0 && height > 0 ? width / height : null;
    if (aspect && (aspect < 0.32 || aspect > 2.25)) flags.push('extreme_aspect');
    flags.push(...candidateContentFlags({ ...candidate, original_url: original }));
    if (metadataTextRisk(candidate) > 0.75) flags.push('metadata_text_risk');
    const hardFailures = new Set([
      'invalid_url', 'duplicate_url', 'low_width', 'low_height', 'extreme_aspect', 'metadata_text_risk',
      'merchandise', 'storefront', 'cosplay_photo', 'tutorial',
    ]);
    return { ...candidate, original_url: original, thumbnail_url: thumbnail, filter_flags: flags, rejected: flags.some(flag => hardFailures.has(flag)) };
  });
}

export function candidateContentFlags(candidate) {
  const value = `${candidate.title || ''} ${candidate.source_page_url || ''} ${candidate.original_url || ''}`;
  const flags = [];
  for (const [flag, patterns] of Object.entries(CONTENT_PATTERNS)) {
    if (patterns.some(pattern => pattern.test(value))) flags.push(flag);
  }
  const hosts = [candidate.source_page_url, candidate.original_url].map(hostname).filter(Boolean);
  if (hosts.some(host => STOREFRONT_HOSTS.some(store => host === store.slice(0, -1) || host.includes(`.${store}`) || host.startsWith(store)))) flags.push('storefront');
  return [...new Set(flags)];
}

export function deduplicateCandidates(candidates, maximumDistance = 5) {
  const groups = [];
  const unique = [];
  for (const candidate of candidates) {
    if (candidate.rejected) continue;
    const duplicate = unique.find(existing => candidate.hash && existing.hash && hashDistance(candidate.hash, existing.hash) <= maximumDistance);
    if (!duplicate) {
      unique.push(candidate);
      groups.push({ kept: candidate.id, duplicates: [] });
      continue;
    }
    const group = groups.find(item => item.kept === duplicate.id);
    group?.duplicates.push(candidate.id);
  }
  return { unique, groups, removed: Math.max(0, candidates.filter(candidate => !candidate.rejected).length - unique.length) };
}

export function fuseCandidateScores(candidate) {
  const scores = {
    relevance: clamp(Number(candidate.semantic_relevance ?? 0.45), 0, 1),
    composition: clamp(Number(candidate.composition_confidence ?? 0.35), 0, 1),
    resolution: resolutionScore(candidate.width, candidate.height),
    diversity: clamp(Number(candidate.diversity_score ?? 1), 0, 1),
    cleanliness: clamp(1 - metadataTextRisk(candidate) - Number(candidate.visual_text_risk || 0) * 0.5, 0, 1),
    provider: clamp(1 - Math.max(0, Number(candidate.provider_rank || 1) - 1) / 100, 0, 1),
  };
  const total = Object.entries(RANKING_WEIGHTS).reduce((sum, [key, weight]) => sum + scores[key] * weight, 0);
  return { ...candidate, score_version: RANKING_VERSION, component_scores: scores, fused_score: round(total, 5) };
}

export function rankCandidates(candidates) {
  return candidates.map(fuseCandidateScores).sort((left, right) => right.fused_score - left.fused_score || Number(left.provider_rank || 0) - Number(right.provider_rank || 0) || String(left.id).localeCompare(String(right.id))).map((candidate, index) => ({ ...candidate, display_rank: index + 1 }));
}

export function resolutionScore(widthInput, heightInput) {
  const width = Number(widthInput || 0), height = Number(heightInput || 0);
  if (!(width > 0 && height > 0)) return 0.25;
  const megapixels = width * height / 1e6;
  const pixelScore = clamp(Math.log2(Math.max(0.5, megapixels) / 0.5) / Math.log2(24 / 0.5), 0, 1);
  const targetAspect = 1792 / 2006;
  const aspect = width / height;
  const aspectScore = Math.exp(-Math.abs(Math.log(aspect / targetAspect)) * 0.82);
  return round(0.72 * pixelScore + 0.28 * aspectScore, 5);
}

export function metadataTextRisk(candidate) {
  const value = `${candidate.title || ''} ${candidate.source_page_url || ''}`.toLowerCase();
  const patterns = [
    /wallpaper download/, /trading card/, /card game/, /logo/, /pngwing/, /clipart/, /template/,
    /poster/, /collage/, /screenshot/, /youtube/, /thumbnail/, /meme/, /etsy/, /redbubble/,
  ];
  return clamp(patterns.reduce((score, pattern) => score + (pattern.test(value) ? 0.18 : 0), 0), 0, 0.9);
}

function hostname(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function boundQueryPart(value, maxWords, maxChars) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const kept = [];
  for (const word of words) {
    const next = [...kept, word].join(' ');
    if (kept.length >= maxWords || next.length > maxChars) break;
    kept.push(word);
  }
  return kept.join(' ');
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function round(value, digits) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
