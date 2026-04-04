# Marvel Snap Physical Cards — Automation Pipeline

This repository documents a **fully reproducible, end-to-end pipeline** for generating near-final, print-ready Photoshop (PSD) files for **physical Marvel Snap cards**.

The design goal is to automate everything that is stable and mechanical (data scraping, logo handling, layout, text replacement), while preserving a **small, intentional manual review step** for final visual polish.

When Marvel Snap releases new cards, this pipeline can be rerun **from scratch** to regenerate hundreds of PSDs with minimal effort.

---

## High-Level Pipeline Overview

```
[ Step 1: Fetch Card Data ]
            ↓
[ Step 2: Download Raw Logos ]
            ↓
[ Step 3: Scan, Crop & Upscale Logos ]
            ↓
[ Step 4: Generate PSDs via Photopea ]
```

---

## Recommended Directory Layout

```
Marvel Snap Cards/
│
├── photopea_batch/
│   ├── 01_fetch_cards.py
│   ├── 02_fetch_logos.py
│   ├── 03_scan_and_upscale_logos.py
│   ├── 04_photopea_batch.py
│   ├── AgathaNew.psd
│   ├── snap_cards.msz_latest.csv
│   ├── logos_raw/
│   ├── logos_upscaled/
│   ├── output_psd/
│   └── missing_logos.txt
│
└── README.md
```

> Large binary assets (PSDs, PNGs) are stored locally / in OneDrive.  
> Scripts and CSVs are the reproducible source-of-truth.

---

## Step 1 — Fetch & Normalize Card Data

**Script:** `01_fetch_cards.py`

**Source (Card Data):** MarvelSnapZone public API  
```
https://marvelsnapzone.com/getinfo/?searchtype=cards&searchcardstype=true
```

**Output:**
```
snap_cards.msz_latest.csv
```

**Fields:**
- `id` — normalized slug (`adam-warlock`)
- `cost`
- `power`
- `rules` — HTML-stripped, cleaned ability text

**Notes:**
- The `id` field is canonical and drives every downstream step.
- Includes unreleased/variant/internal entries (these can create expected “logo misses” later).
- Safe to re-run at any time when new cards are added.

---

## Step 2 — Download Raw Logos

**Script:** `02_fetch_logos.py`

**Input:**
```
snap_cards.msz_latest.csv
```

**Logo Source:**
```
https://static.marvelsnap.pro/source/{CardName}_Logo.png
```

**Example mapping:**
```
absorbing-man → AbsorbingMan_Logo.png
```

**Output Folder:**
```
photopea_batch/logos_raw/
```

**Behavior:**
- Does **not overwrite** existing files.
- Safe to re-run.
- Missing logos are tracked (404 / non-image responses).

**Important quirk you observed (and why reruns can “fix” some misses):**
- Some files are served as `image/webp` even though the URL ends with `.png`.
  The downloader should accept any `Content-Type` containing `image/`.

---

## Step 3 — Logo Scan, Crop & Upscale

**Script:** `03_scan_and_upscale_logos.py`

**Purpose:** prepare logos for print-quality PSD insertion.

Typical operations:
- Trim excess transparency
- Normalize bounding boxes
- Edge cleanup when needed
- Upscale to high resolution
- Record scan metadata (optional)

**Input:**
```
logos_raw/
```

**Output:**
```
logos_upscaled/
```

---

## Step 4 — Automated PSD Generation (Photopea)

**Script:** `04_photopea_batch.py`

**Template:**
```
AgathaNew.psd
```

**Inputs:**
- `snap_cards.msz_latest.csv`
- `logos_upscaled/`

**Automated actions (per card):**
- Duplicate template
- Replace:
  - Cost
  - Power
  - Rules text
- Insert new logo on its own layer
- Auto-scale and position logo using anchor bounds
- Save per-card PSD

**Output Folder:**
```
output_psd/
```

Each PSD is ~90% complete.

---

## Manual Review

A brief manual pass is expected and intentional:
- Fine-tune logo scale (as needed)
- Minor text alignment nudges
- Replace card art backgrounds

Typical time: **~10–30 seconds per card**.

---

## Re-Running the Entire Pipeline

When new cards are released:

1. Run `01_fetch_cards.py`
2. Run `02_fetch_logos.py`
3. Run `03_scan_and_upscale_logos.py`
4. Run `04_photopea_batch.py`

Nothing is overwritten unless you explicitly change script settings to do so.

---

## Version Control & Backup Strategy

Recommended:
- Private GitHub repo for scripts + README (small, safe, diffable)
- OneDrive for bulky binaries (PSDs, PNGs), or Git LFS if you *really* want them in Git
- Track CSVs (they’re small and useful for audits)

The pipeline is fully rebuildable from scratch.
