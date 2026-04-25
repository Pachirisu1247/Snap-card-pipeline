# Marvel Snap Physical Cards --- Automation Pipeline

This repository documents a **fully reproducible, end-to-end pipeline**
for generating near-final, print-ready Photoshop (PSD) files for
**physical Marvel Snap cards**.

The design goal is to automate everything that is stable and mechanical
(data scraping, logo handling, layout, text replacement), while
preserving a **small, intentional manual review step** for final visual
polish.

When Marvel Snap releases new cards, this pipeline can be rerun **from
scratch** to regenerate hundreds of PSDs with minimal effort.

------------------------------------------------------------------------

# High-Level Pipeline Overview

    [ Step 1: Fetch Card Data ]
                ↓
    [ Step 2: Download Raw Logos ]
                ↓
    [ Step 3: Scan, Crop & Upscale Logos ]
                ↓
    [ Step 4: Generate PSDs via Photopea ]
                ↓
    [ Step 5: Apply Cost/Power Calibration ]

------------------------------------------------------------------------

# Recommended Directory Layout

    Marvel Snap Cards/
    │
    ├── photopea_batch/
    │   ├── 01_fetch_cards.py
    │   ├── 02_fetch_logos.py
    │   ├── 03_scan_and_upscale_logos.py
    │   ├── 04_photopea_batch.py
    │   ├── 05_apply_cost_power_calibration.py
    │   │
    │   ├── AgathaNew.psd
    │   ├── snap_cards.msz_latest.csv
    │   ├── calibration_table.json
    │   ├── calibration_bounds_full.csv
    │   │
    │   ├── logos_raw/
    │   ├── logos_upscaled/
    │   ├── output_psd/
    │   ├── output_psd_dev/
    │   ├── output_psd_calibrated/
    │   │
    │   └── missing_logos.txt
    │
    └── README.md

Large binaries (PSDs / PNGs) are stored locally or in OneDrive.\
Scripts and CSVs are the reproducible source of truth.

------------------------------------------------------------------------

# Step 1 --- Fetch & Normalize Card Data

**Script:** `01_fetch_cards.py`

Source:\
https://marvelsnapzone.com/getinfo/?searchtype=cards&searchcardstype=true

Output:\
`snap_cards.msz_latest.csv`

Fields include:

-   `id` (canonical slug)
-   `cost`
-   `power`
-   `rules`

The `id` drives the rest of the pipeline.

Safe to rerun whenever new cards appear.

------------------------------------------------------------------------

# Step 2 --- Download Raw Logos

**Script:** `02_fetch_logos.py`

Input:\
`snap_cards.msz_latest.csv`

Logo source pattern:

https://static.marvelsnap.pro/source/{CardName}\_Logo.png

Example:

absorbing-man → AbsorbingMan_Logo.png

Output folder:

`logos_raw/`

Behavior:

-   does not overwrite existing files
-   safe to rerun
-   records missing logos

Note: some logos are served as `image/webp` despite `.png` extension.\
Downloader accepts any `image/*` response.

------------------------------------------------------------------------

# Step 3 --- Logo Scan, Crop & Upscale

**Script:** `03_scan_and_upscale_logos.py`

Purpose:

Prepare logos for print insertion.

Typical operations:

-   trim transparency
-   normalize bounding boxes
-   edge cleanup
-   upscale for print resolution

Input:

`logos_raw/`

Output:

`logos_upscaled/`

------------------------------------------------------------------------

# Step 4 --- Automated PSD Generation (Photopea)

**Script:** `04_photopea_batch.py`

Template:

`AgathaNew.psd`

Inputs:

-   `snap_cards.msz_latest.csv`
-   `logos_upscaled/`

Per-card automation:

-   duplicate template
-   replace Cost
-   replace Power
-   replace rules text
-   insert logo layer
-   auto-scale and position logo

Output folder:

`output_psd/`

Cards generated here are roughly **90% complete**.

------------------------------------------------------------------------

# Step 5 --- Cost & Power Position Calibration

**Script:** `05_apply_cost_power_calibration.py`

Purpose:

Standardize **Cost** and **Power** text positioning across all cards
using measured bounds from a manually corrected calibration set.

Why this exists:

Different digit widths (e.g., `1` vs `8`) caused slight misalignment in
Step 4 outputs.\
Instead of scaling text, this step **repositions layers based on
calibration data**.

Inputs:

-   `output_psd_dev/`
-   `calibration_table.json`

Calibration data maps rendered values to bounding boxes.

Example ranges:

-   cost: 0--8
-   power: roughly -9 to +20

Each value stores:

-   left
-   top
-   right
-   bottom

Process:

1.  open PSD with `psd_tools`
2.  read card cost/power
3.  find matching bounds in calibration table
4.  reposition Cost layer
5.  reposition Power layer
6.  save calibrated PSD

Output folder:

`output_psd_calibrated/`

Notes:

-   Only **layer position** is changed
-   **no scaling** is performed
-   original PSDs remain untouched
-   `psd-tools` may emit decompression warnings; visual inspection
    confirmed outputs remain intact.

------------------------------------------------------------------------

# Calibration Dataset (Important)

The cost/power calibration step depends on a **small manually corrected
dataset of PSDs** that establish the canonical text positions for each
rendered numeric value.

These PSDs act as the **reference geometry** used to build
`calibration_table.json`.

Key properties:

-   Each PSD represents a specific **cost value or power value**
-   Cost coverage: `0–8`
-   Power coverage: negative and positive values used by Marvel Snap
    cards
-   The **Cost** and **Power** text layers were manually nudged until
    perfectly centered
-   Their bounding boxes were then extracted automatically

From those bounds the script builds:

    calibration_table.json
    calibration_bounds_full.csv

These files drive Step 5.

Important:

-   The calibration PSDs are **not part of the normal pipeline**
-   They are only needed if the template geometry changes

If the card template is modified, the calibration dataset must be
regenerated.

------------------------------------------------------------------------

# Pipeline Invariants (Critical Assumptions)

The automation pipeline depends on several **structural invariants** in
the PSD template and data.\
If any of these change, parts of the pipeline may break.

## Template PSD

The template `AgathaNew.psd` must contain the following layers:

    Cost
    Power
    Rules
    Logo
    Art

Important properties:

-   **Cost layer** contains only the numeric cost text
-   **Power layer** contains only the numeric power text
-   Text layers must remain **editable text layers**, not rasterized
-   Font must remain the same across all cards
-   Text alignment should remain centered

## Layer Naming

Layer names are **case-sensitive** and must remain:

    Cost
    Power
    Rules
    Logo

If these names change, scripts 04 and 05 will fail to locate the layers.

## Card IDs

The pipeline assumes the CSV `id` column matches:

    filename.psd
    logo naming

Example:

    iron-man → iron-man.psd

and

    IronMan_Logo.png

## Numeric Handling

Cost and power are treated as **strings rendered in text layers**.

The calibration system assumes:

    cost range: 0–8
    power range: roughly -9 to +20

If Marvel Snap introduces values outside this range, new calibration
entries may be required.

------------------------------------------------------------------------

# Manual Review

After Step 5:

-   quick visual scan
-   minor logo tweaks if desired
-   art replacement

Typical time:

\~10--30 seconds per card

------------------------------------------------------------------------

# Re-Running the Entire Pipeline

When new cards release:

1.  run `01_fetch_cards.py`
2.  run `02_fetch_logos.py`
3.  run `03_scan_and_upscale_logos.py`
4.  run `04_photopea_batch.py`
5.  run `05_apply_cost_power_calibration.py`

------------------------------------------------------------------------

# Version Control & Backup Strategy

Recommended:

-   GitHub repo → scripts + README
-   OneDrive → PSDs / images
-   CSV files tracked for auditability

The pipeline is fully rebuildable from scratch.
