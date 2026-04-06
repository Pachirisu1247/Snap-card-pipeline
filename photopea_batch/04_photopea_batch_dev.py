import os
import re
from flask import Flask, Response, request, jsonify, send_file
import pandas as pd
from PIL import Image  # for auto-cropping logos

# ---------- CONFIG ----------
PORT = 5000
CARDS_CSV = "snap_cards.msz_latest.csv"
TEMPLATE_PSD = "AgathaNew.psd"
OUTPUT_DIR = "output_psd"
BATCH_LIMIT = None   # e.g., 5 to test on first 5 cards, or None for all

# Logos on disk (raw and cropped)
LOGO_DIR_RAW = r"C:\Users\allda\OneDrive - University of Southern California\Marvel Snap Cards\photopea_batch\logos_cleaned"
LOGO_EXT = ".png"  # logo files are PNG
CROPPED_SUBDIR = "cropped"
LOGO_DIR = os.path.join(LOGO_DIR_RAW, CROPPED_SUBDIR)  # we will serve from here

# ---------- SETUP ----------
app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(BASE_DIR, OUTPUT_DIR), exist_ok=True)

def ensure_cropped_logos():
    """
    Auto-crop transparency from all logo PNGs in LOGO_DIR_RAW
    and write them into LOGO_DIR (cropped). Runs on startup.
    Only processes files that don't already exist in the cropped folder.
    """
    os.makedirs(LOGO_DIR, exist_ok=True)

    # --- Tunables (keep conservative; only hit obvious artifacts) ---
    ALPHA_THRESHOLD = 10          # your original idea
    TOP_SCAN_ROWS = 12            # only inspect a small band at the top
    DARK_RGB_MAX = 35             # "near-black" threshold (0-255)
    MIN_ROW_COVERAGE = 0.85       # fraction of width that must be artifact
    MAX_STRIP_HEIGHT = 8          # don't remove more than this many rows

    for fname in os.listdir(LOGO_DIR_RAW):
        if not fname.lower().endswith(LOGO_EXT.lower()):
            continue

        src = os.path.join(LOGO_DIR_RAW, fname)
        dst = os.path.join(LOGO_DIR, fname)
        if os.path.exists(dst):
            continue

        try:
            with Image.open(src) as im:
                img = im.convert("RGBA")

            w, h = img.size
            px = img.load()  # pixel access

            # 1) Build a "clean alpha" mask (like your current approach)
            alpha = img.split()[3]
            alpha_clean = alpha.point(lambda a: 255 if a > ALPHA_THRESHOLD else 0)

            # 2) Detect + remove a thin top dark strip if present
            #    Rule: rows near the top with lots of opaque pixels AND those opaque pixels are very dark.
            strip_rows = 0
            scan_h = min(TOP_SCAN_ROWS, h)

            for y in range(scan_h):
                dark_opaque = 0
                opaque = 0
                for x in range(w):
                    r, g, b, a = px[x, y]
                    if a > ALPHA_THRESHOLD:
                        opaque += 1
                        if r <= DARK_RGB_MAX and g <= DARK_RGB_MAX and b <= DARK_RGB_MAX:
                            dark_opaque += 1

                if opaque == 0:
                    # fully transparent row at top: definitely not the artifact
                    break

                coverage = dark_opaque / float(w)
                # Require the row to be *mostly* dark+opaque across width
                if coverage >= MIN_ROW_COVERAGE:
                    strip_rows += 1
                    if strip_rows >= MAX_STRIP_HEIGHT:
                        break
                else:
                    # once we hit a non-artifact row, stop expanding
                    break

            if strip_rows > 0:
                # make those rows transparent forcefully
                for y in range(strip_rows):
                    for x in range(w):
                        r, g, b, a = px[x, y]
                        # only nuke pixels that match the artifact conditions
                        if a > ALPHA_THRESHOLD and r <= DARK_RGB_MAX and g <= DARK_RGB_MAX and b <= DARK_RGB_MAX:
                            px[x, y] = (r, g, b, 0)

                # rebuild alpha_clean after modifying alpha
                alpha = img.split()[3]
                alpha_clean = alpha.point(lambda a: 255 if a > ALPHA_THRESHOLD else 0)

            # 3) Crop
            bbox = alpha_clean.getbbox()
            if bbox is None:
                img.save(dst)
            else:
                img.crop(bbox).save(dst)

            print(f"Cropped logo: {fname}" + (f" (removed {strip_rows}px top strip)" if strip_rows else ""))

        except Exception as e:
            print(f"WARNING: failed to crop {fname}: {e}")
            try:
                with Image.open(src) as im:
                    im.save(dst)
            except Exception:
                pass


# run cropping once at startup
ensure_cropped_logos()

# load card data
cards_df = pd.read_csv(os.path.join(BASE_DIR, CARDS_CSV))
# --- FIX: replace NaN with empty strings so JSON is valid ---
cards_df = cards_df.where(pd.notna(cards_df), "")
cards = cards_df.to_dict(orient="records")
if BATCH_LIMIT is not None:
    cards = cards[:BATCH_LIMIT]


def id_to_logo_filename(card_id: str) -> str:
    """
    Convert a card id like 'absorbing-man' to a logo filename like
    'AbsorbingMan_Logo.png', matching your Logos folder.
    """
    parts = card_id.split("-")
    base = "".join(p.capitalize() for p in parts) + "_Logo" + LOGO_EXT
    return base


# ---------- HTML / JS FRONTEND ----------
INDEX_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Marvel Snap Batch → Photopea</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 1rem; }
    h1 { font-size: 1.4rem; margin-top: 0; }
    button { font: inherit; padding: 0.4rem 0.8rem; margin-right: 0.5rem; }
    #log { margin-top: 0.75rem; padding: 0.5rem; border: 1px solid #ddd; height: 200px; overflow: auto; font-size: 0.8rem; white-space: pre-wrap; }
    #pp-wrapper { margin-top: 0.75rem; border: 1px solid #ccc; }
    iframe { width: 100%; height: 600px; border: 0; }
    .small { font-size: 0.85rem; opacity: 0.7; }
  </style>
</head>
<body>
  <h1>Marvel Snap → Photopea Batch Generator</h1>
  <p class="small">
    Steps: (1) Click <b>Open Photopea</b> (wait until it loads). (2) Click <b>Start batch</b>.
    Output PSDs will appear in the <code>output_psd</code> folder next to the Python script.
  </p>
  <button id="btnOpen" onclick="document.getElementById('pp').src='https://www.photopea.com';">Open Photopea</button>
  <button id="btnStart">Start batch</button>
  <span id="status" class="small"></span>

  <div id="pp-wrapper">
    <iframe id="pp" src="" title="Photopea"></iframe>
  </div>

  <div id="log"></div>

  <script>
    const logEl = document.getElementById("log");
    const statusEl = document.getElementById("status");
    const iframe = document.getElementById("pp");

    let ppWindow = null;
    let ppReady = false;
    let templateBuffer = null;
    let cards = [];
    let currentIndex = -1;
    let busy = false;

    function log(msg) {
      console.log(msg);
      logEl.textContent += msg + "\\n";
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(msg) {
      statusEl.textContent = msg;
    }

    function sanitizeFilename(name) {
      return name.replace(/[^A-Za-z0-9_.-]/g, "_");
    }

    async function loadTemplate() {
      if (templateBuffer) return templateBuffer;
      log("Fetching template PSD from /template.psd ...");
      const res = await fetch("/template.psd");
      if (!res.ok) throw new Error("Failed to load template PSD: " + res.status);
      templateBuffer = await res.arrayBuffer();
      log("Template PSD loaded (" + templateBuffer.byteLength + " bytes).");
      return templateBuffer;
    }

    async function loadCards() {
      if (cards.length) return cards;
      log("Fetching card data from /cards.json ...");
      const res = await fetch("/cards.json");
      if (!res.ok) throw new Error("Failed to load cards.json: " + res.status);
      cards = await res.json();
      log("Loaded " + cards.length + " cards from CSV.");
      return cards;
    }

    async function loadLogoBuffer(cardId) {
      log("Fetching logo PNG for " + cardId + " ...");
      const res = await fetch("/logo/" + encodeURIComponent(cardId));
      if (!res.ok) {
        log("No logo for " + cardId + " (status " + res.status + ")");
        return null;
      }
      return await res.arrayBuffer();
    }

    function buildScript1ForCard(card) {
      // Runs after template PSD is opened.
      function esc(str) {
        return String(str)
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\\n/g, "\\n");
      }

      const cost  = esc(card.cost);
      const power = esc(card.power);
      const rules = esc(card.rules);
      const id    = esc(card.id);
      const sentinel = "__TEMPLATE__" + id;

      const LAYER_COST  = "Cost";
      const LAYER_POWER = "Power";
      const LAYER_RULES = "Rules";

      return `
        var doc = app.activeDocument;
        var sentinelName = "${sentinel}";
        try { doc.name = sentinelName; } catch (e) { app.echoToOE("ERR:docname1:" + e); }

        function setTextLayer(layerName, newText) {
          try {
            var layer = doc.layers.getByName(layerName);
            if (!layer) { app.echoToOE("ERR:nolayer:" + layerName); return; }
            if (!layer.textItem) { app.echoToOE("ERR:nottext:" + layerName); return; }
            layer.textItem.contents = newText;
          } catch (e) {
            app.echoToOE("ERR:set1:" + layerName + ":" + e);
          }
        }

        setTextLayer("${LAYER_COST}", "${cost}");
        setTextLayer("${LAYER_POWER}", "${power}");
        setTextLayer("${LAYER_RULES}", "${rules}");

        // Optionally hide base template Logo for clarity
        try {
          var oldLogo = doc.layers.getByName("Logo");
          if (oldLogo) {
            oldLogo.visible = false;
            app.echoToOE("DBG:oldLogoHidden1");
          }
        } catch (e) {
          app.echoToOE("ERR:hideOldLogo1:" + e);
        }
      `;
    }

    function buildScript2ForCard(card) {
      // Runs after logo PNG is opened as a second document.
      function esc(str) {
        return String(str)
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\\n/g, "\\n");
      }

      const id    = esc(card.id);
      const sentinel = "__TEMPLATE__" + id;

      return `
        var docs = app.documents;
        var logoDoc = app.activeDocument; // PNG just opened
        var templateDoc = null;
        var i;

        if (!docs || docs.length === 0) {
          app.echoToOE("ERR:noDocsInScript2");
        } else {
          for (i = 0; i < docs.length; i++) {
            if (docs[i].name === "${sentinel}") {
              templateDoc = docs[i];
              break;
            }
          }
        }

        if (!templateDoc) {
          app.echoToOE("ERR:noTemplateDocScript2:docsLen=" + (docs ? docs.length : "null"));
        } else {
          app.echoToOE("DBG:templateDocFound:" + templateDoc.name + ", logoDoc=" + logoDoc.name);
        }

        if (templateDoc && logoDoc && logoDoc !== templateDoc) {
          // Copy logo from logoDoc → templateDoc
          try {
            app.activeDocument = logoDoc;
            if (logoDoc.layers && logoDoc.layers.length > 0) {
              logoDoc.activeLayer = logoDoc.layers[0];
            }
            app.activeDocument.selection.selectAll();
            app.activeDocument.selection.copy();
          } catch (e) {
            app.echoToOE("ERR:copyLogo2:" + e);
          }

          try {
            app.activeDocument = templateDoc;
            app.activeDocument.paste();
            app.echoToOE("DBG:logoPasted2");
          } catch (e) {
            app.echoToOE("ERR:pasteLogo2:" + e);
          }

          // Scale & move pasted logo to fit LogoAnchor
          try {
            var pastedLayer = templateDoc.activeLayer;
            var anchorLayer = templateDoc.layers.getByName("LogoAnchor");
            if (anchorLayer && pastedLayer && anchorLayer !== pastedLayer) {
              var ab = anchorLayer.bounds; // [left, top, right, bottom]
              var lb = pastedLayer.bounds;

              var anchorW = ab[2].value - ab[0].value;
              var anchorH = ab[3].value - ab[1].value;
              var logoW   = lb[2].value - lb[0].value;
              var logoH   = lb[3].value - lb[1].value;

              if (logoW > 0 && logoH > 0 && anchorW > 0 && anchorH > 0) {
                var scaleFactor = Math.min(anchorW / logoW, anchorH / logoH);
                var padding = 1.17; // ~1.3x larger than previous 0.9 fit
                var scalePercent = scaleFactor * padding * 100.0;

                try {
                  pastedLayer.resize(scalePercent, scalePercent);
                  app.echoToOE("DBG:logoScaledTo:" + scalePercent.toFixed(2) + "%");
                } catch (e) {
                  app.echoToOE("ERR:resizeLogo:" + e);
                }

                // Recompute logo bounds after scaling
                lb = pastedLayer.bounds;
                logoW = lb[2].value - lb[0].value;
                logoH = lb[3].value - lb[1].value;

                var anchorCx = (ab[0].value + ab[2].value) / 2.0;
                var anchorCy = (ab[1].value + ab[3].value) / 2.0;
                var logoCx   = (lb[0].value + lb[2].value) / 2.0;
                var logoCy   = (lb[1].value + lb[3].value) / 2.0;

                var dx = anchorCx - logoCx;
                var dy = anchorCy - logoCy;

                pastedLayer.translate(dx, dy);
                app.echoToOE("DBG:logoMovedToAnchor:" + dx + "," + dy);
              } else {
                app.echoToOE("ERR:invalidBoundsForScale:"
                             + " anchorW=" + anchorW + " anchorH=" + anchorH
                             + " logoW=" + logoW + " logoH=" + logoH);
              }
            } else {
              app.echoToOE("ERR:noAnchorOrPastedLayer");
            }
          } catch (e) {
            app.echoToOE("ERR:moveLogoToAnchor:" + e);
          }

          // Hide old template Logo layer again (in case it's visible)
          try {
            var oldLogo2 = templateDoc.layers.getByName("Logo");
            if (oldLogo2) {
              oldLogo2.visible = false;
              app.echoToOE("DBG:oldLogoHidden2");
            }
          } catch (e) {
            app.echoToOE("ERR:hideOldLogo2:" + e);
          }

          // Rename template to final id
          try {
            templateDoc.name = "${id}";
          } catch (e) {
            app.echoToOE("ERR:docname2:" + e);
          }

          // Save PSD and close docs
          try {
            app.activeDocument = templateDoc;
            app.activeDocument.saveToOE("psd:true");
            app.echoToOE("SAVE:${id}.psd");
          } catch (e) {
            app.echoToOE("ERR:save2:" + e);
          }

          try {
            templateDoc.close(SaveOptions.DONOTSAVECHANGES);
          } catch (e) {
            app.echoToOE("ERR:closeTemplate2:" + e);
          }

          try {
            logoDoc.close(SaveOptions.DONOTSAVECHANGES);
          } catch (e) {
            app.echoToOE("ERR:closeLogo2:" + e);
          }
        } else {
          app.echoToOE("ERR:noLogoOrTemplateDoc2");
        }
      `;
    }

    async function uploadPsd(filename, arrayBuffer) {
      const safe = sanitizeFilename(filename);
      log("Uploading " + safe + " to /save ...");
      const res = await fetch("/save?filename=" + encodeURIComponent(safe), {
        method: "POST",
        body: arrayBuffer
      });
      if (!res.ok) throw new Error("Save failed: " + res.status);
      log("Saved " + safe);
    }

    async function processNextCard() {
      if (!ppReady) {
        log("Photopea not ready yet.");
        return;
      }
      currentIndex++;
      if (currentIndex >= cards.length) {
        log("Batch complete. Processed " + cards.length + " cards.");
        setStatus("Done: " + cards.length + " cards processed.");
        busy = false;
        return;
      }

      const card = cards[currentIndex];
      setStatus("Processing card " + (currentIndex + 1) + " / " + cards.length + ": " + card.id);
      log("Opening template for card " + card.id + " ...");

      const buf = await loadTemplate();
      busy = true;
      card._stage = "template-sent";
      ppWindow.postMessage(buf, "*");
    }

    async function sendLogoForCurrentCard() {
      const card = cards[currentIndex];
      if (!card) return;
      const logoBuf = await loadLogoBuffer(card.id);
      if (!logoBuf) {
        log("No logo buffer for " + card.id + ", going straight to Script 2 (no logo).");
        sendScript2ForCurrentCard();
        return;
      }
      log("Sending logo buffer for " + card.id + " ...");
      card._stage = "logo-sent";
      ppWindow.postMessage(logoBuf, "*");
    }

    function sendScript1ForCurrentCard() {
      const card = cards[currentIndex];
      if (!card) return;
      const script = buildScript1ForCard(card);
      log("Sending Script 1 for card " + card.id + " ...");
      card._stage = "script1-sent";
      ppWindow.postMessage(script, "*");
    }

    function sendScript2ForCurrentCard() {
      const card = cards[currentIndex];
      if (!card) return;
      const script = buildScript2ForCard(card);
      log("Sending Script 2 for card " + card.id + " ...");
      card._stage = "script2-sent";
      ppWindow.postMessage(script, "*");
    }

    // Receive messages from Photopea
    window.addEventListener("message", async (e) => {
      if (!ppWindow && e.source === iframe.contentWindow) {
        ppWindow = e.source;
      }
      if (e.source !== iframe.contentWindow) return;

      if (e.data === "done") {
        if (!ppReady) {
          ppReady = true;
          log("Photopea reported ready (\"done\").");
          setStatus("Photopea ready.");
        } else if (busy) {
          const card = cards[currentIndex];
          if (!card) {
            log("done but no current card");
            return;
          }
          if (!card._stage || card._stage === "template-sent") {
            log("Template opened for " + card.id + ", now sending Script 1 ...");
            sendScript1ForCurrentCard();
          } else if (card._stage === "script1-sent") {
            log("Script 1 finished for " + card.id + ", now sending logo ...");
            await sendLogoForCurrentCard();
          } else if (card._stage === "logo-sent") {
            log("Logo opened for " + card.id + ", now sending Script 2 ...");
            sendScript2ForCurrentCard();
          } else if (card._stage === "script2-sent") {
            log("Script 2 finished for " + card.id + ", waiting for PSD buffer ...");
          }
        }
        return;
      }

      if (e.data instanceof ArrayBuffer) {
        const card = cards[currentIndex];
        if (!card) {
          log("Received ArrayBuffer but no current card.");
          return;
        }
        try {
          await uploadPsd(card.id + ".psd", e.data);
        } catch (err) {
          log("ERROR saving PSD: " + err);
        }
        processNextCard();
        return;
      }

      if (typeof e.data === "string") {
        log("From Photopea: " + e.data);
        return;
      }

      log("Unknown message from Photopea: " + Object.prototype.toString.call(e.data));
    });

    // Buttons
    document.getElementById("btnOpen").addEventListener("click", () => {
      if (!iframe.src) {
        iframe.src = "https://www.photopea.com";
        log("Loading Photopea...");
        setStatus("Loading Photopea...");
      } else if (ppWindow && !ppWindow.closed) {
        ppWindow.focus();
      }
    });

    document.getElementById("btnStart").addEventListener("click", async () => {
      if (!iframe.src) {
        alert("Click 'Open Photopea' first and wait for it to load.");
        return;
      }
      try {
        await loadCards();
      } catch (err) {
        log("ERROR loading cards: " + err);
        alert("Failed to load cards; see log.");
        return;
      }

      if (!ppWindow || ppWindow.closed) {
        ppWindow = iframe.contentWindow;
      }
      ppReady = true;

      if (busy) {
        alert("Batch already running.");
        return;
      }
      log("Starting batch ...");
      currentIndex = -1;
      cards.forEach(c => { delete c._stage; });
      busy = true;
      processNextCard();
    });
  </script>
</body>
</html>
"""

# ---------- ROUTES ----------

@app.route("/")
def index():
    return Response(INDEX_HTML, mimetype="text/html")

@app.route("/cards.json")
def cards_json():
    return jsonify(cards)

@app.route("/logo/<card_id>")
def logo(card_id):
    """
    Serve the (cropped) logo PNG for a given card id, e.g.
    /logo/absorbing-man -> ...\cropped\AbsorbingMan_Logo.png
    """
    filename = id_to_logo_filename(card_id)
    abs_path = os.path.join(LOGO_DIR, filename)

    if not os.path.isfile(abs_path):
        return f"Logo not found for {card_id}", 404

    return send_file(abs_path, mimetype="image/png")

@app.route("/template.psd")
def template_psd():
    path = os.path.join(BASE_DIR, TEMPLATE_PSD)
    return send_file(path, mimetype="application/octet-stream")

@app.route("/save", methods=["POST"])
def save():
    filename = request.args.get("filename", "output.psd")
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", filename)
    out_path = os.path.join(BASE_DIR, OUTPUT_DIR, safe)
    with open(out_path, "wb") as f:
        f.write(request.data)
    return "OK"

if __name__ == "__main__":
    print(f"Serving on http://127.0.0.1:{PORT}")
    app.run("127.0.0.1", PORT, debug=True)
