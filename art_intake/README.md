# Marvel Snap Art Desk — Phase 1

This is an isolated localhost review tool for the new art-selection workflow.
It does not modify Photopea files, PSDs, or the existing card pipeline.

## Run

From the project root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\art_intake\Start-ArtDesk.ps1
```

Then open <http://127.0.0.1:5010>.

## Current scope

- stable randomized 48-card test queue pulled from `snap_cards.msz_latest.csv`
- local file or direct-image-URL intake
- no fabricated CSS card: **Create exact PSD preview** opens the selected card's
  completed repository PSD in Photopea, replaces its artwork layer using the
  pan/zoom recipe, and returns the actual rendered frame, logo, Cost, Power,
  and Rules layers for review
- image pan/zoom, saved approval/skip/review states, and **Accept & Next**
- local persistence under `art_intake/data/` and `art_intake/assets/original/`

The first server run creates the test queue and local state files. They are
review data, not source code.
