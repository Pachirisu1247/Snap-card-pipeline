#!/usr/bin/env python3
"""
05_apply_cost_power_calibration.py

Apply value-based Cost/Power position calibration to Marvel Snap PSDs.

Behavior:
- Opens PSDs from INPUT_DIR
- Finds text layers named exactly "Cost" and "Power"
- Reads the existing text values from those layers
- Looks up target bounding boxes in calibration_table.json
- Repositions the layers only (no scaling, no text edits)
- Saves corrected PSDs to OUTPUT_DIR

Requirements:
    pip install psd-tools
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from psd_tools import PSDImage

# ---------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------

# Change these as needed.
INPUT_DIR = Path(r"C:\Users\allda\Downloads\Snap-card-pipeline\photopea_batch\output_psd_dev")
OUTPUT_DIR = Path(r"C:\Users\allda\Downloads\Snap-card-pipeline\photopea_batch\output_psd_calibrated")
CALIBRATION_FILE = Path(r"C:\Users\allda\Downloads\Snap-card-pipeline\photopea_batch\calibration_table.json")

# Exact PSD layer names.
COST_LAYER_NAME = "Cost"
POWER_LAYER_NAME = "Power"

# Safety options.
OVERWRITE_OUTPUT = False       # False = do not overwrite an existing calibrated PSD
RECURSIVE = False              # True = search subfolders under INPUT_DIR
LOG_FILENAME = "05_apply_cost_power_calibration.log"

BBox = Tuple[int, int, int, int]


# ---------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------

def setup_logging(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    log_path = output_dir / LOG_FILENAME

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        handlers=[
            logging.FileHandler(log_path, encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------

def load_calibration(path: Path) -> tuple[Dict[str, BBox], Dict[str, BBox]]:
    if not path.exists():
        raise FileNotFoundError(f"Calibration file not found: {path}")

    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if "cost_calibration" not in data or "power_calibration" not in data:
        raise KeyError(
            "Calibration JSON must contain 'cost_calibration' and 'power_calibration'."
        )

    cost_table: Dict[str, BBox] = {
        str(k): tuple(int(vv) for vv in v)  # type: ignore[arg-type]
        for k, v in data["cost_calibration"].items()
    }
    power_table: Dict[str, BBox] = {
        str(k): tuple(int(vv) for vv in v)  # type: ignore[arg-type]
        for k, v in data["power_calibration"].items()
    }

    return cost_table, power_table


def iter_psd_paths(input_dir: Path, recursive: bool = False) -> Iterable[Path]:
    if not input_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {input_dir}")

    pattern = "**/*.psd" if recursive else "*.psd"
    yield from sorted(input_dir.glob(pattern))


def find_named_layer(psd: PSDImage, layer_name: str):
    found = None
    for layer in psd.descendants():
        if layer.name == layer_name:
            found = layer
            break
    return found


def get_text_value(layer) -> str:
    text = layer.text
    if text is None:
        raise ValueError(f"Layer '{layer.name}' has no text value.")
    return str(text).strip()


def get_bbox(layer) -> BBox:
    bbox = layer.bbox
    if bbox is None or len(bbox) != 4:
        raise ValueError(f"Layer '{layer.name}' does not have a valid bbox.")
    return (int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3]))


def move_layer_to_target_bbox(layer, target_bbox: BBox) -> dict:
    current_bbox = get_bbox(layer)
    current_left, current_top, current_right, current_bottom = current_bbox
    target_left, target_top, target_right, target_bottom = target_bbox

    dx = target_left - current_left
    dy = target_top - current_top

    # Reposition only. No scaling.
    layer.offset = (layer.left + dx, layer.top + dy)

    new_bbox = get_bbox(layer)

    return {
        "old_bbox": current_bbox,
        "target_bbox": target_bbox,
        "new_bbox": new_bbox,
        "dx": dx,
        "dy": dy,
    }


# ---------------------------------------------------------------------
# Core processing
# ---------------------------------------------------------------------

def process_one_psd(
    psd_path: Path,
    output_dir: Path,
    cost_table: Dict[str, BBox],
    power_table: Dict[str, BBox],
    overwrite_output: bool = False,
) -> dict:
    result = {
        "file": psd_path.name,
        "status": "unknown",
        "messages": [],
    }

    out_path = output_dir / psd_path.name

    if out_path.exists() and not overwrite_output:
        result["status"] = "skipped_existing_output"
        result["messages"].append(f"Output already exists: {out_path}")
        return result

    psd = PSDImage.open(psd_path)

    cost_layer = find_named_layer(psd, COST_LAYER_NAME)
    power_layer = find_named_layer(psd, POWER_LAYER_NAME)

    if cost_layer is None:
        result["status"] = "skipped_missing_cost_layer"
        result["messages"].append(f"Missing layer: {COST_LAYER_NAME}")
        return result

    if power_layer is None:
        result["status"] = "skipped_missing_power_layer"
        result["messages"].append(f"Missing layer: {POWER_LAYER_NAME}")
        return result

    cost_value = get_text_value(cost_layer)
    power_value = get_text_value(power_layer)

    if cost_value not in cost_table:
        result["status"] = "skipped_missing_cost_calibration"
        result["messages"].append(f"No calibration entry for cost value '{cost_value}'")
        return result

    if power_value not in power_table:
        result["status"] = "skipped_missing_power_calibration"
        result["messages"].append(f"No calibration entry for power value '{power_value}'")
        return result

    cost_move = move_layer_to_target_bbox(cost_layer, cost_table[cost_value])
    power_move = move_layer_to_target_bbox(power_layer, power_table[power_value])

    output_dir.mkdir(parents=True, exist_ok=True)
    psd.save(out_path)

    result["status"] = "ok"
    result["messages"].append(
        f"Cost {cost_value}: {cost_move['old_bbox']} -> {cost_move['new_bbox']} "
        f"(target {cost_move['target_bbox']}, dx={cost_move['dx']}, dy={cost_move['dy']})"
    )
    result["messages"].append(
        f"Power {power_value}: {power_move['old_bbox']} -> {power_move['new_bbox']} "
        f"(target {power_move['target_bbox']}, dx={power_move['dx']}, dy={power_move['dy']})"
    )
    return result


def main() -> None:
    setup_logging(OUTPUT_DIR)

    logging.info("Loading calibration file: %s", CALIBRATION_FILE)
    cost_table, power_table = load_calibration(CALIBRATION_FILE)
    logging.info(
        "Loaded calibration entries | cost=%d | power=%d",
        len(cost_table),
        len(power_table),
    )

    psd_paths = list(iter_psd_paths(INPUT_DIR, recursive=RECURSIVE))
    logging.info("Found %d PSD(s) in input directory: %s", len(psd_paths), INPUT_DIR)

    if not psd_paths:
        logging.warning("No PSDs found. Exiting.")
        return

    ok_count = 0
    skipped_count = 0

    for psd_path in psd_paths:
        try:
            result = process_one_psd(
                psd_path=psd_path,
                output_dir=OUTPUT_DIR,
                cost_table=cost_table,
                power_table=power_table,
                overwrite_output=OVERWRITE_OUTPUT,
            )

            status = result["status"]
            messages = result["messages"]

            if status == "ok":
                ok_count += 1
                logging.info("[%s] %s", status, result["file"])
                for msg in messages:
                    logging.info("    %s", msg)
            else:
                skipped_count += 1
                logging.warning("[%s] %s", status, result["file"])
                for msg in messages:
                    logging.warning("    %s", msg)

        except Exception as e:
            skipped_count += 1
            logging.exception("[error] %s | %s", psd_path.name, e)

    logging.info("Done. Successful: %d | Skipped/Errors: %d", ok_count, skipped_count)


if __name__ == "__main__":
    main()
