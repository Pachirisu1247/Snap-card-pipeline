# Art Desk 2: implementation and verification plan

Status: approved implementation contract

Scope: automatic artwork discovery, ranking, subject-aware framing, and review

Explicitly deferred: final PSD write-back, Photoshop Rules styling, board design, and counters

## 1. Verified starting point

The implementation begins from GitHub `main` at commit
`b84ceedf68203956ca7eb2324339b32f760a7b77`.

The current Art Desk is a loopback-only PowerShell server plus one 84 KB HTML
file. It can import one image, place that image into the authentic card PSD in
Photopea, render previews, and persist a manual `scale` / `pan_x` / `pan_y`
recipe.

The present default is not intelligent framing. It is a centered cover crop:

```text
scale = 1
pan_x = 0
pan_y = 0
mode = manual
```

The HTML currently contains 101 function declarations but only 52 unique
names. Several important functions are defined repeatedly; the browser uses
the last declaration and silently ignores earlier versions. Before new
behavior is added, the working Photopea code must be preserved in one
canonical module and all shadowed implementations must be removed.

The machine has an NVIDIA RTX 2070 SUPER with 8 GB VRAM. No ordinary `python`,
`py`, or `node` command is installed for the active Windows profile. Art Desk
2 must therefore remain runnable without asking the user to maintain a Python
environment. Development tools build committed browser assets. The launcher
remains PowerShell; on this PC it automatically finds the existing Codex
Python/OpenSSL runtime only for HTTPS because the profile's Schannel provider
cannot acquire TLS credentials.

## 2. Outcomes and non-goals

### Required outcomes

1. Importing or choosing art immediately produces a recommended crop.
2. The crop is driven by foreground saliency plus optional AI subject boxes,
   not by image-center alone.
3. The system knows that the lower logo/rules area and upper stat corners are
   dangerous places for faces and other critical subject features.
4. Every automatic decision reports its confidence, reasons, model versions,
   and whether a fallback was used.
5. Low-confidence analysis never silently pretends to be reliable. It keeps a
   safe crop, marks the card for review, and leaves manual controls available.
6. Art Scout can request dozens of image candidates, remove obvious failures
   and duplicates, rank the survivors, and present a small top group inside
   the true card composition.
7. Search credentials are local secrets and are never returned to the browser,
   logged, or committed.
8. Existing selected art and existing review state survive the migration.

### Explicit non-goals for this run

- No source PSD is overwritten.
- Accepting art does not yet produce a final PSD.
- Rules-layer typography remains unchanged.
- Board and counter design are not mixed into the card-art application.
- The software does not claim that an aesthetic choice is objectively perfect.
  It reduces the review set and records evidence needed to tune the system.

## 3. Architecture

Art Desk 2 keeps the existing localhost boundary and splits the monolithic
client into testable modules.

```text
Start-ArtDesk.ps1
  |-- static-file server with allowlisted paths and MIME types
  |-- state and candidate metadata persistence
  |-- Brave Image Search adapter (optional key, server side only)
  |-- bounded HTTPS helper fallback for this PC's broken Schannel profile
  |-- bounded remote-image cache and final candidate downloader
  `-- existing PSD / Photopea asset routes

art_desk.html
  `-- semantic UI only

static/
  |-- art-desk.css
  |-- app.js                 application coordinator
  |-- api.js                 typed fetch/error boundary
  |-- crop-solver.js         pure crop generation and scoring
  |-- image-analysis.js      canvas fallback + worker coordinator
  |-- candidate-ranker.js    deterministic filters/dedup/score fusion
  |-- photopea-client.js     the one canonical PSD preview state machine
  `-- ai-worker.js           optional pinned Transformers.js models
```

The crop solver accepts a model-neutral analysis object. This is a deliberate
seam: changing an AI model later must not require rewriting crop math, saved
state, Photopea behavior, or the UI.

## 4. Data contracts

### 4.1 Saved crop

```json
{
  "scale": 1.18,
  "pan_x": -4,
  "pan_y": 11,
  "mode": "auto",
  "analysis_version": 2,
  "confidence": 0.84,
  "manual_revision": false
}
```

Old version-1 records remain readable. Missing fields receive conservative
defaults. A user touching a crop control changes `mode` to `manual` and
`manual_revision` to `true`; re-running Auto-frame is always explicit after
that point.

### 4.2 Analysis result

All coordinates are normalized to `[0, 1]` in the source image.

```json
{
  "version": 2,
  "image": { "width": 1024, "height": 1024 },
  "foreground": {
    "box": { "x": 0.12, "y": 0.04, "width": 0.79, "height": 0.94 },
    "centroid": { "x": 0.53, "y": 0.48 },
    "coverage": 0.46,
    "edge_contact": 0.08
  },
  "critical_regions": [],
  "crop": { "scale": 1.18, "pan_x": -4, "pan_y": 11 },
  "confidence": 0.84,
  "quality_flags": [],
  "providers": ["saliency-v1", "Xenova/modnet", "Xenova/yolos-tiny"],
  "fallback": false
}
```

Analysis records are persisted with the card decision so later manual changes
can be compared against the recommendation.

### 4.3 Candidate metadata

```json
{
  "id": "stable-sha256-prefix",
  "provider": "brave-images-v1",
  "query": "Havok Marvel character comic art",
  "title": "...",
  "source_page_url": "https://...",
  "original_url": "https://...",
  "thumbnail_url": "https://...",
  "width": 1600,
  "height": 2000,
  "provider_rank": 3,
  "status": "discovered",
  "scores": {}
}
```

Candidate files and search responses are cache data. They stay ignored by
Git. The selected original, its source page, and its final decision remain in
the existing saved-art workflow.

## 5. Automatic framing algorithm

### 5.1 Analysis layers

The system uses independent evidence layers, in this order:

1. A dependency-free canvas saliency pass is always available. It combines
   multiscale luminance contrast, color contrast, and edge density, suppresses
   uniform borders, closes small gaps, and keeps meaningful connected regions.
2. Pinned `Xenova/modnet` adds a foreground matte in a small quantized WASM
   graph. Calibration replaced BiRefNet-lite because its 224 MB FP32 graph
   exhausted browser WASM memory on this machine.
3. Pinned `Xenova/yolos-tiny` adds person/animal/object boxes and inferred
   upper focal regions. Calibration replaced OWL-ViT because its graph failed
   both the RTX 2070 WebGPU buffer limit and the tested WASM session.
4. When AI initialization or inference fails, the saliency result remains
   usable and the result explicitly reports `fallback: true`.

Models execute in a Web Worker so the sliders and queue remain responsive.
Model files are downloaded once from their pinned Hugging Face repositories
and use the browser cache afterward. Only one model is retained at a time.
Foreground/detection use compatible WASM; CLIP ranking may use WebGPU.

### 5.2 Crop generation

The artwork viewport is the existing 1792 x 2006 PSD art box. The solver:

1. Calculates the minimum cover scale.
2. Generates multiple legal relative zoom levels from 1.00 through 2.40.
3. Generates positions centered on the foreground centroid, each critical
   box, a weighted union of critical boxes, and rule-of-thirds variants.
4. Clamps every proposal so no empty canvas can enter the art viewport.
5. Converts each proposal back to Art Desk's stable relative
   `scale` / percentage-pan representation.

### 5.3 Crop scoring

Every proposal receives an auditable penalty score:

- critical feature outside viewport: very high penalty;
- critical feature under Cost, Power, logo, or rules safe areas: very high;
- foreground mass cut off: high;
- head/face too close to an edge: high;
- main subject too small or excessively enlarged: medium;
- subject centroid far from the visual target: medium;
- unnecessary zoom and discarded source area: low;
- watermark/text-risk region occupying the card focal area: low-to-medium.

The lowest-penalty proposal wins. Confidence is based on agreement between
providers, foreground stability across scales, retained foreground, critical
region visibility, and the margin between the best and second-best proposals.

### 5.4 Confidence policy

- High (`>= 0.78`): apply automatically and mark as high confidence.
- Medium (`0.55-0.77`): apply automatically but visually mark for confirmation.
- Low (`< 0.55`): apply the conservative proposal, mark for review, and never
  count the card as zero-touch success.

These thresholds are configuration constants with tests and versioning, not
untracked magic numbers spread through the UI.

## 6. Art Scout discovery and ranking

### 6.1 Supported sources

The initial supported web provider is the documented Brave Image Search API.
It can return up to 200 results per request and provides original dimensions,
source-page URLs, original-image URLs, and proxied thumbnails. It requires a
subscription key.

The key is read from either `ART_DESK_BRAVE_API_KEY` or ignored local file
`art_intake/data/settings.local.json`. The browser sees only a boolean
`search_configured` capability.

The provider boundary is explicit so another documented provider can be added
without changing ranking, caching, state, or UI code. Unofficial search-page
scraping is excluded because it would create the exact brittle maintenance
problem this plan is intended to avoid.

### 6.2 Query generation

Default query variants combine the human-readable card name with:

- `Marvel character comic art`
- `Marvel illustration wallpaper`
- `Marvel full body art`

Generated/token card IDs such as `skill01-*`, `program01-*`, and zombie tokens
retain their display name but also use cleaned aliases. The user may add or
remove query variants before searching.

### 6.3 Deterministic filtering

Before AI ranking, candidates are rejected or penalized for:

- missing/invalid HTTP URLs;
- duplicate normalized original URLs;
- exact byte duplicates;
- perceptual-hash near duplicates;
- reported dimensions below the configurable minimum;
- extreme aspect ratios that require destructive cropping;
- failed, oversized, non-image, animated, or corrupt downloads;
- obvious logo/card-frame/screenshot filenames and metadata.

The server caches bounded thumbnails for analysis. Original files are not
downloaded until a user selects a candidate.

### 6.4 Semantic and composition ranking

A pinned CLIP-compatible browser model scores each surviving thumbnail against
the character name and a fixed positive/negative label set. The auto-framer
then scores how well that candidate can be composed inside the card.

The fused score is versioned and includes:

```text
35% character/text relevance
25% auto-frame confidence and foreground retention
15% source resolution
10% non-duplicate diversity
10% clean-image / low-text heuristic
 5% provider rank
```

The UI presents the top six by default, allows expanding the complete result
set, and shows why each candidate ranked where it did. The application never
auto-approves the winner; final taste remains one click by the user.

## 7. Server and security rules

1. The listener remains bound to `127.0.0.1` only.
2. Static serving is allowlisted to known directories and extensions.
3. Card IDs and candidate IDs have strict patterns.
4. Remote downloads accept only HTTP(S), use explicit timeouts, impose byte
   limits, verify raster signatures, and never follow a result
   into a local/loopback address.
5. Search keys never enter URLs, JSON responses, logs, state files, or Git.
6. State writes use a temporary file plus atomic replace so interruption cannot
   truncate the only copy.
7. Candidate metadata and cache files use schema versions.
8. New analysis never reuses an old approval. Selecting different art resets
   the card to `selected`, matching the existing safety rule.

## 8. Failure handling

| Failure | Required behavior |
| --- | --- |
| AI library cannot load | use saliency fallback; display reason |
| Model download interrupted | retry on explicit request; no broken crop saved |
| GPU/WebGPU unavailable | use WASM where practical, otherwise saliency |
| Search key missing | local import remains fully usable; show setup action |
| Search API rate limited | preserve current results and report retry timing |
| Candidate thumbnail fails | mark candidate unavailable; continue remaining set |
| Original image fails after selection | do not replace current selected art |
| Photopea times out | leave crop and analysis intact; allow preview retry |
| State write fails | retain in-memory state and show a blocking save error |
| Low detector confidence | conservative crop plus needs-review flag |

## 9. Verification strategy

### 9.1 Pure unit tests

- crop coordinate conversion round trips;
- cover constraints never expose blank canvas;
- synthetic face/subject boxes stay out of weighted occlusion regions;
- multiple-subject unions remain visible when geometrically possible;
- confidence thresholds and reason codes;
- candidate URL normalization and stable IDs;
- perceptual hash distance and duplicate groups;
- deterministic fused ranking and tie-breaking;
- version-1 state migration.

### 9.2 Server integration tests

- bootstrap and static file routes;
- rejected traversal and malformed IDs;
- upload/import byte and MIME limits;
- atomic state persistence;
- search-not-configured response;
- mocked Brave response normalization;
- candidate cache failure isolation;
- current selected assets remain readable.

### 9.3 Real-image benchmark

The committed Galactus, Havok, and Headpool assets form the first smoke set.
The existing 48-card queue becomes the ongoing calibration set. Benchmark
records store the initial automatic crop and any eventual manual delta.

The benchmark reports, but does not fabricate, these metrics:

- analysis completion rate;
- high/medium/low confidence distribution;
- foreground retention;
- critical-region visibility;
- automatic-to-manual scale and pan delta;
- zero-touch approval rate;
- median analysis time after warm cache.

The target for declaring auto-framing mature is at least 90% zero-touch approval
on the 48-card calibration set, with no low-confidence crop counted as success.
That declaration requires actual review evidence; software tests alone cannot
honestly certify aesthetic correctness.

### 9.4 Browser acceptance test

Using the actual localhost application:

1. Load the queue and existing state.
2. Select each of the three committed images.
3. Run Auto-frame and inspect confidence/reasons.
4. Move a slider and confirm the recipe becomes manual.
5. Restore Auto-frame and confirm the automatic recipe returns.
6. Render the authentic PSD preview in Photopea.
7. Exercise missing-search-key UI.
8. With a mock provider, load candidates, deduplicate, rank, select a
   candidate, and verify that old approval is reset.
9. Reload the page and verify persistence.

## 10. Implementation order and gates

### Gate A: preserve and simplify

- Snapshot baseline API behavior.
- Replace the monolithic duplicate client code with modules.
- Preserve current import, queue, decisions, slider preview, and Photopea output.
- Do not continue until baseline integration and browser tests pass.

### Gate B: deterministic framing core

- Implement analysis schema, canvas saliency, crop solver, confidence, UI, and
  persistence.
- Complete synthetic unit tests and three-image smoke benchmark.
- The application is already useful if optional AI is unavailable.

### Gate C: optional AI providers

- Add the pinned worker library and model lifecycle.
- Fuse masks/boxes with deterministic analysis.
- Verify cancellation, model failure, fallback, and bounded GPU lifecycle.

### Gate D: Art Scout

- Add secure search configuration, provider adapter, candidate metadata/cache,
  deterministic filters, semantic scoring, composition scoring, and gallery.
- Verify the complete workflow with mocked provider data; perform a live API
  test only when a key is locally available.

### Gate E: regression and release

- Run all unit and integration tests.
- Run the localhost browser acceptance test.
- Record benchmark output without overstating subjective success.
- Update README and troubleshooting documentation.
- Commit, push, and verify local HEAD equals GitHub `main`.

## 11. Rollback and future seams

The original card PSDs are read-only throughout this run. Saved state retains a
schema version and can be backed up before migration. The PowerShell server,
crop solver, AI providers, ranking weights, search provider, and Photopea
client are separate modules, so a failure in one subsystem does not require
rewriting the rest.

Final PSD write-back will consume the same stable selected-art and crop record
after this phase proves framing quality. Photoshop Rules work and physical
board/counter design remain independent later milestones.

## 12. Calibration execution extension

The implementation now includes the operational layer needed to execute the
48-card benchmark without losing or hand-transcribing evidence:

- a separate, ignored, atomically saved calibration session;
- immutable first-auto-frame baselines and automatic final-decision capture;
- confidence, fallback, crop-delta, zero-touch, and hard-safety reporting;
- server-backed JSON and CSV downloads;
- 12-card checkpoints with explicit pilot and maturity gates;
- serial, resumable Art Scout batch discovery with cached-card skipping,
  bounded transient retries, pause/resume/cancel, and per-card failure counts;
- a 24-thumbnail deep-analysis budget selected by deterministic metadata score;
- isolated restart and provider-failure integration coverage.

The exact run procedure and stop/revise conditions are maintained in
`CALIBRATION_RUNBOOK.md`. A live Brave key and human aesthetic decisions are
still required to produce an honest 48-card zero-touch result; mock-provider
and software tests cannot substitute for that review evidence.
