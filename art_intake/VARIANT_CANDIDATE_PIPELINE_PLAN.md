# Variant candidate library: implementation plan

Status: design approved for later implementation; no bulk downloader is enabled yet.

The goal is a manual-first library that prepares strong, attributable artwork
choices for every playable card. It begins with the current queue, proves the
workflow on small gates, and can then advance through the full card list in
resumable batches without forcing an automatic choice.

## 1. Verified constraints and source policy

- The current card CSV contains 658 rows. The repository has 60 calibrated
  PSDs and a 48-card Art Desk queue. Token-like cards stay in a separate,
  opt-in phase because their art and production requirements differ.
- Marvel Snap Zone card pages enumerate real variant pages. Variant pages can
  expose a full-art asset plus separate rearmost, background, and foreground
  layers. Discovery must follow the page manifest; it must not guess numbered
  asset URLs.
- Publicly reachable artwork is not automatically public-domain artwork. The
  library is a local, personal-use cache: source URL, page URL, artist, and
  retrieval time are mandatory; downloaded art and generated contact sheets
  remain ignored by Git and are never redistributed with the repository.
- Before enabling a provider, capture its current terms/robots result as a
  dated fixture and fail closed if the expected page/asset contract changes.
- Do not scrape Google Images HTML. Google's Custom Search JSON API is closed
  to new customers, so it is not a required dependency. An adapter may be
  added only for an already-authorized API account.
- Brave remains the general image-search provider. Danbooru is optional,
  disabled by default, general-rating only, uses an identifying User-Agent,
  and is throttled to one request per second.

## 2. Manual-first product behavior

For one card, Art Desk will show a persistent candidate library rather than a
single search result:

1. **Snap variants** first, grouped by named variant and artist.
2. **Dynamic web art** from query templates that favor action, movement,
   environment, comic panels, splash art, and full-body composition while
   penalizing character sheets, isolated headshots, logos, toys, and cosplay.
3. **Optional Danbooru** results in a visibly separate, off-by-default source
   group.

The review grid shows source, artist, dimensions, duplicate status, framing
confidence, and a thumbnail using the proposed crop. Selecting a candidate
opens it beside the authentic PSD preview. The user can adjust the crop,
accept it, reject it with a reason, or move to the next choice entirely by
keyboard. Rejections remain recorded so a later discovery run does not keep
offering the same image. A printable contact sheet is an optional export, not
the primary review surface.

Automation ranks and filters; it never silently approves art. The crop model
is advisory, and low-confidence or tight-source candidates are made obvious.

## 3. Local data model

All bulk artifacts live under an ignored `art_intake/library/` directory:

```text
art_intake/library/
  manifest.json
  jobs.json
  cards/<card-id>/
    candidates.json
    raw/
    layers/
    composite/
    thumbs/
```

Each candidate record includes:

```json
{
  "candidate_id": "sha256-derived-stable-id",
  "card_id": "headpool",
  "provider": "marvel-snap-zone",
  "source_page_url": "https://example.invalid/variant-page",
  "asset_urls": { "full_art": "https://example.invalid/art.webp" },
  "variant_name": "Variant 02",
  "artist": "artist when published",
  "retrieved_at": "ISO-8601",
  "license_note": "local review cache; rights retained by owners",
  "sha256": "hex",
  "perceptual_hash": "hex",
  "width": 1024,
  "height": 1536,
  "scores": {
    "identity": 0.0,
    "dynamic": 0.0,
    "composition": 0.0,
    "crop_confidence": 0.0
  },
  "decision": "unreviewed",
  "rejection_reason": null
}
```

Writes use temp-file-plus-rename. The manifest is rebuildable from per-card
records. Raw files are immutable and addressed by checksum, making retries
idempotent and making cross-card duplication detectable.

## 4. Provider adapters

### A. Marvel Snap variant adapter

- Resolve the exact card page from the card slug and verify the printed card
  name before accepting it.
- Parse only variant links actually present on that page.
- On each variant page, record its displayed variant label, artist/credit when
  available, page URL, and explicitly linked full-art/layer assets.
- Prefer an explicit full-art download. When it is absent, reconstruct a local
  review composite from declared layers as described below.
- Store parsing fixtures for Havok, Headpool, and Galactus: First Steps so a
  site-layout change fails in tests instead of corrupting a bulk run.

### B. Brave dynamic-art adapter

- Build character-aware aliases from the card database, but require the
  canonical name in the identity score.
- Issue several small query families instead of one broad query: `action
  comic art`, `battle splash art`, `dynamic full body`, and card-specific
  story/team terms.
- Use negative terms and metadata penalties for portrait, character sheet,
  turnaround, logo, toy, statue, cosplay, and wallpaper collage.
- Keep provider rank as one signal only. CLIP/identity, visual dynamics,
  usable resolution, duplicate checks, and the crop solver determine display
  order.

### C. Optional Danbooru adapter

- Disabled until the user enables it in local settings.
- Use only the documented JSON API, general-rated posts, an identifying
  User-Agent, bounded pages, and a one-request-per-second limiter.
- Map canonical names to reviewed tags; ambiguous or missing mappings produce
  no results rather than a guessed character match.

## 5. Variant layer reconstruction

Variant assets sometimes expose separate layers rather than a ready full-art
file. The reconstruction path will:

1. validate MIME signature, dimensions, alpha channel, and download size;
2. preserve every raw layer unchanged;
3. align equal canvases and compose `rearmost -> background -> foreground`;
4. reject mismatched canvases unless the page provides explicit placement;
5. save the deterministic composite separately with its own checksum and a
   recipe listing every source layer.

This produces a review candidate only. It does not replace the authentic card
PSD or invent missing layers.

## 6. Resumable server API and job runner

Add narrow local endpoints:

- `POST /api/library/discover-card`
- `POST /api/library/fetch-asset`
- `POST /api/library/compose-candidate`
- `POST /api/library/analyze-candidate`
- `GET /api/library/card/<id>`
- `GET /api/library/inventory`

The browser orchestrates visible jobs and persists a checkpoint after each
candidate. Discovery, download, composition, and analysis are separate states;
restarting the server resumes the first incomplete state. Default concurrency
is one provider request, two downloads, one composition, and one analysis.
Retries are bounded and exponential, `Retry-After` is honored, permanent HTTP
errors are not retried, and a per-run/per-card disk budget stops runaway jobs.
Pause, resume, cancel, and retry-failed controls are required before any batch
button is exposed.

## 7. Identity, duplicate, and quality gates

- Exact SHA-256 matches are stored once and linked, never silently assigned to
  two characters. A cross-card match is a blocking identity conflict.
- Perceptual near-duplicates collapse within a card while retaining all source
  attribution; cross-card near-duplicates are warnings.
- Variant-page identity is established by the verified parent card page.
  General-search identity must exceed a conservative threshold and display the
  matching evidence.
- Minimum dimensions, corrupt/decompression-bomb protection, bounded response
  size, allowed MIME signatures, redirect validation, and existing SSRF rules
  apply before bytes reach the library.
- Composition ranking rewards visible environment, subject breathing room,
  face/upper-subject placement compatible with a Snap frame, and retained
  foreground. Extreme zoom, clipped faces, dead-center passport framing, text,
  UI screenshots, and watermarks receive explicit penalties.

## 8. Implementation gates

No gate expands until its acceptance checks pass.

### Gate 0 — contract fixtures

- Save representative Marvel Snap Zone page fixtures and expected manifests.
- Record provider terms/robots preflight and a local-use notice.
- Unit-test URL validation, parser failure behavior, and no guessed URLs.

### Gate 1 — storage and identity

- Implement schema migration, atomic writes, checksum storage, rejection
  memory, inventory rebuild, and exact/near-duplicate behavior.
- Prove interrupted writes and repeated jobs do not lose or duplicate data.

### Gate 2 — three-card variant pilot

- Discover Havok, Headpool, and Galactus: First Steps.
- Download every explicitly listed variant asset, validate it, reconstruct any
  layered candidate, and confirm Headpool can never inherit Havok bytes.
- Manually inspect source attribution and full-resolution pixels.

### Gate 3 — review UI pilot

- Add source filters, keyboard review, rejection reasons, crop preview, and
  authentic PSD side-by-side preview.
- Browser-test reload/resume, card switching during analysis, candidate
  replacement, and stale-response cancellation.

### Gate 4 — twelve-card diversity pilot

- Include common names, punctuation, team names, sparse variants, layered
  variants, portrait-heavy results, and at least one card with no usable art.
- Review every candidate manually and adjust query/quality thresholds from
  recorded rejection reasons, not anecdotes.

### Gate 5 — current queue

- Process the 48-card queue with checkpoints every 12 cards.
- At each checkpoint run unit, server, and browser regressions; audit duplicate
  conflicts, disk use, provider failure rate, attribution completeness, and a
  random full-resolution sample.

### Gate 6 — full playable set

- First inventory all 60 calibrated PSDs, then process the playable card list
  in batches of 50. Generate an inventory report before and after each batch.
- Stop expansion if identity conflicts, missing attribution, corrupt assets,
  unexplained candidate loss, or resume failures occur. Tokens remain opt-in.

## 9. Required verification

Pure tests cover parsing, aliases, stable IDs, path safety, image signatures,
layer recipes, deduplication, scoring, retry classification, state migration,
and job resumption. Server smoke tests use local provider fixtures and include
timeouts, 404/429/500 responses, redirects, oversized files, corrupt images,
duplicate bytes across cards, partial layers, cancellation, restart, and disk
budget exhaustion. Browser tests cover the three-card failure sequence,
switching cards mid-analysis, filters, keyboard decisions, manual crop edits,
authentic PSD preview, reload, pause/resume, and empty/error states.

After every gate: run all automated tests, inspect the Git diff for generated
or personal data, restart from a clean process, and perform the specified
manual spot check. No bulk run is considered successful merely because it
completed without throwing an error.

## 10. Explicit non-goals

- No automatic final approval of artwork.
- No Google Images HTML scraping, unbounded crawling, or URL guessing.
- No committing downloaded copyrighted art, credentials, or personal review
  state.
- No final rules-text production, game-board design, or counter design in this
  phase.
- No attempt to make the auto crop replace the user's eye.

## 11. Definition of done

The feature is ready for normal use when a stopped/restarted 48-card run
resumes exactly, every candidate has traceable source metadata, no exact image
can be assigned across characters without a visible block, the three provider
paths degrade independently, the user can review a card without leaving Art
Desk, and the gate reports show no unexplained loss or mutation of source art.
