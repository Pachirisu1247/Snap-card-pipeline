
#!/usr/bin/env python3
"""
06_photopea_logo_resize.py

Standalone Photopea logo-relayout pass for Marvel Snap PSDs.

Assumptions based on your PSD structure:
- hidden template/reference layer: "Logo"
- real visible per-card logo layer: usually "Layer 12"

Refined sizing/placement behavior:
- globally a bit larger than before
- vertical placement anchored by desired bottom gap to the art border
- wider logos sit lower than narrower/blockier ones
- extra boost for blockier / narrower logos
- relaxed clamp box so logos may bulge outside the art border stylistically
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file

PORT = 5001

BASE_DIR = Path(__file__).resolve().parent
INPUT_DIR = BASE_DIR / "output_psd_calibrated"
OUTPUT_DIR = BASE_DIR / "output_psd_calibrated_logo"

OVERWRITE_OUTPUT = False
RECURSIVE = False
FILE_TIMEOUT_MS = 120000

PSD_EXTS = {".psd", ".psb"}
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_.-]")

app = Flask(__name__)


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def iter_psd_paths(input_dir: Path):
    pattern = "**/*" if RECURSIVE else "*"
    for p in sorted(input_dir.glob(pattern)):
        if p.is_file() and p.suffix.lower() in PSD_EXTS:
            yield p


def rel_psd_name(path: Path) -> str:
    return str(path.relative_to(INPUT_DIR)).replace("\\", "/")


def sanitize_path_components(rel_name: str) -> Path:
    parts = Path(rel_name).parts
    safe_parts = [SAFE_NAME_RE.sub("_", part) for part in parts]
    return Path(*safe_parts)


def input_path_for(rel_name: str) -> Path:
    if RECURSIVE:
        return INPUT_DIR / rel_name
    return INPUT_DIR / Path(rel_name).name


def output_path_for(rel_name: str) -> Path:
    if RECURSIVE:
        return OUTPUT_DIR / sanitize_path_components(rel_name)
    return OUTPUT_DIR / SAFE_NAME_RE.sub("_", Path(rel_name).name)


def build_psd_manifest():
    if not INPUT_DIR.exists():
        raise FileNotFoundError(f"Input dir not found: {INPUT_DIR}")

    items = []
    skipped_existing = 0

    for p in iter_psd_paths(INPUT_DIR):
        rel = rel_psd_name(p)
        out = output_path_for(rel)
        if out.exists() and not OVERWRITE_OUTPUT:
            skipped_existing += 1
            continue

        items.append({
            "name": rel,
            "size_bytes": p.stat().st_size,
        })

    return {
        "items": items,
        "skipped_existing": skipped_existing,
        "input_dir": str(INPUT_DIR),
        "output_dir": str(OUTPUT_DIR),
    }


def copy_original_to_output(rel_name: str) -> tuple[bool, str]:
    src = input_path_for(rel_name)
    dst = output_path_for(rel_name)

    if not src.exists():
        return False, f"Input PSD not found: {src}"

    ensure_dir(dst.parent)
    shutil.copy2(src, dst)
    return True, str(dst)


INDEX_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Step 06 — Photopea Logo Resize Pass</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 1rem; }
    h1 { font-size: 1.35rem; margin-top: 0; }
    button { font: inherit; padding: 0.45rem 0.8rem; margin-right: 0.5rem; }
    #log { margin-top: 0.75rem; padding: 0.5rem; border: 1px solid #ddd; height: 320px; overflow: auto; font-size: 0.8rem; white-space: pre-wrap; }
    #pp-wrapper { margin-top: 0.75rem; border: 1px solid #ccc; }
    iframe { width: 100%; height: 720px; border: 0; }
    .small { font-size: 0.85rem; opacity: 0.78; }
    code { background: #f4f4f4; padding: 0.1rem 0.25rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Step 06 — Photopea Logo Resize Pass</h1>
  <p class="small">
    Uses hidden <code>Logo</code> as the anchor and scans top-level <code>doc.layers</code> for visible <code>Layer 12</code>.
  </p>

  <button id="btnOpen" onclick="document.getElementById('pp').src='https://www.photopea.com';">Open Photopea</button>
  <button id="btnStart">Start batch</button>
  <span id="status" class="small"></span>

  <div id="pp-wrapper">
    <iframe id="pp" src="" title="Photopea"></iframe>
  </div>

  <div id="log"></div>

  <script>
    const iframe = document.getElementById("pp");
    const logEl = document.getElementById("log");
    const statusEl = document.getElementById("status");

    let ppWindow = null;
    let ppReady = false;
    let manifest = null;
    let psds = [];
    let currentIndex = -1;
    let busy = false;
    let fileTimer = null;

    function log(msg) {
      console.log(msg);
      logEl.textContent += msg + "\\n";
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(msg) {
      statusEl.textContent = msg;
    }

    function clearFileTimer() {
      if (fileTimer) {
        clearTimeout(fileTimer);
        fileTimer = null;
      }
    }

    function startFileTimer(itemName) {
      clearFileTimer();
      fileTimer = setTimeout(async () => {
        log("TIMEOUT: " + itemName + " exceeded 120000 ms. Copying original and moving on.");
        await copyOriginalAndAdvance(itemName, "timeout");
      }, 120000);
    }

    async function loadManifest() {
      if (manifest) return manifest;
      log("Fetching PSD manifest...");
      const res = await fetch("/psds.json");
      if (!res.ok) throw new Error("Failed to load psds.json: " + res.status);
      manifest = await res.json();
      psds = manifest.items || [];
      log("Loaded " + psds.length + " PSD(s). Skipped existing outputs: " + (manifest.skipped_existing || 0));
      return manifest;
    }

    async function loadPsdBuffer(name) {
      log("Fetching PSD: " + name);
      const res = await fetch("/psd/" + encodeURIComponent(name));
      if (!res.ok) throw new Error("Failed to fetch PSD " + name + ": " + res.status);
      return await res.arrayBuffer();
    }

    async function uploadPsd(filename, arrayBuffer) {
      log("Uploading " + filename + " to /save ...");
      const res = await fetch("/save?filename=" + encodeURIComponent(filename), {
        method: "POST",
        body: arrayBuffer
      });
      if (!res.ok) throw new Error("Save failed: " + res.status);
      log("Saved " + filename);
    }

    async function copyOriginalAndAdvance(itemName, reason) {
      clearFileTimer();
      try {
        const res = await fetch("/copy_original?filename=" + encodeURIComponent(itemName), {
          method: "POST"
        });
        if (!res.ok) {
          log("ERROR copy_original failed for " + itemName + ": HTTP " + res.status);
        } else {
          const payload = await res.json();
          if (payload.ok) log("Copied original for " + itemName + " (" + reason + ")");
          else log("ERROR copy_original failed for " + itemName + ": " + payload.error);
        }
      } catch (err) {
        log("ERROR copy_original threw for " + itemName + ": " + err);
      }

      try {
        if (ppWindow && !ppWindow.closed) {
          ppWindow.postMessage(buildCleanupScript(), "*");
        }
      } catch (e) {}

      setTimeout(() => {
        processNext();
      }, 300);
    }

    function buildCleanupScript() {
      return `
        (function () {
          try {
            while (app.documents && app.documents.length > 0) {
              try {
                app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
              } catch (e) {
                break;
              }
            }
            app.echoToOE("CLEANUP:ok");
          } catch (e) {
            app.echoToOE("CLEANUP:err:" + e);
          }
        })();
      `;
    }

    function buildRelayoutScript(psdName) {
      function esc(str) {
        return String(str)
          .replace(/\\\\/g, "\\\\\\\\")
          .replace(/"/g, '\\\\"')
          .replace(/\\n/g, "\\\\n");
      }

      const safeName = esc(psdName);
      const outName = esc(psdName);

      return `
        (function () {
          var doc = app.activeDocument;
          try { doc.name = "${safeName}"; } catch (e) { app.echoToOE("ERR:docname:" + e); }

          function boundsToNums(b) {
            return [b[0].value, b[1].value, b[2].value, b[3].value];
          }

          function bboxWidth(bb) { return bb[2] - bb[0]; }
          function bboxHeight(bb) { return bb[3] - bb[1]; }
          function centerX(bb) { return (bb[0] + bb[2]) / 2.0; }

          function fail(code, msg) {
            try { app.echoToOE("RESULT:error:" + outName + ":" + code + ":" + msg); } catch (e) {}
            try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
            return;
          }

          var anchorLayer = null;
          try {
            anchorLayer = doc.layers.getByName("Logo");
          } catch (e) {
            anchorLayer = null;
          }

          if (!anchorLayer) {
            fail("missingAnchor", "Could not find hidden Logo layer via doc.layers.getByName");
            return;
          }

          var ab;
          try {
            ab = boundsToNums(anchorLayer.bounds);
            app.echoToOE("DBG:anchorFromLogo:" + ab.join(","));
          } catch (e) {
            fail("anchorBounds", String(e));
            return;
          }

          app.echoToOE("DBG:scanningTopLayers");

          var topLayers = [];
          try {
            topLayers = doc.layers || [];
          } catch (e) {
            fail("topLayers", String(e));
            return;
          }

          var logo = null;
          var topSummary = [];

          for (var i = 0; i < topLayers.length; i++) {
            var lyr = topLayers[i];
            var name = "";
            var visible = true;
            var isGroup = false;

            try { name = String(lyr.name || ""); } catch (e) { name = ""; }
            try { visible = (lyr.visible !== false); } catch (e) { visible = true; }
            try { isGroup = !!(lyr.layers && lyr.layers.length > 0); } catch (e) { isGroup = false; }

            topSummary.push(name + ":v=" + visible + ":g=" + isGroup);

            if (name === "Layer 12" && visible && !isGroup) {
              logo = lyr;
              break;
            }
          }

          app.echoToOE("DBG:topLayers:" + topSummary.slice(0, 25).join("|"));

          if (!logo) {
            fail("missingLayer12", "Could not find visible non-group Layer 12 in top-level doc.layers");
            return;
          }

          var lb;
          try {
            lb = boundsToNums(logo.bounds);
            app.echoToOE("DBG:chosenLogo:" + logo.name);
            app.echoToOE("DBG:initialLogoBounds:" + lb.join(","));
          } catch (e) {
            fail("logoBounds", String(e));
            return;
          }

          function computeScale(anchorB, logoB) {
            var anchorW = anchorB[2] - anchorB[0];
            var anchorH = anchorB[3] - anchorB[1];
            var logoW = logoB[2] - logoB[0];
            var logoH = logoB[3] - logoB[1];

            if (!(anchorW > 0 && anchorH > 0 && logoW > 0 && logoH > 0)) return 100.0;

            var base = Math.min(anchorW / logoW, anchorH / logoH);

            var scale = base * 99.15;
            var aspect = logoW / Math.max(1, logoH);

            if (aspect > 2.6) scale *= 1.018;
            if (aspect > 3.4) scale *= 1.012;

            if (aspect < 1.9) scale *= 1.05;
            if (aspect < 1.55) scale *= 1.07;
            if (aspect < 1.35) scale *= 1.08;

            return scale;
          }

          var scalePercent = computeScale(ab, lb);

          try {
            logo.resize(scalePercent, scalePercent);
            app.echoToOE("DBG:scalePercent:" + scalePercent.toFixed(3));
          } catch (e) {
            fail("resize", String(e));
            return;
          }

          try {
            lb = boundsToNums(logo.bounds);
          } catch (e) {
            fail("postResizeBounds", String(e));
            return;
          }

          var aspectAfter = bboxWidth(lb) / Math.max(1, bboxHeight(lb));

          function targetBottomGap(aspect) {
            // Positive = sits just above the border. Negative = extends below it.
            var gap = 2;
            if (aspect > 1.95) gap = -4;
            if (aspect > 2.25) gap = -10;
            if (aspect > 2.65) gap = -16;
            if (aspect > 3.10) gap = -22;
            return gap;
          }

          var desiredBottomGap = targetBottomGap(aspectAfter);
          var targetBottom = ab[3] - desiredBottomGap;

          var dx = centerX(ab) - centerX(lb);
          var dy = targetBottom - lb[3];

          try {
            logo.translate(dx, dy);
            app.echoToOE("DBG:translate:" + dx.toFixed(3) + "," + dy.toFixed(3));
            app.echoToOE("DBG:desiredBottomGap:" + desiredBottomGap);
          } catch (e) {
            fail("translate", String(e));
            return;
          }

          function outsideRelaxed(logoB, anchorB) {
            var relaxed = [
              anchorB[0] - 48,
              anchorB[1] - 10,
              anchorB[2] + 48,
              anchorB[3] + 56
            ];
            return (
              logoB[0] < relaxed[0] ||
              logoB[1] < relaxed[1] ||
              logoB[2] > relaxed[2] ||
              logoB[3] > relaxed[3]
            );
          }

          var iter = 0;
          while (iter < 25) {
            try { lb = boundsToNums(logo.bounds); } catch (e) {
              fail("clampBounds", String(e));
              return;
            }
            if (!outsideRelaxed(lb, ab)) break;

            try { logo.resize(98.95, 98.95); } catch (e) {
              fail("clampResize", String(e));
              return;
            }

            try { lb = boundsToNums(logo.bounds); } catch (e) {
              fail("clampPostResizeBounds", String(e));
              return;
            }

            var dx2 = centerX(ab) - centerX(lb);
            var dy2 = targetBottom - lb[3];

            try { logo.translate(dx2, dy2); } catch (e) {
              fail("clampTranslate", String(e));
              return;
            }
            iter++;
          }

          try {
            lb = boundsToNums(logo.bounds);
            app.echoToOE("DBG:finalBounds:" + lb.join(","));
            app.echoToOE("DBG:anchorBounds:" + ab.join(","));
          } catch (e) {
            fail("finalBounds", String(e));
            return;
          }

          try {
            app.activeDocument = doc;
            doc.saveToOE("psd:true");
            app.echoToOE("RESULT:save_requested:" + outName);
          } catch (e) {
            fail("save", String(e));
            return;
          }

          try {
            doc.close(SaveOptions.DONOTSAVECHANGES);
          } catch (e) {
            app.echoToOE("WARN:closeAfterSave:" + e);
          }
        })();
      `;
    }

    async function processNext() {
      currentIndex++;
      clearFileTimer();

      if (currentIndex >= psds.length) {
        log("Batch complete. Processed " + psds.length + " PSD(s).");
        setStatus("Done: " + psds.length + " PSD(s) processed.");
        busy = false;
        return;
      }

      const item = psds[currentIndex];
      setStatus("Processing " + (currentIndex + 1) + " / " + psds.length + ": " + item.name);

      try {
        item._stage = "cleanup-before-open";
        if (!ppWindow || ppWindow.closed) {
          throw new Error("Photopea window not available.");
        }
        startFileTimer(item.name);
        ppWindow.postMessage(buildCleanupScript(), "*");
      } catch (err) {
        log("ERROR cleanup-before-open for " + item.name + ": " + err);
        await copyOriginalAndAdvance(item.name, "cleanup-before-open-error");
      }
    }

    async function fetchAndSendCurrentPsd() {
      const item = psds[currentIndex];
      if (!item) return;
      try {
        const buf = await loadPsdBuffer(item.name);
        item._stage = "psd-sent";
        ppWindow.postMessage(buf, "*");
      } catch (err) {
        log("ERROR fetching PSD " + item.name + ": " + err);
        await copyOriginalAndAdvance(item.name, "fetch-error");
      }
    }

    function sendRelayoutScriptForCurrent() {
      const item = psds[currentIndex];
      if (!item) return;
      const script = buildRelayoutScript(item.name);
      log("Sending relayout JS for " + item.name + " ...");
      item._stage = "script-sent";
      ppWindow.postMessage(script, "*");
    }

    window.addEventListener("message", async (e) => {
      if (!ppWindow && e.source === iframe.contentWindow) {
        ppWindow = e.source;
      }
      if (e.source !== iframe.contentWindow) return;

      if (e.data === "done") {
        if (!ppReady) {
          ppReady = true;
          log("Photopea ready.");
          setStatus("Photopea ready.");
          return;
        }

        if (busy) {
          const item = psds[currentIndex];
          if (!item) return;

          if (item._stage === "cleanup-before-open") {
            log("Cleanup finished for " + item.name + ", fetching PSD...");
            await fetchAndSendCurrentPsd();
          } else if (item._stage === "psd-sent") {
            log("PSD opened for " + item.name + ", sending relayout JS...");
            sendRelayoutScriptForCurrent();
          } else if (item._stage === "script-sent") {
            log("Relayout JS finished for " + item.name + ", waiting for PSD buffer...");
          }
        }
        return;
      }

      if (e.data instanceof ArrayBuffer) {
        const item = psds[currentIndex];
        if (!item) {
          log("Received PSD buffer but no current item.");
          return;
        }

        clearFileTimer();

        try {
          await uploadPsd(item.name, e.data);
        } catch (err) {
          log("ERROR saving PSD " + item.name + ": " + err);
          await copyOriginalAndAdvance(item.name, "upload-error");
          return;
        }

        processNext();
        return;
      }

      if (typeof e.data === "string") {
        const msg = e.data;
        log("From Photopea: " + msg);

        const item = psds[currentIndex];

        if (msg.startsWith("RESULT:error:")) {
          if (item) {
            await copyOriginalAndAdvance(item.name, msg);
          }
          return;
        }

        if (msg.startsWith("RESULT:save_requested:")) {
          return;
        }

        if (msg.startsWith("ERR:")) {
          if (item) {
            await copyOriginalAndAdvance(item.name, msg);
          }
          return;
        }

        return;
      }

      log("Unknown message type from Photopea.");
    });

    document.getElementById("btnStart").addEventListener("click", async () => {
      if (!iframe.src) {
        alert("Open Photopea first.");
        return;
      }

      try {
        const mf = await loadManifest();
        if (!mf.items || !mf.items.length) {
          log("Nothing to process. Manifest is empty.");
          setStatus("Nothing to process.");
          alert("No PSDs to process. Either the input folder is empty or outputs already exist.");
          return;
        }
      } catch (err) {
        log("ERROR loading manifest: " + err);
        alert("Failed to load PSD manifest.");
        return;
      }

      if (!ppReady) {
        alert("Wait until Photopea reports ready.");
        return;
      }

      if (!ppWindow || ppWindow.closed) {
        ppWindow = iframe.contentWindow;
      }

      if (busy) {
        alert("Batch already running.");
        return;
      }

      busy = true;
      currentIndex = -1;
      psds.forEach(x => { delete x._stage; });
      log("Starting batch...");
      processNext();
    });
  </script>
</body>
</html>
"""


@app.route("/")
def index():
    return Response(INDEX_HTML, mimetype="text/html")


@app.route("/psds.json")
def psds_json():
    return jsonify(build_psd_manifest())


@app.route("/psd/<path:name>")
def serve_psd(name):
    path = input_path_for(name)
    if not path.exists() or not path.is_file():
        return f"PSD not found: {name}", 404
    return send_file(path, mimetype="application/octet-stream")


@app.route("/save", methods=["POST"])
def save():
    filename = request.args.get("filename", "output.psd")
    out_path = output_path_for(filename)
    ensure_dir(out_path.parent)
    with open(out_path, "wb") as f:
        f.write(request.data)
    return "OK"


@app.route("/copy_original", methods=["POST"])
def copy_original():
    filename = request.args.get("filename", "")
    if not filename:
        return jsonify({"ok": False, "error": "Missing filename"}), 400
    ok, detail = copy_original_to_output(filename)
    if ok:
        return jsonify({"ok": True, "output_path": detail})
    return jsonify({"ok": False, "error": detail}), 400


if __name__ == "__main__":
    ensure_dir(OUTPUT_DIR)

    if not INPUT_DIR.exists():
        raise RuntimeError(f"Input directory does not exist: {INPUT_DIR}")

    print(f"Serving on http://127.0.0.1:{PORT}")
    print(f"Input PSDs : {INPUT_DIR}")
    print(f"Output PSDs: {OUTPUT_DIR}")
    app.run("127.0.0.1", PORT, debug=True)
