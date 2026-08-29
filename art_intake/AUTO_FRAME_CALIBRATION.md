# Art Desk 2 auto-frame calibration

Date: 2026-08-29

Machine: NVIDIA GeForce RTX 2070 SUPER, 8 GB VRAM

Analysis contract: version 2

## Result

The complete localhost workflow passed on all three recovered artworks:
advanced analysis, persisted crop, authentic generated-PSD composition in
Photopea, full PNG export, and cached slider re-render.

| Artwork | Providers | Crop `(scale, x, y)` | Confidence | Foreground retained | Critical retained | Critical occlusion |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Havok | saliency + MODNet + YOLOS-tiny | `(1.00, 0, 11)` | 0.770 medium | 0.7514 | 1.0000 | 0.0000 |
| Headpool | saliency + MODNet + YOLOS-tiny | `(1.00, 0, 11)` | 0.770 medium | 0.7514 | 1.0000 | 0.0000 |
| Galactus: First Steps | saliency + MODNet | `(1.00, 6, 0)` | 0.847 high | 0.9948 | 1.0000 | 0.0000 |

Havok and Headpool are perceptual near-duplicates in the recovered assets;
Art Scout correctly collapsed them into one finalist during browser testing.
Their tall source composition necessarily cuts some non-critical foreground,
so the confidence gate caps both at medium rather than overstating safety.

## Candidate workflow evidence

The isolated browser fixture exercised discovery, remote thumbnail caching,
dimension filtering, fallback crop scoring, perceptual-hash deduplication,
CLIP semantic ranking, finalist rendering, full-original selection, automatic
re-analysis, and authentic PSD preview. Three discovered images produced three
usable candidates, one near-duplicate removal, and two ranked finalists.

The real server accepts 6-100 requested Brave results; unit tests cover stable
ranking/filtering and the server smoke test covers normalized provider
responses and persisted candidate metadata. A live Brave request still needs a
user-owned API key and is intentionally not faked in this report.

## Confidence policy validated

- No face/head/upper focal evidence caps confidence below high.
- Foreground retention below 92%, critical retention below 98%, or critical
  occlusion above 5% caps confidence below high.
- Severe clipping/occlusion caps confidence below medium.
- Provider failure remains visible as a fallback/quality flag.

These three examples prove the implementation path, not the subjective 90%
goal. Declaring that goal met requires the user's real approvals across the
48-card calibration queue; low-confidence crops never count as zero-touch.
