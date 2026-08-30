# Marvel Snap Art Desk 2

Art Desk is a loopback-only review application for finding, ranking, framing,
and approving alternate artwork against the authentic generated card PSDs. It
does not overwrite source PSDs or create final production PSDs.

## Run

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\art_intake\Start-ArtDesk.ps1
```

Then open <http://127.0.0.1:5010>.

## Workflow

1. Choose a local image, paste a direct image URL, or use Art Scout.
2. Art Desk immediately runs local saliency, foreground matting, and subject
   detection, then applies the best legal crop.
3. Inspect the confidence and reasons. Medium and low confidence deliberately
   remain review decisions.
4. **Create exact PSD preview** renders the selected art through the real card
   PSD in Photopea. Later slider moves reuse the cached work document.
5. Accept, save for review, or skip. Selecting different art always invalidates
   any earlier approval.

Art Scout uses the documented Brave Image Search API. Enter the key once in the
setup panel or set `ART_DESK_BRAVE_API_KEY`. The key is saved only in ignored
`data/settings.local.json`, is never returned by the API, and is never committed.

## Calibration and batch discovery

The health strip turns the fixed 48-card queue into a resumable calibration
run. The first automatic crop for each card is preserved as its baseline;
later approval records the final crop and grades it as zero-touch, minor, or
major adjustment. Low-confidence crops never count as zero-touch. High-
confidence critical-region retention and occlusion are hard safety gates.

Calibration evidence is stored atomically in ignored
`data/calibration-session.json`, separately from the existing review state.
Use **Export JSON** for the complete evidence/session and **Export CSV** for a
flat 48-row audit report. Checkpoints occur every 12 reviewed cards.

Art Scout's **Pilot 12** and **All unresolved** controls prepare search results
one card at a time. Completed candidate sets are cached after every card, so a
reload resumes by skipping them. Transient failures retry with bounded delays;
the batch can be paused, resumed, or cancelled. Search may save up to 200
provider results, while expensive thumbnail inspection and semantic ranking
are capped at the best 24 metadata candidates for the active card.

## Analysis and ranking

- deterministic canvas saliency is always available;
- `Xenova/modnet` adds a foreground matte;
- `Xenova/yolos-tiny` adds detected/inferred subject focal regions;
- browser FaceDetector is used when the browser provides it;
- `Xenova/clip-vit-base-patch32` scores Art Scout character relevance;
- crop scoring protects Cost, Power, logo, and Rules occlusion regions;
- perceptual hashes remove near-duplicate search results.

Models run in a worker and are cached by the browser after first use. The first
analysis/search-ranking run therefore takes longer than later runs.

## Local data and network behavior

Review state and selected art remain under `art_intake/data/` and
`art_intake/assets/original/`. Candidate metadata, thumbnails, and search
credentials are ignored by Git.

This PC's current Windows profile cannot negotiate HTTPS through Schannel. The
server automatically detects the existing Codex Python runtime and uses the
standard-library OpenSSL helper `secure_fetch.py` for bounded API/image
downloads. Other machines fall back to native PowerShell HTTPS. Both paths
reject private-network redirects and enforce response-size and raster-image
signature checks.

## Verification

Development tests use the pinned Node/pnpm toolchain:

```powershell
cd .\art_intake
pnpm test
pnpm run test:server
```

See `CALIBRATION_RUNBOOK.md` for checkpoints and live-run gates,
`AUTO_FRAME_CALIBRATION.md` for measured smoke results, and
`IMPLEMENTATION_PLAN.md` for the full acceptance contract and deferred scope.
