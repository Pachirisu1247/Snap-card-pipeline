#!/usr/bin/env python3
"""
07_photopea_rules_style_poc.py

Small Photopea proof-of-concept for one target: styling the editable
"Rules" text layer inside the Marvel Snap PSD template.

What this does:
- serves the existing PSD template to Photopea
- opens a minimal browser UI for one-card testing
- inserts sample rules text into the "Rules" layer
- attempts substring styling through action / script code
- logs Photopea messages so we can inspect what actually works

This is intentionally a narrow test harness, not a production batch step.
"""

from __future__ import annotations

from datetime import datetime
import json
import re
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file, url_for

PORT = 5002
APP_BUILD = "2026-04-25-00-03-layout-preserving-overlays"
BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_PSD = BASE_DIR / "AgathaNew.psd"
OUTPUT_DIR = BASE_DIR / "output_rules_style_poc"
FONTS_DIR = BASE_DIR.parent / "Fonts"
DEBUG_LOG = OUTPUT_DIR / "07_rules_style_debug.log"
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_.-]")

app = Flask(__name__)


FONT_SPECS = [
    {
        "filename": "cc-ultimatum-regular.otf",
        "family": "CCUltimatum",
        "style_name": "Regular",
        "postscript_name": "CCUltimatum-Regular",
        "logical_style": "plain",
    },
    {
        "filename": "cc-ultimatum-bold.otf",
        "family": "CCUltimatum",
        "style_name": "Bold",
        "postscript_name": "CCUltimatum-Bold",
        "logical_style": "bold",
    },
    {
        "filename": "cc-ultimatum-italic.otf",
        "family": "CCUltimatum",
        "style_name": "Italic",
        "postscript_name": "CCUltimatum-Italic",
        "logical_style": "italic",
    },
    {
        "filename": "CCElephantmenTall Regular.ttf",
        "family": "CCElephantmenTall",
        "style_name": "Regular",
        "postscript_name": "CCElephantmenTall-Regular",
        "logical_style": "plain",
    },
    {
        "filename": "CCElephantmenTall W10 Bold.ttf",
        "family": "CCElephantmenTall",
        "style_name": "Bold",
        "postscript_name": "CCElephantmenTallW10-Bold",
        "logical_style": "bold",
    },
    {
        "filename": "CCElephantmenTall Bold Italic.ttf",
        "family": "CCElephantmenTall",
        "style_name": "Bold Italic",
        "postscript_name": "CCElephantmenTall-BoldItalic",
        "logical_style": "italic",
    },
]


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def append_debug_log(source: str, message: str) -> None:
    ensure_dir(OUTPUT_DIR)
    timestamp = datetime.now().isoformat(timespec="seconds")
    with DEBUG_LOG.open("a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] [{source}] {message}\n")


def disable_cache(resp: Response) -> Response:
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


def summarize_text(value, limit: int = 500) -> str:
    text = str(value)
    if len(text) > limit:
        return text[:limit] + f"... <truncated {len(text) - limit} chars>"
    return text


def available_font_entries(host_url: str):
    base_url = host_url.rstrip("/")
    items = []
    families: dict[str, dict[str, dict[str, str]]] = {}

    for idx, spec in enumerate(FONT_SPECS):
        path = FONTS_DIR / spec["filename"]
        if not path.exists():
            continue

        family_key = re.sub(r"[^a-z0-9]", "", spec["family"].lower())
        items.append(
            {
                **spec,
                "index": idx,
                "url": f"{base_url}{url_for('font_asset', index=idx)}",
            }
        )
        families.setdefault(family_key, {})[spec["logical_style"]] = {
            "family": spec["family"],
            "styleName": spec["style_name"],
            "postScriptName": spec["postscript_name"],
        }

    return {"items": items, "families": families}


INDEX_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Step 07 - Photopea Rules Style POC</title>
  <style>
    :root {
      --bg: #f5f1e8;
      --panel: #fffaf2;
      --ink: #1f1b17;
      --muted: #6b645d;
      --line: #d9cfbf;
      --accent: #ab3b1f;
      --accent-2: #2c5d7e;
    }

    body {
      margin: 0;
      padding: 1rem;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #fff6d9 0, transparent 22rem),
        linear-gradient(180deg, #f8f3ea 0%, #eee5d8 100%);
    }

    h1 {
      margin: 0 0 0.5rem 0;
      font-size: 1.5rem;
    }

    p {
      margin: 0.4rem 0 0.8rem 0;
      color: var(--muted);
      line-height: 1.4;
    }

    .layout {
      display: grid;
      grid-template-columns: 380px 1fr;
      gap: 1rem;
      align-items: start;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 1rem;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.08);
    }

    textarea {
      width: 100%;
      min-height: 10rem;
      resize: vertical;
      box-sizing: border-box;
      padding: 0.7rem;
      border: 1px solid var(--line);
      border-radius: 10px;
      font: 14px/1.45 Consolas, Monaco, monospace;
      background: #fffdf8;
      color: var(--ink);
    }

    button {
      border: 0;
      border-radius: 999px;
      padding: 0.6rem 0.95rem;
      font: 600 14px/1.1 Georgia, "Times New Roman", serif;
      cursor: pointer;
      margin: 0 0.45rem 0.45rem 0;
      color: white;
      background: var(--accent);
    }

    button.secondary {
      background: var(--accent-2);
    }

    button.ghost {
      color: var(--ink);
      background: #e8dece;
    }

    #status {
      display: inline-block;
      margin-left: 0.25rem;
      color: var(--muted);
      font-size: 0.92rem;
    }

    #pp-wrapper {
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: white;
      min-height: 760px;
    }

    iframe {
      width: 100%;
      height: 760px;
      border: 0;
    }

    #log {
      margin-top: 0.9rem;
      min-height: 16rem;
      max-height: 24rem;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 0.75rem;
      background: #fffdf8;
      white-space: pre-wrap;
      font: 12px/1.45 Consolas, Monaco, monospace;
    }

    .chips {
      margin: 0.6rem 0 0.8rem 0;
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
    }

    .chip {
      background: #efe4d4;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0.25rem 0.55rem;
      font-size: 0.84rem;
      color: var(--ink);
    }
  </style>
</head>
<body>
  <h1>Step 07 - Photopea Rules Style POC</h1>
  <p>
    This is a narrow test harness for one editable PSD text layer. It loads the
    Marvel Snap template, targets <code>Rules</code>, inserts sample text, and
    then attempts mixed styling through Photopea scripting / actions.
  </p>

  <div class="layout">
    <div class="panel">
      <div class="chips">
        <span class="chip">Target layer: Rules</span>
        <span class="chip">Editable PSD preserved</span>
        <span class="chip">Logs action behavior</span>
        <span class="chip">Build: __APP_BUILD__</span>
      </div>

      <label for="rulesText"><strong>Sample rules text</strong></label>
      <textarea id="rulesText">On Reveal: If the last card you played has an On Reveal, copy its text. (if able)

"Foolish rabble! You are beneath me!"</textarea>

      <p>
        The default parser marks leading gameplay keywords as bold, parenthetical
        spans as italic, and fully quoted final lines as flavor italic.
      </p>

      <button id="btnOpen">Open Photopea</button>
      <button id="btnRun" class="secondary">Run Style POC</button>
      <button id="btnPlain" class="ghost">Plain Text Only</button>
      <span id="status"></span>

      <div id="log"></div>
    </div>

    <div class="panel">
      <div id="pp-wrapper">
        <iframe id="pp" src="about:blank" title="Photopea"></iframe>
      </div>
    </div>
  </div>

  <script>
    const iframe = document.getElementById("pp");
    const logEl = document.getElementById("log");
    const statusEl = document.getElementById("status");
    const rulesTextEl = document.getElementById("rulesText");
    const APP_BUILD = "__APP_BUILD__";

    const PHOTOPEA_BASE_URL = "https://www.photopea.com";

    let ppWindow = null;
    let ppReady = false;
    let templateBuffer = null;
    let busy = false;
    let mode = "styled";
    let pendingSaveLabel = "styled";
    let readyWaiters = [];
    let fontManifest = null;
    let currentStage = "idle";
    let watchdogTimers = [];
    let currentJob = null;

    function log(msg) {
      console.log(msg);
      logEl.textContent += msg + "\n";
      logEl.scrollTop = logEl.scrollHeight;
      void mirrorLog("client", msg);
    }

    async function mirrorLog(source, message, extra) {
      try {
        await fetch("/client_log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source,
            message,
            extra: extra || null
          }),
          keepalive: true
        });
      } catch (e) {}
    }

    function setStatus(msg) {
      statusEl.textContent = msg;
      void mirrorLog("status", msg);
    }

    function sanitizeFilename(name) {
      return name.replace(/[^A-Za-z0-9_.-]/g, "_");
    }

    log("Client build: " + APP_BUILD);

    function clearWatchdogs() {
      for (const timer of watchdogTimers) {
        clearTimeout(timer);
      }
      watchdogTimers = [];
    }

    function scheduleWatchdogs() {
      clearWatchdogs();
      watchdogTimers.push(setTimeout(() => {
        if (busy && currentStage === "posting-template-buffer" && currentJob) {
          log("WATCHDOG: no done after posting template buffer; dispatching job fallback.");
          currentStage = "awaiting-script-dispatch";
          dispatchJobStep("template buffer fallback");
        }
      }, 3500));
      watchdogTimers.push(setTimeout(() => {
        if (busy && currentStage === "step-running") {
          const stuckStep = currentJob && currentJob.awaitingStep ? currentJob.awaitingStep : "unknown";
          log("WATCHDOG: step appears stuck (" + stuckStep + "); requesting plain-text fallback save.");
          setStatus("Styling appears stuck; saving plain-text fallback...");
          try {
            pendingSaveLabel = "plain_fallback";
            currentStage = "fallback-saving";
            ppWindow.postMessage(buildPlainSaveFallbackScript(), "*");
          } catch (e) {
            log("ERR:plainSaveFallback:" + e);
          }
        }
      }, 8000));
      watchdogTimers.push(setTimeout(() => {
        if (busy) {
          log("WATCHDOG: 5s elapsed. Stage=" + currentStage + ", ppReady=" + ppReady);
        }
      }, 5000));
      watchdogTimers.push(setTimeout(() => {
        if (busy) {
          log("WATCHDOG: 15s elapsed. Stage=" + currentStage + ", ppReady=" + ppReady);
        }
      }, 15000));
      watchdogTimers.push(setTimeout(() => {
        if (busy && currentStage === "awaiting-script-dispatch" && currentJob && ppWindow) {
          log("WATCHDOG: dispatch fallback after 7s.");
          dispatchJobStep("watchdog");
        }
      }, 7000));
      watchdogTimers.push(setTimeout(() => {
        if (busy && currentStage === "posting-template-buffer" && currentJob) {
          log("WATCHDOG: template buffer open still pending after 9s.");
        }
      }, 9000));
    }

    function dispatchJobStep(reason) {
      if (!busy || currentStage !== "awaiting-script-dispatch" || !currentJob || !ppWindow) {
        return;
      }

      let stepName = "";
      let statusText = "";
      let scriptText = "";

      if (!currentJob.prepared) {
        stepName = "prepare";
        statusText = "Preparing Rules layer...";
        scriptText = buildPrepareScript(currentJob.payload);
        currentJob.prepared = true;
      } else if (currentJob.styled && currentJob.nextOverlayIndex < currentJob.payload.runs.length) {
        const idx = currentJob.nextOverlayIndex;
        const run = currentJob.payload.runs[idx];
        stepName = "overlay:" + idx;
        statusText = "Applying style run " + (idx + 1) + " of " + currentJob.payload.runs.length + "...";
        scriptText = buildOverlayRunScript(currentJob.payload, run, idx);
      } else {
        stepName = "save";
        statusText = "Saving PSD...";
        pendingSaveLabel = currentJob.styled ? "styled" : "plain";
        scriptText = buildSaveScript(pendingSaveLabel);
      }

      currentJob.awaitingStep = stepName;
      currentStage = "step-running";
      log("Sending job step " + stepName + " via " + reason + "...");
      setStatus(statusText);
      ppWindow.postMessage(scriptText, "*");
      scheduleWatchdogs();
    }

    function buildPlainSaveFallbackScript() {
      return `
        (function () {
          function say(msg) {
            try { app.echoToOE(msg); } catch (e) {}
          }
          try {
            var doc = app.activeDocument;
            if (!doc) {
              say("ERR:plainFallback:noActiveDocument");
              return;
            }
            say("DBG:plainFallback:saving");
            doc.saveToOE("psd:true");
            say("SAVE:plain-fallback");
          } catch (e) {
            say("ERR:plainFallback:" + e);
          }
        })();
      `;
    }

    function getFrameSrcAttr() {
      return iframe.getAttribute("src") || "";
    }

    function hasPhotopeaTarget() {
      const src = getFrameSrcAttr();
      return !!src && src.startsWith(PHOTOPEA_BASE_URL);
    }

    async function ensureFontManifest() {
      if (fontManifest) return fontManifest;

      log("Fetching repo font manifest...");
      const res = await fetch("/font_manifest.json", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load font manifest: " + res.status);
      fontManifest = await res.json();

      const names = (fontManifest.items || []).map((item) => item.filename);
      log("Loaded " + names.length + " repo font(s).");
      if (names.length) {
        log("Fonts: " + names.join(", "));
      } else {
        log("WARNING: no repo fonts were found.");
      }

      return fontManifest;
    }

    function buildPhotopeaSrc(manifest) {
      const resources = (manifest.items || []).map((item) => item.url);
      const config = { resources };
      return PHOTOPEA_BASE_URL + "#" + encodeURIComponent(JSON.stringify(config));
    }

    function chooseRulesFamilyKey(families) {
      if (!families) return null;
      if (families.ccultimatum) return "ccultimatum";
      const keys = Object.keys(families);
      return keys.length ? keys[0] : null;
    }

    function resolveReadyWaiters() {
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    }

    function waitForPhotopeaReady(timeoutMs = 45000) {
      if (ppReady) return Promise.resolve();

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          readyWaiters = readyWaiters.filter((waiter) => waiter !== onReady);
          reject(new Error("Timed out waiting for Photopea ready signal."));
        }, timeoutMs);

        function onReady() {
          clearTimeout(timer);
          resolve();
        }

        readyWaiters.push(onReady);
      });
    }

    async function openPhotopea(forceReload = false) {
      const manifest = await ensureFontManifest();
      const nextSrc = buildPhotopeaSrc(manifest);
      const shouldReload = forceReload || getFrameSrcAttr() !== nextSrc;

      if (shouldReload || !hasPhotopeaTarget()) {
        ppReady = false;
        ppWindow = null;
        iframe.setAttribute("src", nextSrc);
        log("Loading Photopea...");
        setStatus("Loading Photopea with repo fonts...");
        return;
      }

      if (ppWindow && !ppWindow.closed) {
        try {
          ppWindow.focus();
        } catch (e) {}
      }
    }

    async function ensurePhotopeaReady() {
      await openPhotopea();

      if (!ppReady) {
        log("Waiting for Photopea ready signal...");
        setStatus("Waiting for Photopea...");
      }

      await waitForPhotopeaReady();
    }

    async function loadTemplate() {
      if (templateBuffer) return templateBuffer;
      log("Fetching template PSD...");
      const res = await fetch("/template.psd", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load template PSD: " + res.status);
      templateBuffer = await res.arrayBuffer();
      log("Template loaded (" + templateBuffer.byteLength + " bytes).");
      return templateBuffer;
    }

    function normalizeText(text) {
      return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    function computeStyleRuns(fullText) {
      const text = normalizeText(fullText);
      const runs = [];
      const keywords = [
        "On Reveal:",
        "Ongoing:",
        "Activate:",
        "End of Turn:",
        "When this is destroyed:",
        "When this card moves:",
        "After you play",
        "After each turn,"
      ];

      function addRun(from, to, style) {
        if (!(from >= 0 && to > from)) return;
        runs.push({ from, to, style });
      }

      for (const keyword of keywords) {
        let start = 0;
        while (true) {
          const idx = text.indexOf(keyword, start);
          if (idx === -1) break;
          const prev = idx === 0 ? "\n" : text[idx - 1];
          if (idx === 0 || prev === "\n") {
            addRun(idx, idx + keyword.length, "bold");
          }
          start = idx + keyword.length;
        }
      }

      const parenRe = /\([^()]+\)/g;
      let match;
      while ((match = parenRe.exec(text)) !== null) {
        addRun(match.index, match.index + match[0].length, "italic");
      }

      const trimmed = text.trimEnd();
      const lines = trimmed.split("\n");
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1].trim();
        if (lastLine.length >= 2 && lastLine.startsWith('"') && lastLine.endsWith('"')) {
          const absolute = trimmed.lastIndexOf(lastLine);
          addRun(absolute, absolute + lastLine.length, "italic");
        }
      }

      runs.sort((a, b) => a.from - b.from || a.to - b.to);
      return { text, runs };
    }

    function buildScript(payload, styled) {
      const dataLiteral = JSON.stringify(payload);

      return `
        (function () {
          var payload = ${dataLiteral};

          function say(msg) {
            try { app.echoToOE(msg); } catch (e) {}
          }

          say("DBG:scriptEntered");

          function clone(obj) {
            return JSON.parse(JSON.stringify(obj));
          }

          function parseStyle(jsonText) {
            try { return JSON.parse(jsonText); }
            catch (e) { return null; }
          }

          function normalizeKey(value) {
            return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          }

          function familyKeyFromBase(base) {
            var candidates = [
              base && base.fontFamily,
              base && base.fontName,
              base && base.fontPostScriptName
            ];

            for (var i = 0; i < candidates.length; i++) {
              var norm = normalizeKey(candidates[i]);
              if (!norm) continue;

              for (var key in payload.fontFamilies) {
                if (norm.indexOf(key) !== -1 || key.indexOf(norm) !== -1) {
                  return key;
                }
              }
            }
            return null;
          }

          function pickFontVariant(baseStyle, desired) {
            var key = familyKeyFromBase(baseStyle || {});
            if (!key) return null;
            var family = payload.fontFamilies[key] || null;
            if (!family) return null;
            return family[desired] || null;
          }

          function applyVariant(style, variant) {
            if (!variant) return;
            if (variant.family) {
              style.fontName = variant.family;
              style.fontFamily = variant.family;
            }
            if (variant.styleName) style.fontStyleName = variant.styleName;
            if (variant.postScriptName) style.fontPostScriptName = variant.postScriptName;
          }

          function styleNameFromBase(base, desired) {
            var baseName = String((base && base.fontStyleName) || "Regular");
            if (desired === "bold") {
              if (/bold/i.test(baseName)) return baseName;
              if (/italic/i.test(baseName)) return "Bold Italic";
              return "Bold";
            }
            if (desired === "italic") {
              if (/italic/i.test(baseName)) return baseName;
              if (/bold/i.test(baseName)) return "Bold Italic";
              return "Italic";
            }
            return baseName;
          }

          function baseRangeStyle(layer) {
            var style = parseStyle(layer.textItem.totalTextStyle || "");
            if (!style) style = {};
            return style;
          }

          function buildRangeStyle(baseStyle, desired) {
            var s = clone(baseStyle || {});
            s.styleSheetHasParent = true;
            s.syntheticBold = false;
            s.fauxBold = false;
            s.syntheticItalic = false;
            s.fauxItalic = false;
            s.italics = false;

            var variant = pickFontVariant(baseStyle, desired);
            if (variant) {
              applyVariant(s, variant);
            }

            if (desired === "bold" && !variant) {
              s.fontStyleName = styleNameFromBase(baseStyle || {}, "bold");
              s.syntheticBold = true;
              s.fauxBold = true;
            } else if (desired === "italic" && !variant) {
              s.fontStyleName = styleNameFromBase(baseStyle || {}, "italic");
              s.italics = true;
              s.syntheticItalic = true;
              s.fauxItalic = true;
            }
            return s;
          }

          function buildTextDescriptorFromLayer(layer, text, runs) {
            var baseStyle = baseRangeStyle(layer);
            var textDescriptor = {
              _obj: "textLayer",
              textKey: text,
              textStyleRange: [],
              paragraphStyleRange: [
                {
                  _obj: "paragraphStyleRange",
                  from: 0,
                  to: text.length,
                  paragraphStyle: {
                    _obj: "paragraphStyle",
                    styleSheetHasParent: true
                  }
                }
              ]
            };

            if (!runs || !runs.length) {
              textDescriptor.textStyleRange.push({
                _obj: "textStyleRange",
                from: 0,
                to: text.length,
                textStyle: buildRangeStyle(baseStyle, "plain")
              });
              return textDescriptor;
            }

            var cursor = 0;
            for (var i = 0; i < runs.length; i++) {
              var run = runs[i];
              if (run.from > cursor) {
                textDescriptor.textStyleRange.push({
                  _obj: "textStyleRange",
                  from: cursor,
                  to: run.from,
                  textStyle: buildRangeStyle(baseStyle, "plain")
                });
              }
              textDescriptor.textStyleRange.push({
                _obj: "textStyleRange",
                from: run.from,
                to: run.to,
                textStyle: buildRangeStyle(baseStyle, run.style)
              });
              cursor = Math.max(cursor, run.to);
            }

            if (cursor < text.length) {
              textDescriptor.textStyleRange.push({
                _obj: "textStyleRange",
                from: cursor,
                to: text.length,
                textStyle: buildRangeStyle(baseStyle, "plain")
              });
            }

            return textDescriptor;
          }

          function setTextContents(layer, text) {
            layer.textItem.contents = text;
          }

          function boundsWidth(bounds) {
            return Number(bounds[2]) - Number(bounds[0]);
          }

          function boundsHeight(bounds) {
            return Number(bounds[3]) - Number(bounds[1]);
          }

          function safeRemoveLayer(layer) {
            if (!layer) return;
            try { layer.remove(); } catch (e) {}
          }

          function measureSnippet(layer, snippet) {
            var temp = null;
            try {
              temp = layer.duplicate();
              temp.visible = false;
              temp.textItem.contents = snippet && snippet.length ? snippet : " ";
              var b = temp.bounds;
              return {
                width: boundsWidth(b),
                height: boundsHeight(b)
              };
            } catch (e) {
              say("ERR:measureSnippet:" + e);
              return { width: 0, height: 0 };
            } finally {
              safeRemoveLayer(temp);
            }
          }

          function locateRun(text, run) {
            var lines = String(text).split("\n");
            var cursor = 0;

            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              var lineStart = cursor;
              var lineEnd = cursor + line.length;
              if (run.from >= lineStart && run.to <= lineEnd) {
                return {
                  lineIndex: i,
                  lineText: line,
                  prefix: line.slice(0, run.from - lineStart),
                  runText: text.slice(run.from, run.to)
                };
              }
              cursor = lineEnd + 1;
            }

            return null;
          }

          function heightBeforeLine(layer, fullText, lineIndex) {
            if (lineIndex <= 0) return 0;
            var lines = String(fullText).split("\n");
            var prefixText = lines.slice(0, lineIndex).join("\n");
            return measureSnippet(layer, prefixText).height;
          }

          function applyWholeLayerStyle(layer, baseStyle, desired) {
            var styled = buildRangeStyle(baseStyle, desired);

            try {
              layer.textItem.totalTextStyle = JSON.stringify(styled);
              say("DBG:overlayStyleApplied:" + desired + ":totalTextStyle");
              return true;
            } catch (e1) {
              say("ERR:overlayStyleTotal:" + desired + ":" + e1);
            }

            try {
              if (styled.fontStyleName) layer.textItem.fontStyleName = styled.fontStyleName;
              if (styled.fontName) layer.textItem.fontName = styled.fontName;
              say("DBG:overlayStyleApplied:" + desired + ":directProps");
              return true;
            } catch (e2) {
              say("ERR:overlayStyleDirect:" + desired + ":" + e2);
            }

            return false;
          }

          function createOverlayForRun(rulesLayer, fullText, run, index, baseStyle) {
            var loc = locateRun(fullText, run);
            if (!loc) {
              say("ERR:overlayLocate:" + index);
              return;
            }

            var overlay = null;
            try {
              overlay = rulesLayer.duplicate();
              overlay.name = "Rules Overlay " + index + " " + run.style;
              overlay.visible = true;
              overlay.opacity = 100;
              overlay.textItem.contents = loc.runText;

              applyWholeLayerStyle(overlay, baseStyle, run.style);

              var prefixMetrics = measureSnippet(rulesLayer, loc.prefix);
              var yOffset = heightBeforeLine(rulesLayer, fullText, loc.lineIndex);
              overlay.translate(prefixMetrics.width, yOffset);
              say("DBG:overlayPlaced:" + index + ":" + run.style + ":dx=" + prefixMetrics.width + ":dy=" + yOffset + ":text=" + loc.runText);
            } catch (e) {
              say("ERR:createOverlay:" + index + ":" + e);
              safeRemoveLayer(overlay);
            }
          }

          try {
            var doc = app.activeDocument;
            var layerName = "Rules";
            say("DBG:activeDocumentReady");
            say("DBG:beforeGetByName");
            var rulesLayer = null;
            try {
              rulesLayer = doc.layers.getByName(layerName);
              say("DBG:getByNameReturned");
            } catch (eGetLayer) {
              say("ERR:getByName:" + eGetLayer);
            }
            if (!rulesLayer) {
              say("ERR:nolayer:" + layerName);
              return;
            }
            if (!rulesLayer.textItem) {
              say("ERR:nottext:" + layerName);
              return;
            }

            doc.activeLayer = rulesLayer;
            say("DBG:rulesLayerFound");

            setTextContents(rulesLayer, payload.text);
            say("DBG:plainTextApplied");

            if (!payload.styled) {
              doc.saveToOE("psd:true");
              say("SAVE:plain");
              return;
            }

            var base = baseRangeStyle(rulesLayer);
            say("DBG:baseFamilyKey:" + familyKeyFromBase(base));
            say("DBG:totalTextStyle:" + JSON.stringify(base));
            say("DBG:runs:" + JSON.stringify(payload.runs));
            say("DBG:overlayStrategy:start");
            for (var i = 0; i < payload.runs.length; i++) {
              createOverlayForRun(rulesLayer, payload.text, payload.runs[i], i, base);
            }

            doc.saveToOE("psd:true");
            say("SAVE:styled");
          } catch (e) {
            say("ERR:exception:" + e);
          }
        })();
      `;
    }

    function buildPrepareScript(payload) {
      const dataLiteral = JSON.stringify(payload);
      return `
        (function () {
          var payload = ${dataLiteral};
          function say(msg) {
            try { app.echoToOE(msg); } catch (e) {}
          }
          function normalizeKey(value) {
            return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          }
          function familyKeyFromBase(base) {
            var candidates = [
              base && base.fontFamily,
              base && base.fontName,
              base && base.fontPostScriptName
            ];
            for (var i = 0; i < candidates.length; i++) {
              var norm = normalizeKey(candidates[i]);
              if (!norm) continue;
              for (var key in payload.fontFamilies) {
                if (norm.indexOf(key) !== -1 || key.indexOf(norm) !== -1) {
                  return key;
                }
              }
            }
            return null;
          }
          function variantFor(desired) {
            var familyKey = payload.rulesFamilyKey || null;
            var family = familyKey ? payload.fontFamilies[familyKey] : null;
            if (!family && payload.fontFamilies) {
              var keys = Object.keys(payload.fontFamilies);
              if (keys.length) family = payload.fontFamilies[keys[0]];
            }
            if (!family) return null;
            return family[desired] || family.plain || null;
          }
          function applyVariant(layer, desired) {
            var variant = variantFor(desired);
            if (!variant) {
              say("ERR:prepare:noVariant:" + desired);
              return false;
            }
            try {
              if (variant.postScriptName) layer.textItem.fontName = variant.postScriptName;
              if (variant.family) layer.textItem.fontFamily = variant.family;
              if (variant.styleName) layer.textItem.fontStyleName = variant.styleName;
              return true;
            } catch (e) {
              say("ERR:prepare:applyVariant:" + desired + ":" + e);
              return false;
            }
          }
          try {
            say("DBG:prepare:start");
            var doc = app.activeDocument;
            if (!doc) {
              say("ERR:prepare:noActiveDocument");
              return;
            }
            var rulesLayer = doc.layers.getByName("Rules");
            if (!rulesLayer) {
              say("ERR:prepare:nolayer");
              return;
            }
            if (!rulesLayer.textItem) {
              say("ERR:prepare:nottext");
              return;
            }
            doc.activeLayer = rulesLayer;
            rulesLayer.textItem.contents = payload.text;
            applyVariant(rulesLayer, "plain");
            var base = {};
            try {
              base = JSON.parse(rulesLayer.textItem.totalTextStyle || "{}");
            } catch (eStyle) {}
            say("DBG:prepare:rulesFamilyKey:" + payload.rulesFamilyKey);
            say("DBG:prepare:baseFamilyKey:" + familyKeyFromBase(base));
            say("STEP:prepare:ok");
          } catch (e) {
            say("ERR:prepare:" + e);
          }
        })();
      `;
    }

    function buildOverlayRunScript(payload, run, index) {
      const dataLiteral = JSON.stringify({
        text: payload.text,
        run,
        index,
        fontFamilies: payload.fontFamilies || {},
        rulesFamilyKey: payload.rulesFamilyKey || null
      });
      return `
        (function () {
          var payload = ${dataLiteral};
          function say(msg) {
            try { app.echoToOE(msg); } catch (e) {}
          }
          function variantFor(desired) {
            var familyKey = payload.rulesFamilyKey || null;
            var family = familyKey ? payload.fontFamilies[familyKey] : null;
            if (!family && payload.fontFamilies) {
              var keys = Object.keys(payload.fontFamilies);
              if (keys.length) family = payload.fontFamilies[keys[0]];
            }
            if (!family) return null;
            return family[desired] || family.plain || null;
          }
          function applyVariant(layer, desired) {
            var variant = variantFor(desired);
            try {
              if (!variant) {
                say("ERR:overlay:noVariant:" + payload.index + ":" + desired);
                return;
              }
              if (variant.postScriptName) layer.textItem.fontName = variant.postScriptName;
              if (variant.family) layer.textItem.fontFamily = variant.family;
              if (variant.styleName) {
                layer.textItem.fontStyleName = variant.styleName;
              }
              say("DBG:overlayStyleApplied:" + payload.index + ":" + desired);
            } catch (e) {
              say("ERR:overlayStyle:" + payload.index + ":" + e);
            }
          }
          function makeOverlayText(fullText, run) {
            var chars = String(fullText).split("");
            for (var i = 0; i < chars.length; i++) {
              var keep = i >= run.from && i < run.to;
              if (!keep && chars[i] !== "\\n") {
                chars[i] = " ";
              }
            }
            return chars.join("");
          }
          try {
            say("DBG:overlay:start:" + payload.index);
            var doc = app.activeDocument;
            if (!doc) {
              say("ERR:overlay:noActiveDocument:" + payload.index);
              return;
            }
            var rulesLayer = doc.layers.getByName("Rules");
            if (!rulesLayer || !rulesLayer.textItem) {
              say("ERR:overlay:nolayer:" + payload.index);
              return;
            }
            var overlay = rulesLayer.duplicate();
            overlay.name = "Rules Overlay " + payload.index + " " + payload.run.style;
            overlay.visible = true;
            overlay.opacity = 100;
            overlay.textItem.contents = makeOverlayText(payload.text, payload.run);
            applyVariant(overlay, payload.run.style);
            say("DBG:overlay:layoutPreserved:" + payload.index + ":from=" + payload.run.from + ":to=" + payload.run.to);
            say("STEP:overlay:ok:" + payload.index);
          } catch (e) {
            say("ERR:overlay:" + payload.index + ":" + e);
          }
        })();
      `;
    }

    function buildSaveScript(label) {
      const safeLabel = String(label || "styled");
      return `
        (function () {
          function say(msg) {
            try { app.echoToOE(msg); } catch (e) {}
          }
          try {
            var doc = app.activeDocument;
            if (!doc) {
              say("ERR:save:noActiveDocument");
              return;
            }
            say("STEP:save:start:${safeLabel}");
            doc.saveToOE("psd:true");
            say("SAVE:${safeLabel}");
          } catch (e) {
            say("ERR:save:" + e);
          }
        })();
      `;
    }

    async function uploadPsd(filename, arrayBuffer) {
      const res = await fetch("/save?filename=" + encodeURIComponent(sanitizeFilename(filename)), {
        method: "POST",
        body: arrayBuffer
      });
      if (!res.ok) throw new Error("Save failed: " + res.status);
    }

    async function run(styled) {
      if (busy) {
        log("Run already in progress. Wait for the current pass to finish.");
        setStatus("Run already in progress...");
        return;
      }

      try {
        await fetch("/client_log/reset", { method: "POST", cache: "no-store" });
      } catch (e) {}
      log("Client build: " + APP_BUILD);
      log("=== New run started ===");

      const manifest = await ensureFontManifest();

      const parsed = computeStyleRuns(rulesTextEl.value);
      log("Prepared " + parsed.runs.length + " styled run(s).");
      log("Runs: " + JSON.stringify(parsed.runs));

      const payload = {
        text: parsed.text,
        runs: parsed.runs,
        styled: styled,
        fontFamilies: (manifest && manifest.families) || {},
        rulesFamilyKey: chooseRulesFamilyKey((manifest && manifest.families) || {})
      };

      await ensurePhotopeaReady();
      if (!ppWindow || ppWindow.closed) {
        ppWindow = iframe.contentWindow;
      }
      const template = await loadTemplate();

      busy = true;
      mode = styled ? "styled" : "plain";
      pendingSaveLabel = mode;
      currentJob = {
        payload,
        styled,
        prepared: false,
        nextOverlayIndex: 0,
        awaitingStep: ""
      };
      currentStage = "posting-template-buffer";
      clearWatchdogs();
      log("Execution strategy: stepwise-overlay-job");
      log("Posting template buffer into existing Photopea session...");
      setStatus("Opening template...");
      ppWindow.postMessage(template, "*");
      scheduleWatchdogs();
    }

    window.addEventListener("message", async (e) => {
      if (!ppWindow && e.source === iframe.contentWindow) {
        ppWindow = e.source;
      }
      if (e.source !== iframe.contentWindow) return;

      const dataKind =
        e.data instanceof ArrayBuffer ? "arraybuffer" :
        typeof e.data;
      void mirrorLog("message", "Received iframe message", {
        origin: e.origin || "",
        dataKind,
        dataPreview: dataKind === "string" ? String(e.data).slice(0, 300) : null,
        byteLength: e.data instanceof ArrayBuffer ? e.data.byteLength : null,
        stage: currentStage,
        busy
      });

      if (e.data === "done") {
        if (!ppReady) {
          ppReady = true;
          log("Photopea ready.");
          setStatus("Photopea ready.");
          resolveReadyWaiters();
          return;
        }

        if (busy && currentStage === "posting-template-buffer" && currentJob) {
          currentStage = "awaiting-script-dispatch";
          dispatchJobStep("template buffer opened");
        } else if (busy && currentStage === "awaiting-script-dispatch" && currentJob) {
          dispatchJobStep("done");
        }
        return;
      }

      if (e.data instanceof ArrayBuffer) {
        try {
          const outName = "rules_style_poc_" + pendingSaveLabel + ".psd";
          await uploadPsd(outName, e.data);
          log("Saved " + outName);
          setStatus("Saved " + outName);
        } catch (err) {
          log("ERR:save:" + err);
          setStatus("Save failed");
        } finally {
          clearWatchdogs();
          busy = false;
          currentStage = "idle";
          currentJob = null;
        }
        return;
      }

      if (typeof e.data === "string") {
        log("From Photopea: " + e.data);
        if (e.data.startsWith("ERR:")) {
          clearWatchdogs();
          setStatus("Photopea reported an error");
          busy = false;
          currentStage = "idle";
          currentJob = null;
        } else if (e.data === "STEP:prepare:ok") {
          currentStage = "awaiting-script-dispatch";
          dispatchJobStep("prepare complete");
        } else if (e.data.startsWith("STEP:overlay:ok:")) {
          const idx = Number(e.data.split(":").pop());
          if (currentJob && Number.isFinite(idx)) {
            currentJob.nextOverlayIndex = Math.max(currentJob.nextOverlayIndex, idx + 1);
          }
          currentStage = "awaiting-script-dispatch";
          dispatchJobStep("overlay complete");
        } else if (e.data.startsWith("STEP:save:start:")) {
          pendingSaveLabel = e.data.slice("STEP:save:start:".length) || pendingSaveLabel;
          setStatus("Waiting for PSD buffer...");
        } else if (e.data.startsWith("SAVE:")) {
          setStatus("Waiting for PSD buffer...");
        }
        return;
      }

      log("Unknown message type from Photopea.");
    });

    iframe.addEventListener("load", () => {
      void mirrorLog("iframe", "Iframe load event", {
        src: getFrameSrcAttr(),
        stage: currentStage,
        busy
      });
      if (hasPhotopeaTarget() && !ppReady) {
        log("Photopea iframe loaded. Waiting for ready signal...");
        setStatus("Waiting for Photopea...");
      }
    });

    iframe.addEventListener("error", () => {
      log("ERR:iframe:load");
      setStatus("Iframe load failed");
    });

    window.addEventListener("error", (event) => {
      log("ERR:window:" + (event.message || "unknown"));
      void mirrorLog("window-error", "Unhandled window error", {
        message: event.message || "",
        filename: event.filename || "",
        lineno: event.lineno || null,
        colno: event.colno || null
      });
    });

    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason && event.reason.stack ? event.reason.stack : String(event.reason);
      log("ERR:promise:" + reason);
      void mirrorLog("promise-error", "Unhandled promise rejection", {
        reason
      });
    });

    document.getElementById("btnOpen").addEventListener("click", async () => {
      try {
        await openPhotopea(hasPhotopeaTarget() && !ppReady);
      } catch (err) {
        log("ERR:openPhotopea:" + err);
        setStatus("Photopea load failed");
      }
    });

    document.getElementById("btnRun").addEventListener("click", async () => {
      try {
        await run(true);
      } catch (err) {
        log("ERR:runStyled:" + err);
        setStatus("Run failed");
        clearWatchdogs();
        busy = false;
        currentStage = "idle";
      }
    });

    document.getElementById("btnPlain").addEventListener("click", async () => {
      try {
        await run(false);
      } catch (err) {
        log("ERR:runPlain:" + err);
        setStatus("Run failed");
        clearWatchdogs();
        busy = false;
        currentStage = "idle";
      }
    });
  </script>
</body>
</html>
"""


@app.route("/")
def index():
    append_debug_log("server", "GET /")
    html = INDEX_HTML.replace("__APP_BUILD__", APP_BUILD)
    return disable_cache(Response(html, mimetype="text/html"))


@app.route("/font_manifest.json")
def font_manifest():
    manifest = available_font_entries(request.host_url)
    append_debug_log(
        "server",
        f"GET /font_manifest.json -> {len(manifest['items'])} font(s)"
    )
    return disable_cache(jsonify(manifest))


@app.route("/client_log", methods=["POST"])
def client_log():
    payload = request.get_json(silent=True) or {}
    source = summarize_text(payload.get("source", "client"), 80)
    message = summarize_text(payload.get("message", ""), 1000)
    extra = payload.get("extra")

    if extra is not None:
        try:
            extra_text = summarize_text(json.dumps(extra, ensure_ascii=True), 1200)
            append_debug_log(source, f"{message} | extra={extra_text}")
        except Exception:
            append_debug_log(source, f"{message} | extra=<unserializable>")
    else:
        append_debug_log(source, message)

    return jsonify({"ok": True})


@app.route("/client_log/reset", methods=["POST"])
def client_log_reset():
    ensure_dir(OUTPUT_DIR)
    DEBUG_LOG.write_text("", encoding="utf-8")
    append_debug_log("server", f"Log reset | build={APP_BUILD}")
    return disable_cache(jsonify({"ok": True, "path": str(DEBUG_LOG), "build": APP_BUILD}))


@app.route("/font/<int:index>")
def font_asset(index: int):
    if index < 0 or index >= len(FONT_SPECS):
        return "Font not found", 404

    spec = FONT_SPECS[index]
    path = FONTS_DIR / spec["filename"]
    if not path.exists():
        return f"Font file not found: {path}", 404

    resp = send_file(path)
    resp = disable_cache(resp)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    append_debug_log("server", f"GET /font/{index} -> {path.name}")
    return resp


@app.route("/template.psd")
def template_psd():
    if not TEMPLATE_PSD.exists():
        append_debug_log("server", f"GET /template.psd -> missing {TEMPLATE_PSD}")
        return f"Template not found: {TEMPLATE_PSD}", 404
    resp = send_file(TEMPLATE_PSD, mimetype="application/octet-stream")
    resp = disable_cache(resp)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    append_debug_log("server", f"GET /template.psd -> {TEMPLATE_PSD.name} ({TEMPLATE_PSD.stat().st_size} bytes)")
    return resp


@app.route("/save", methods=["POST"])
def save():
    ensure_dir(OUTPUT_DIR)
    filename = request.args.get("filename", "rules_style_poc.psd")
    safe = SAFE_NAME_RE.sub("_", filename)
    out_path = OUTPUT_DIR / safe
    out_path.write_bytes(request.data)
    append_debug_log("server", f"POST /save -> {safe} ({len(request.data)} bytes)")
    return jsonify({"ok": True, "path": str(out_path)})


if __name__ == "__main__":
    ensure_dir(OUTPUT_DIR)
    available_fonts = [spec["filename"] for spec in FONT_SPECS if (FONTS_DIR / spec["filename"]).exists()]
    append_debug_log("server", "Server starting")
    print(f"Serving on http://127.0.0.1:{PORT}")
    print(f"Build   : {APP_BUILD}")
    print(f"Template: {TEMPLATE_PSD}")
    print(f"Output  : {OUTPUT_DIR}")
    print(f"Fonts   : {FONTS_DIR} ({len(available_fonts)} found)")
    print(f"Debug   : {DEBUG_LOG}")
    app.run("127.0.0.1", PORT, debug=True)
