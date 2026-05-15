const { core, event, http, menu, mpv, overlay, preferences, console } = iina;

let enabled = readBool("enabled", true);
let lastSubtitle = "";
let lastRequestId = 0;
let inFlight = false;
let queuedText = null;
let lastRequestAt = 0;
const cache = {};

function pref(key, fallback) {
  const value = preferences.get(key);
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

function readBool(key, fallback) {
  const value = preferences.get(key);
  if (value === undefined || value === null) return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function readNumber(key, fallback) {
  const value = Number(preferences.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeSubtitle(text) {
  return String(text || "")
    .replace(/\{\\[^}]+\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function setupOverlay() {
  overlay.simpleMode();
  overlay.setStyle(`
    #rst-root {
      position: fixed;
      left: 50%;
      bottom: ${readNumber("bottomOffset", 9)}vh;
      transform: translateX(-50%);
      width: min(${readNumber("maxWidth", 82)}vw, 1180px);
      color: white;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
      font-size: ${readNumber("fontSize", 28)}px;
      line-height: 1.32;
      text-align: center;
      text-shadow: 0 2px 4px rgba(0,0,0,.95), 0 0 12px rgba(0,0,0,.85);
      pointer-events: none;
    }
    .rst-original {
      margin-bottom: 7px;
      font-size: .78em;
      opacity: .86;
    }
    .rst-translation {
      font-weight: 700;
    }
    .rst-status {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 8px;
      background: rgba(0,0,0,.42);
      font-size: .72em;
      font-weight: 600;
      opacity: .78;
    }
  `);
  overlay.setContent('<div id="rst-root"></div>');
  overlay.show();
}

function render(original, translation, status) {
  if (!enabled) {
    overlay.hide();
    return;
  }

  const showOriginal = readBool("showOriginal", true);
  let html = '<div id="rst-root">';
  if (status) {
    html += '<div class="rst-status">' + escapeHtml(status) + "</div>";
  } else {
    if (showOriginal && original) {
      html += '<div class="rst-original">' + escapeHtml(original) + "</div>";
    }
    if (translation) {
      html += '<div class="rst-translation">' + escapeHtml(translation) + "</div>";
    }
  }
  html += "</div>";
  overlay.setContent(html);
  overlay.show();
}

function clearOverlay() {
  overlay.setContent('<div id="rst-root"></div>');
}

function setEnabled(next) {
  enabled = next;
  preferences.set("enabled", next);
  preferences.sync();
  if (enabled) {
    setupOverlay();
    core.osd("Realtime subtitle translation: on");
    handleSubtitleChange();
  } else {
    overlay.hide();
    core.osd("Realtime subtitle translation: off");
  }
}

function buildPrompt(text) {
  const target = pref("targetLanguage", "Simplified Chinese");
  const source = pref("sourceLanguage", "auto");
  const sourceHint = source === "auto" ? "Detect the source language." : "The source language is " + source + ".";
  return [
    "Translate the subtitle into " + target + ".",
    sourceHint,
    "Keep names, tone, punctuation, and line-break-friendly brevity.",
    "Return only the translated subtitle text, with no explanations.",
    "",
    text
  ].join("\n");
}

function extractTranslation(response) {
  const data = response.data || JSON.parse(response.text || "{}");
  if (data && data.choices && data.choices.length) {
    const choice = data.choices[0];
    if (choice.message && choice.message.content) return String(choice.message.content).trim();
    if (choice.text) return String(choice.text).trim();
  }
  if (data && data.translation) return String(data.translation).trim();
  if (data && data.translatedText) return String(data.translatedText).trim();
  throw new Error("Unexpected translation response");
}

async function translate(text, requestId) {
  const apiBaseUrl = pref("apiBaseUrl", "");
  const apiKey = pref("apiKey", "");
  const model = pref("model", "");

  if (!apiBaseUrl || !apiKey || !model) {
    render(text, "", "Set API URL, key, and model in plugin preferences");
    return;
  }

  const body = {
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "You are a subtitle translation engine. Return only the translated subtitle text."
      },
      {
        role: "user",
        content: buildPrompt(text)
      }
    ]
  };

  const response = await http.post(apiBaseUrl, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    params: {},
    data: body
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("HTTP " + response.statusCode + " " + response.reason);
  }

  const translated = extractTranslation(response);
  cache[text] = translated;
  if (requestId === lastRequestId && enabled) {
    render(text, translated, "");
  }
}

function scheduleTranslation(text) {
  if (cache[text]) {
    render(text, cache[text], "");
    return;
  }

  queuedText = text;
  pumpQueue();
}

function pumpQueue() {
  if (inFlight || !queuedText || !enabled) return;

  const minIntervalMs = Math.max(0, readNumber("minIntervalMs", 750));
  const now = Date.now();
  const wait = Math.max(0, minIntervalMs - (now - lastRequestAt));
  if (wait > 0) {
    setTimeout(pumpQueue, wait);
    return;
  }

  const text = queuedText;
  queuedText = null;
  inFlight = true;
  lastRequestAt = Date.now();
  const requestId = ++lastRequestId;
  render(text, "", "Translating...");

  translate(text, requestId)
    .catch((err) => {
      console.error("[Realtime Subtitle Translator] " + err.message);
      if (requestId === lastRequestId) render(text, "", "Translation failed");
    })
    .finally(() => {
      inFlight = false;
      if (queuedText) pumpQueue();
    });
}

function handleSubtitleChange() {
  if (!enabled) return;
  const text = normalizeSubtitle(mpv.getString("sub-text"));
  if (!text) {
    lastSubtitle = "";
    clearOverlay();
    return;
  }
  if (text === lastSubtitle) return;
  lastSubtitle = text;
  scheduleTranslation(text);
}

menu.addItem(menu.item("Toggle Realtime Subtitle Translation", () => {
  setEnabled(!enabled);
}, { keyBinding: "Ctrl+Alt+t" }));

menu.addItem(menu.item("Refresh Translation Overlay", () => {
  setupOverlay();
  lastSubtitle = "";
  handleSubtitleChange();
}));

event.on("iina.window-loaded", () => {
  setupOverlay();
  if (!enabled) overlay.hide();
});

event.on("iina.file-loaded", () => {
  lastSubtitle = "";
  queuedText = null;
  clearOverlay();
});

event.on("mpv.sub-text.changed", handleSubtitleChange);
event.on("mpv.sid.changed", () => {
  lastSubtitle = "";
  handleSubtitleChange();
});

if (core.window.loaded) {
  setupOverlay();
  if (!enabled) overlay.hide();
}
