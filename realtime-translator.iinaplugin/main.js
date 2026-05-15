const { core, event, file, http, menu, mpv, overlay, preferences, utils, console } = iina;

let enabled = readBool("enabled", true);
let timer = null;
let processing = false;
let lastSegmentEnd = null;
let lastRequestId = 0;
const translationCache = {};
const ffmpegCandidates = [
  "ffmpeg",
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg"
];
const curlCandidates = [
  "curl",
  "/usr/bin/curl",
  "/opt/homebrew/bin/curl",
  "/usr/local/bin/curl"
];

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

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
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
      font-size: .72em;
      opacity: .84;
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
      opacity: .8;
    }
  `);
  overlay.setContent('<div id="rst-root"></div>');
  overlay.show();
}

function render(transcript, translation, status) {
  if (!enabled) {
    overlay.hide();
    return;
  }

  const showOriginal = readBool("showTranscript", true);
  let html = '<div id="rst-root">';
  if (status) {
    html += '<div class="rst-status">' + escapeHtml(status) + "</div>";
  } else {
    if (showOriginal && transcript) {
      html += '<div class="rst-original">' + escapeHtml(transcript) + "</div>";
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

function currentTime() {
  const time = mpv.getNumber("time-pos");
  return Number.isFinite(time) ? time : 0;
}

function firstAvailableBinary(configKey, candidates) {
  const configured = pref(configKey, "");
  if (configured && utils.fileInPath(configured)) return configured;
  for (const candidate of candidates) {
    if (utils.fileInPath(candidate)) return candidate;
  }
  return "";
}

function ffmpegBinary() {
  return firstAvailableBinary("ffmpegPath", ffmpegCandidates);
}

function curlBinary() {
  return firstAvailableBinary("curlPath", curlCandidates);
}

function mediaPath() {
  return mpv.getString("path") || mpv.getString("stream-open-filename") || "";
}

function workingDirectory() {
  const cwd = mpv.getString("working-directory");
  return cwd || undefined;
}

function resetTimeline() {
  const now = currentTime();
  lastSegmentEnd = Math.max(0, now - readNumber("chunkSeconds", 4));
}

function setEnabled(next) {
  enabled = next;
  preferences.set("enabled", next);
  preferences.sync();
  if (enabled) {
    setupOverlay();
    startCapture();
    core.osd("Realtime speech translation: on");
  } else {
    stopCapture();
    overlay.hide();
    core.osd("Realtime speech translation: off");
  }
}

function startCapture() {
  if (timer) clearInterval(timer);
  resetTimeline();
  timer = setInterval(captureTick, Math.max(500, readNumber("pollIntervalMs", 1500)));
  captureTick();
}

function stopCapture() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  processing = false;
}

function canCapture() {
  if (!ffmpegBinary()) {
    render("", "", "Install ffmpeg first, or set its path in preferences");
    return false;
  }
  if (!curlBinary()) {
    render("", "", "curl is required, or set its path in preferences");
    return false;
  }
  if (!mediaPath()) {
    render("", "", "Open a media file first");
    return false;
  }
  return true;
}

function tempAudioName() {
  return "rst-speech-" + Date.now() + "-" + Math.floor(Math.random() * 100000) + ".m4a";
}

async function extractAudioSegment(start, duration) {
  const tmpName = tempAudioName();
  const tmpPseudoPath = "@tmp/" + tmpName;
  const tmpPath = utils.resolvePath(tmpPseudoPath);
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-ss", String(Math.max(0, start)),
    "-t", String(Math.max(0.5, duration)),
    "-i", mediaPath(),
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "48k",
    "-y",
    tmpPath
  ];

  const result = await utils.exec(ffmpegBinary(), args, workingDirectory());
  if (result.status !== 0) {
    throw new Error("ffmpeg failed: " + cleanText(result.stderr || result.stdout));
  }
  return { path: tmpPath, pseudoPath: tmpPseudoPath };
}

function transcriptionArgs(audioPath) {
  const args = [
    "-sS",
    pref("transcriptionUrl", "https://api.openai.com/v1/audio/transcriptions"),
    "-H", "Authorization: Bearer " + pref("apiKey", ""),
    "-F", "file=@" + audioPath,
    "-F", "model=" + pref("transcriptionModel", "gpt-4o-mini-transcribe"),
    "-F", "response_format=json"
  ];

  const language = pref("sourceLanguage", "auto");
  if (language && language !== "auto") {
    args.push("-F", "language=" + language);
  }

  const prompt = pref("transcriptionPrompt", "");
  if (prompt) {
    args.push("-F", "prompt=" + prompt);
  }

  return args;
}

async function transcribeAudio(audioPath) {
  const apiKey = pref("apiKey", "");
  if (!apiKey) {
    render("", "", "Set API key in plugin preferences");
    return "";
  }

  const result = await utils.exec(curlBinary(), transcriptionArgs(audioPath));
  if (result.status !== 0) {
    throw new Error("transcription request failed: " + cleanText(result.stderr || result.stdout));
  }

  const stdout = cleanText(result.stdout);
  if (!stdout) return "";

  try {
    const data = JSON.parse(stdout);
    if (data.error && data.error.message) {
      throw new Error(data.error.message);
    }
    return cleanText(data.text || data.transcript || data.translation || "");
  } catch (err) {
    if (stdout[0] === "{" || stdout[0] === "[") throw err;
    return stdout;
  }
}

function buildTranslationPrompt(text) {
  const target = pref("targetLanguage", "Simplified Chinese");
  const source = pref("sourceLanguage", "auto");
  const sourceHint = source === "auto" ? "Detect the source language." : "The source language is " + source + ".";
  return [
    "Translate this spoken transcript into " + target + ".",
    sourceHint,
    "Keep names, tone, punctuation, and subtitle-friendly brevity.",
    "Return only the translated text, with no explanations.",
    "",
    text
  ].join("\n");
}

function extractTranslation(response) {
  const data = response.data || JSON.parse(response.text || "{}");
  if (data && data.choices && data.choices.length) {
    const choice = data.choices[0];
    if (choice.message && choice.message.content) return cleanText(choice.message.content);
    if (choice.text) return cleanText(choice.text);
  }
  if (data && data.translation) return cleanText(data.translation);
  if (data && data.translatedText) return cleanText(data.translatedText);
  throw new Error("Unexpected translation response");
}

async function translateTranscript(text) {
  if (translationCache[text]) return translationCache[text];

  const apiKey = pref("apiKey", "");
  const chatUrl = pref("chatUrl", "https://api.openai.com/v1/chat/completions");
  const chatModel = pref("chatModel", "gpt-4o-mini");

  if (!apiKey || !chatUrl || !chatModel) {
    render(text, "", "Set chat URL, API key, and model in preferences");
    return "";
  }

  const response = await http.post(chatUrl, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    params: {},
    data: {
      model: chatModel,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You translate spoken transcripts into concise subtitles. Return only the translation."
        },
        {
          role: "user",
          content: buildTranslationPrompt(text)
        }
      ]
    }
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("translation HTTP " + response.statusCode + " " + response.reason);
  }

  const translated = extractTranslation(response);
  translationCache[text] = translated;
  return translated;
}

async function processSegment(start, duration, requestId) {
  let temp = null;
  try {
    temp = await extractAudioSegment(start, duration);
    const transcript = await transcribeAudio(temp.path);
    if (!transcript || requestId !== lastRequestId || !enabled) return;

    render(transcript, "", "Translating speech...");
    const translated = await translateTranscript(transcript);
    if (requestId === lastRequestId && enabled) {
      render(transcript, translated, "");
    }
  } finally {
    if (temp && temp.pseudoPath) {
      try {
        file.delete(temp.pseudoPath);
      } catch (err) {
        console.warn("[Realtime Speech Translator] temp cleanup failed: " + err.message);
      }
    }
  }
}

function captureTick() {
  if (!enabled || processing) return;
  if (mpv.getFlag("pause")) return;
  if (!canCapture()) return;

  const now = currentTime();
  const chunkSeconds = Math.max(2, readNumber("chunkSeconds", 4));
  const maxCatchup = Math.max(chunkSeconds, readNumber("maxCatchupSeconds", 8));

  if (lastSegmentEnd === null || now < lastSegmentEnd || now - lastSegmentEnd > maxCatchup) {
    lastSegmentEnd = Math.max(0, now - chunkSeconds);
  }

  const duration = now - lastSegmentEnd;
  if (duration < Math.max(1.5, chunkSeconds * 0.75)) return;

  const start = lastSegmentEnd;
  lastSegmentEnd = now;
  processing = true;
  const requestId = ++lastRequestId;
  render("", "", "Listening...");

  processSegment(start, duration, requestId)
    .catch((err) => {
      console.error("[Realtime Speech Translator] " + err.message);
      if (enabled) render("", "", err.message || "Speech translation failed");
    })
    .finally(() => {
      processing = false;
    });
}

menu.addItem(menu.item("Toggle Realtime Speech Translation", () => {
  setEnabled(!enabled);
}, { keyBinding: "Ctrl+Alt+t" }));

menu.addItem(menu.item("Restart Realtime Speech Translation", () => {
  setupOverlay();
  resetTimeline();
  captureTick();
}));

event.on("iina.window-loaded", () => {
  setupOverlay();
  if (enabled) startCapture();
  if (!enabled) overlay.hide();
});

event.on("iina.file-loaded", () => {
  clearOverlay();
  resetTimeline();
  if (enabled) startCapture();
});

event.on("mpv.seek", () => {
  resetTimeline();
  clearOverlay();
});

if (core.window.loaded) {
  setupOverlay();
  if (enabled) startCapture();
  if (!enabled) overlay.hide();
}
