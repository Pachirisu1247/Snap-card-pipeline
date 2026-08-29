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

See `AUTO_FRAME_CALIBRATION.md` for measured results and
`IMPLEMENTATION_PLAN.md` for the full acceptance contract and deferred scope.
