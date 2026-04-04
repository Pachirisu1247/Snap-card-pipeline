#!/usr/bin/env python3
"""
02_fetch_logos.py

Step 2a of the Marvel Snap physical cards pipeline.

Reads snap_cards.cleaned.csv, derives a logo filename for each card
(e.g., 'absorbing-man' -> 'AbsorbingMan_Logo.png'), and downloads
those PNGs from static.marvelsnap.pro into a local folder.

- Does NOT overwrite existing files (safe to re-run anytime).
- Logs successes, misses, and errors.

Requirements:
    pip install requests pandas
"""

import os
import sys
import requests
import pandas as pd

# ---------- CONFIG ----------

# CSV produced by 01_fetch_cards.py / your cleaned cards file
CARDS_CSV = "snap_cards.msz_latest.csv"

# Where to save the *raw* downloaded logos (pre-upscale)
LOGO_OUTPUT_DIR = os.path.join("logos_raw")

# Base URL pattern for Marvel Snap logos (matches your previous pipeline)
BASE_URL = "https://static.marvelsnap.pro/source"

# ---------- HELPERS ----------

def id_to_logo_filename(card_id: str) -> str:
    """
    Convert a card id like 'absorbing-man' to 'AbsorbingMan_Logo.png'.

    This matches the naming scheme you already use:
        - Abomination_Logo.png
        - AbsorbingMan_Logo.png
        - AdamWarlock_Logo.png
    """
    parts = str(card_id).split("-")
    camel = "".join(p.capitalize() for p in parts)
    return f"{camel}_Logo.png"


# ---------- MAIN ----------

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    csv_path = os.path.join(base_dir, CARDS_CSV)
    out_dir = os.path.join(base_dir, LOGO_OUTPUT_DIR)

    if not os.path.isfile(csv_path):
        print(f"[FATAL] Could not find {csv_path}")
        sys.exit(1)

    os.makedirs(out_dir, exist_ok=True)

    print(f"[INFO] Reading cards from: {csv_path}")
    df = pd.read_csv(csv_path)

    if "id" not in df.columns:
        print("[FATAL] snap_cards.cleaned.csv is missing an 'id' column.")
        sys.exit(1)

    # Deduplicate by id in case of variants
    ids = df["id"].astype(str).unique()

    ok = 0
    skipped = 0
    missing = 0
    errors = 0

    for card_id in ids:
        logo_filename = id_to_logo_filename(card_id)
        out_path = os.path.join(out_dir, logo_filename)

        # Don’t re-download if the file already exists
        if os.path.exists(out_path):
            print(f"[SKIP] {card_id:25s} -> {logo_filename} (already exists)")
            skipped += 1
            continue

        url = f"{BASE_URL}/{logo_filename}"

        try:
            resp = requests.get(url, timeout=15)
        except requests.RequestException as e:
            print(f"[ERR ] {card_id:25s} -> {logo_filename}: request failed: {e}")
            errors += 1
            continue

        ctype = resp.headers.get("Content-Type", "")

        if resp.status_code == 200 and "image" in ctype.lower():
            with open(out_path, "wb") as f:
                f.write(resp.content)
            print(f"[ OK ] {card_id:25s} -> {logo_filename}")
            ok += 1
        else:
            print(f"[MISS] {card_id:25s} -> {logo_filename} "
                  f"(status {resp.status_code}, content-type '{ctype}')")
            missing += 1

    print("\n[SUMMARY]")
    print(f"  Saved    : {ok}")
    print(f"  Skipped  : {skipped} (already on disk)")
    print(f"  Missing  : {missing} (404 / non-image)")
    print(f"  Errors   : {errors} (network / other)")
    print(f"\nRaw logos are in: {os.path.abspath(out_dir)}")


if __name__ == "__main__":
    main()
