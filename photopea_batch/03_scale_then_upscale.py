#!/usr/bin/env python3
import os, io, math, zipfile, argparse
from typing import List
import numpy as np
from PIL import Image, ImageFilter
import pandas as pd

# --------------------------
# Defaults (your paths)
# --------------------------
DEFAULT_INPUT = "logos_raw"  # folder of raw downloaded logos (within this script folder by default)
DEFAULT_OUTPUT = "logos_cleaned"  # output folder (within this script folder by default)

# --------------------------
# Helpers
# --------------------------
def ensure_dir(p: str): os.makedirs(p, exist_ok=True)

def is_image(name:str)->bool:
    n = name.lower()
    return n.endswith((".png",".webp",".jpg",".jpeg",".tif",".tiff"))

def iter_images(input_path:str):
    """Yield (relpath, bytes) from folder or zip."""
    if os.path.isdir(input_path):
        base = os.path.abspath(input_path)
        for root,_,files in os.walk(base):
            for f in files:
                if is_image(f):
                    p = os.path.join(root,f)
                    with open(p,"rb") as fh: data = fh.read()
                    rel = os.path.relpath(p, base).replace("\\","/")
                    yield rel, data
    elif zipfile.is_zipfile(input_path):
        with zipfile.ZipFile(input_path,"r") as z:
            for name in z.namelist():
                if is_image(name):
                    data = z.read(name)
                    yield name.replace("\\","/"), data
    else:
        raise ValueError("Input is neither a folder nor a zip")

def pil_open_rgba(b: bytes) -> Image.Image:
    return Image.open(io.BytesIO(b)).convert("RGBA")

def save_with_dpi(img: Image.Image, out_path: str, dpi: int):
    ensure_dir(os.path.dirname(out_path))
    if out_path.lower().endswith((".tif",".tiff")):
        img.save(out_path, dpi=(dpi,dpi), compression="tiff_lzw")
    else:
        img.save(out_path, dpi=(dpi,dpi), optimize=True)

# --------------------------
# Scan → CSV
# --------------------------
def scan_one(im: Image.Image, relpath: str) -> dict:
    im = im.convert("RGBA")
    width, height = im.size
    info = im.info
    dpi_tuple = info.get("dpi", (None, None))
    dpi_x = float(dpi_tuple[0]) if isinstance(dpi_tuple, tuple) else None
    dpi_y = float(dpi_tuple[1]) if isinstance(dpi_tuple, tuple) else None

    arr = np.array(im)
    rgb = arr[:,:,:3].astype(np.int16)
    a   = arr[:,:,3]

    total = width*height
    transparent = int(np.count_nonzero(a==0))
    semi_trans  = int(np.count_nonzero((a>0)&(a<255)))
    opaque      = int(np.count_nonzero(a==255))
    fg = total - transparent if total else 0

    # boundary via 4-neighborhood
    fg_mask = a>=1
    pad = np.pad(fg_mask.astype(np.uint8), 1)
    up,down,left,right = pad[:-2,1:-1], pad[2:,1:-1], pad[1:-1,:-2], pad[1:-1,2:]
    boundary = fg_mask & (~(up & down & left & right))
    boundary_count = int(np.count_nonzero(boundary))
    boundary_semi  = int(np.count_nonzero(boundary & (a<255)))

    gx = np.abs(np.diff(rgb,axis=1)).sum(axis=2)
    gy = np.abs(np.diff(rgb,axis=0)).sum(axis=2)
    mean_grad = float((gx.mean()+gy.mean())/2.0)
    max_grad  = int(max(gx.max(initial=0), gy.max(initial=0)))

    alpha_halo_ratio = (semi_trans/fg) if fg>0 else 0.0
    boundary_ratio   = (boundary_count/fg) if fg>0 else 0.0

    # complexity threshold (preset switch): 0.14 (empirically tuned)
    complexity_score = (mean_grad/(255.0*3.0)) + (boundary_semi/max(1,fg))*1.5 + alpha_halo_ratio*0.5
    preset = "detail_safe" if complexity_score>0.14 else "clean_edges"

    # scaling to 300 DPI; assume 96 if missing
    src_dpi = (dpi_x if dpi_x and dpi_x>1 else 96.0)
    scale = max(300.0/src_dpi, 1.0)
    target_w = int(round(width*scale))
    target_h = int(round(height*scale))

    return {
        "file": relpath,
        "width_px": width, "height_px": height,
        "dpi_x": dpi_x, "dpi_y": dpi_y,
        "transparent_px": transparent, "semi_transparent_px": semi_trans, "opaque_px": opaque,
        "foreground_px": int(fg),
        "boundary_px": boundary_count, "boundary_semi_transparent_px": boundary_semi,
        "boundary_ratio": round(boundary_ratio,6), "alpha_halo_ratio": round(alpha_halo_ratio,6),
        "max_gradient_0_765": max_grad, "mean_gradient": round(mean_grad,3),
        "suggested_preset": preset,
        "scale_factor_to_300dpi": round(scale,4),
        "target_width_px": target_w, "target_height_px": target_h
    }

def run_scan(input_path:str, csv_out:str)->pd.DataFrame:
    rows: List[dict] = []
    for rel, data in iter_images(input_path):
        try:
            im = pil_open_rgba(data)
            rows.append(scan_one(im, rel))
        except Exception as e:
            rows.append({"file": rel, "error": str(e)})
    df = pd.DataFrame(rows)
    ensure_dir(os.path.dirname(csv_out))
    df.to_csv(csv_out, index=False)
    return df

# --------------------------
# Processing (Heimdall-first-pass; Lanczos-only)
# --------------------------
def alpha_tighten_edges(im: Image.Image, aggressiveness=0.75, keep_texture=False):
    arr = np.array(im).astype(np.uint8)
    a = arr[:,:,3].astype(np.float32)
    fg = a>=1
    pad = np.pad(fg.astype(np.uint8),1)
    up,down,left,right = pad[:-2,1:-1], pad[2:,1:-1], pad[1:-1,:-2], pad[1:-1,2:]
    boundary = fg & (~(up & down & left & right))
    target = boundary if keep_texture else (fg & (a<255))
    low  = (a<128) & target
    high = (a>=128) & target
    a[low]  = a[low]*(1.0-aggressiveness)
    a[high] = a[high] + (255.0-a[high])*aggressiveness
    a = np.clip(a,0,255).astype(np.uint8)
    out = arr.copy(); out[:,:,3]=a
    return Image.fromarray(out, "RGBA")

def micro_smooth_fills(im: Image.Image, radius=0.5):
    if radius<=0: return im
    rgb_blur = im.convert("RGB").filter(ImageFilter.GaussianBlur(radius=radius))
    out = rgb_blur.convert("RGBA"); out.putalpha(im.split()[-1]); return out

def unsharp(im: Image.Image, radius=0.6, amount=0.8, threshold=0):
    return im.filter(ImageFilter.UnsharpMask(radius=radius, percent=int(amount*100), threshold=threshold))

def upscale_lanczos(im: Image.Image, tw:int, th:int):
    from PIL import Image as _PIL
    return im.resize((tw,th), resample=_PIL.Resampling.LANCZOS)

def compute_target(im: Image.Image, target_dpi:int):
    dpi = im.info.get("dpi", None)
    src_dpi = float(dpi[0]) if (dpi and dpi[0] and dpi[0]>1) else 96.0
    scale = max(target_dpi/src_dpi, 1.0)
    tw = int(round(im.width*scale)); th=int(round(im.height*scale))
    return tw, th, scale

def process_clean_edges(im, tw, th):
    im1 = alpha_tighten_edges(im, aggressiveness=0.75, keep_texture=False)
    im2 = micro_smooth_fills(im1, radius=0.5)
    im3 = upscale_lanczos(im2, tw, th)
    return unsharp(im3, radius=0.6, amount=0.8, threshold=0)

def process_detail_safe(im, tw, th):
    im1 = alpha_tighten_edges(im, aggressiveness=0.5, keep_texture=True)
    im2 = im1  # no fill blur for texture logos
    im3 = upscale_lanczos(im2, tw, th)
    return unsharp(im3, radius=0.5, amount=0.6, threshold=0)

# --------------------------
# Main
# --------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=DEFAULT_INPUT, help="Input folder or .zip of raw logos (default: ./logos_raw next to this script)")
    ap.add_argument("--output", default=DEFAULT_OUTPUT, help="Output folder for cleaned/upscaled logos + logo_scan.csv (default: ./logos_cleaned next to this script)")
    ap.add_argument("--dpi", type=int, default=300, help="Target DPI (default 300)")
    ap.add_argument("--overwrite", action="store_true", help="Overwrite existing outputs")
    args = ap.parse_args()

    # Resolve relative paths against the folder containing this script (not the current working directory).
    script_dir = os.path.dirname(os.path.abspath(__file__))

    def _resolve(p: str) -> str:
        p = os.path.expanduser(str(p))
        if os.path.isabs(p):
            return p
        return os.path.join(script_dir, p)

    args.input = _resolve(args.input)
    args.output = _resolve(args.output)


    ensure_dir(args.output)
    csv_out = os.path.join(args.output, "logo_scan.csv")

    # 1) SCAN → CSV
    rows: List[dict] = []
    for rel, data in iter_images(args.input):
        try:
            im = pil_open_rgba(data)
            rows.append(scan_one(im, rel))
        except Exception as e:
            rows.append({"file": rel, "error": str(e)})
    df = pd.DataFrame(rows)
    df.to_csv(csv_out, index=False)

    # 2) PROCESS (idiographic presets from scan) — Lanczos-only
    preset_map = {r["file"]: r.get("suggested_preset") for r in rows}

    for rel, data in iter_images(args.input):
        out_rel = os.path.splitext(rel)[0] + ".png"
        out_path = os.path.join(args.output, out_rel)

        if (not args.overwrite) and os.path.exists(out_path):
            print(f"[SKIP] {rel} -> {out_path} (already exists)")
            continue

        try:
            im = pil_open_rgba(data)
            tw, th, scale = compute_target(im, args.dpi)
            preset = preset_map.get(rel, None) or "clean_edges"

            if preset=="clean_edges":
                out_img = process_clean_edges(im, tw, th)
            else:
                out_img = process_detail_safe(im, tw, th)

            save_with_dpi(out_img, out_path, args.dpi)
            print(f"[OK] {rel} -> {out_path} ({preset}, {im.width}x{im.height} -> {tw}x{th})")
        except Exception as e:
            print(f"[ERR] {rel}: {e}")

if __name__=="__main__":
    main()

