const SNAPSHOT_VERSION = 1;
const COMPACT_FIELDS = Object.freeze([
  'id', 'hash', 'composition_confidence', 'suggested_crop', 'semantic_relevance',
  'semantic_identity', 'semantic_artwork', 'semantic_wrong_character',
  'semantic_rendered_card', 'semantic_merchandise', 'semantic_photo',
  'semantic_tutorial', 'fused_score', 'display_rank',
]);

export function candidateSetFingerprint(candidates) {
  const value = (candidates || []).map(candidate => `${candidate.id || ''}|${candidate.original_url || ''}`).sort().join('\n');
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${(candidates || []).length}`;
}

export function createVerificationSnapshot(rawCandidates, verifiedCandidates, rankingVersion, summary = {}) {
  return {
    version: SNAPSHOT_VERSION,
    ranking_version: rankingVersion,
    candidate_fingerprint: candidateSetFingerprint(rawCandidates),
    verified_at: new Date().toISOString(),
    summary,
    accepted: (verifiedCandidates || []).map(candidate => Object.fromEntries(
      COMPACT_FIELDS.filter(field => candidate[field] !== undefined).map(field => [field, candidate[field]]),
    )),
  };
}

export function restoreVerificationSnapshot(rawCandidates, eligibleCandidates, snapshot, rankingVersion) {
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION || snapshot.ranking_version !== rankingVersion) return null;
  if (snapshot.candidate_fingerprint !== candidateSetFingerprint(rawCandidates)) return null;
  if (!Array.isArray(snapshot.accepted)) return null;
  const byId = new Map((eligibleCandidates || []).map(candidate => [candidate.id, candidate]));
  const restored = [];
  for (const saved of snapshot.accepted) {
    const candidate = byId.get(saved.id);
    if (!candidate) return null;
    restored.push({ ...candidate, ...saved, semantic_rejected: false });
  }
  return { candidates: restored, summary: snapshot.summary || {}, verified_at: snapshot.verified_at || null };
}
