# Art Desk 2 calibration and batch-discovery runbook

This runbook is the execution contract for proving the auto-framer on the
fixed 48-card queue and preparing broad candidate sets without turning a
single provider or browser failure into lost work.

## Success criteria

The software records evidence automatically. A human still judges whether the
art and crop look good.

- Every analyzed card keeps its first automatic crop as an immutable baseline.
- Every decision records the final crop, confidence band, fallback state, and
  any manual movement relative to that baseline.
- Low-confidence crops never count as zero-touch successes.
- A hard safety failure is raised if a high-confidence result reports less
  than 98% critical-region retention or more than 5% critical-region
  occlusion.
- The 12-card pilot target is at least 85% zero-touch among high-confidence
  reviewed cards. The 48-card maturity target remains 90% overall.
- Provider/analysis fallback rate should stay at or below 10% after models are
  warm. No crash, partial state file, or lost completed search is acceptable.

## Checkpoints

1. **Static gate:** unit tests for classification, metrics, retry, pause,
   cancel, and old-state handling.
2. **Persistence gate:** isolated-server tests prove analysis and decisions
   survive restart and never modify the tracked user state.
3. **Pilot gate:** review the first 12 unresolved cards. Stop and inspect any
   hard safety failure, or if high-confidence zero-touch falls below 85%.
4. **Midpoint gate:** at 24 reviewed cards, compare confidence distribution,
   fallback rate, and common manual movement directions. Change solver weights
   only when the evidence shows a repeated failure mode, then start a new
   calibration session rather than mixing versions.
5. **Release gate:** all 48 reviewed, regression suite green, browser reload
   preserves progress, exported JSON/CSV opens correctly, and no hard safety
   failure remains unexplained.

## Art Scout batch policy

- `Pilot 12` searches only the next 12 unresolved cards; `All unresolved`
  prepares the remainder.
- Search runs serially, saves after every card, and skips an existing candidate
  set unless the user explicitly refreshes that card.
- Transient network, HTTP 429, and server errors retry at bounded backoffs.
  Pause, resume, and cancel act between requests without discarding completed
  work.
- Provider discovery may request up to 200 metadata results per card. Deep
  thumbnail hashing, auto-framing, and semantic ranking are capped at 24 usable
  candidates for the active card to bound memory and model work.
- A failed card is recorded and the batch continues. The final summary lists
  exactly what needs retrying.

## Live run sequence

1. Start `Start-ArtDesk.ps1` and confirm the health strip says state is saved.
2. Add the Brave Image Search key locally if search is not configured.
3. Run `Pilot 12`, then inspect the failures and candidate counts before
   continuing.
4. Review those 12 cards and export both reports. Apply the pilot gate.
5. If the gate passes, run `All unresolved`; otherwise diagnose the repeated
   failure mode before changing code or thresholds.
6. Recheck at 24, 36, and 48 reviewed cards. Keep each exported report so a
   model/solver change can be compared instead of guessed at.

The calibration file, provider key, and candidate cache are local and ignored
by Git. The existing `data/state.json` remains the source of truth for selected
art and review decisions.
