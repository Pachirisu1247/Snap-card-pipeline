# Art Desk 2 auto-frame calibration

Date: 2026-08-29

Machine: NVIDIA GeForce RTX 2070 SUPER, 8 GB VRAM

Historical run contract: version 2

Current contract: version 4 (`snap-extended-v1`)

## Result

The complete localhost workflow passed on all three recovered artworks:
advanced analysis, persisted crop, authentic generated-PSD composition in
Photopea, full PNG export, and cached slider re-render.

| Artwork | Providers | Crop `(scale, x, y)` | Confidence | Foreground retained | Critical retained | Critical occlusion |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Havok | saliency + MODNet + YOLOS-tiny | `(1.00, 0, 11)` | 0.770 medium | 0.7514 | 1.0000 | 0.0000 |
| Headpool | saliency + MODNet + YOLOS-tiny | `(1.00, 0, 11)` | 0.770 medium | 0.7514 | 1.0000 | 0.0000 |
| Galactus: First Steps | saliency + MODNet | `(1.00, 6, 0)` | 0.847 high | 0.9948 | 1.0000 | 0.0000 |

The recovered `havok.jpg` and `headpool.jpg` files were later proven to be
byte-identical, not merely perceptual near-duplicates. This table therefore
records the historical version-2 run on the duplicated bytes; it is not valid
evidence that Headpool framing was tested with Headpool artwork.

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

## Version-3 corrective validation

The version-3 profile was introduced after live review found version 2 too
zoomed and compositionally aggressive. It widens the scale search, favors the
unzoomed source when safe, targets a slightly higher Snap-like focal position,
and adds explicit penalties for subject clipping, lost source context,
overlarge subjects, and unnecessary pan.

| Artwork | Crop `(scale, x, y)` | Confidence | Result |
| --- | ---: | ---: | --- |
| Havok | `(1.00, 0, 7)` | 0.54 low | Correctly warns that the narrow source forces a tight crop. |
| Galactus: First Steps | `(1.00, 6, 0)` | 0.85 high | Stable wide composition with retained context. |
| Headpool | blocked | n/a | Exact duplicate of Havok; replacement art is required. |

Browser validation confirmed the duplicate warning, disabled approval and PSD
preview for Headpool, successful advanced re-analysis for Havok and Galactus,
and successful authentic-PSD rendering at full output dimensions. Automated
unit and server tests also cover exact duplicate rejection on upload/import.

## Version-4 fit-and-extend validation

Version 3 could not materially widen either sample because `1.00` represented
the minimum edge-to-edge cover scale. Version 4 separates the composition into
a sharp, detected-subject plate and a softened backdrop derived from the same
source. The backdrop always covers the PSD art box while the sharp plate may
scale below `1.00` and retain independent pan/zoom controls.

| Artwork | Crop `(scale, x, y)` | Confidence | Extended area | Visible change |
| --- | ---: | ---: | ---: | --- |
| Havok | `(0.76, -2, 2)` | 0.89 high | 24.0% | Sharp plate reduced by 24%; subject and focal regions retained. |
| Galactus: First Steps | `(0.88, 0, 0)` | 0.84 high | 13.3% | Sharp plate reduced by 12%; full scene receives more breathing room. |
| Headpool | blocked | n/a | n/a | Exact duplicate remains blocked pending genuine art. |

Isolated browser validation covered advanced analysis, initial Photopea layer
construction, cached sharp-plate resizing, full-quality PNG export, switching
cards, and the duplicate-art block. The source examples themselves contain
poster/card lettering, so they remain evidence for rendering mechanics rather
than evidence of final candidate quality.
