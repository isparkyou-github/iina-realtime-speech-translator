const { core, event, file, http, menu, mpv, overlay, preferences, utils, console } = iina;

let enabled = readBool("enabled", true);
let timer = null;
let processing = false;
let lastSegmentEnd = null;
let lastRequestId = 0;
let apiBackoffUntil = 0;
let helperStartInFlight = false;
let helperPollInFlight = false;
let helperSessionKey = "";
let lastHelperSeq = 0;
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

function useLocalHelper() {
  return pref("asrBackend", "local-helper") === "local-helper";
}

function helperBaseUrl() {
  return String(pref("helperUrl", "http://127.0.0.1:8765")).replace(/\/+$/, "");
}

function helperPort() {
  const match = helperBaseUrl().match(/:(\d+)(?:\/|$)/);
  return match ? match[1] : "8765";
}

function jsonData(response) {
  if (response && response.data) return response.data;
  return JSON.parse((response && response.text) || "{}");
}

function migrateLatencyDefaults() {
  if (readBool("latencyDefaultsMigrated", false)) return;

  if (readNumber("chunkSeconds", 4) === 4) preferences.set("chunkSeconds", 2);
  if (readNumber("pollIntervalMs", 1500) === 1500) preferences.set("pollIntervalMs", 650);
  if (readNumber("maxCatchupSeconds", 8) === 8) preferences.set("maxCatchupSeconds", 4);

  preferences.set("latencyDefaultsMigrated", true);
  preferences.sync();
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

function shortText(text, maxLength) {
  const cleaned = cleanText(text);
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength - 1).trim() + "...";
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function apiErrorMessage(error) {
  const message = cleanText(
    (error && error.message) ||
    (error && error.error && error.error.message) ||
    error
  );
  const code = cleanText(error && (error.code || error.type || error.param));
  const lower = (message + " " + code).toLowerCase();

  if (lower.includes("quota") || lower.includes("billing") || lower.includes("insufficient_quota")) {
    apiBackoffUntil = Date.now() + 5 * 60 * 1000;
    return "OpenAI quota exceeded. Check billing or use another API key.";
  }
  if (lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("429")) {
    apiBackoffUntil = Date.now() + 30 * 1000;
    return "API rate limited. Waiting before retrying.";
  }
  if (lower.includes("api key") || lower.includes("unauthorized") || lower.includes("invalid_api_key") || lower.includes("401")) {
    apiBackoffUntil = Date.now() + 5 * 60 * 1000;
    return "API key invalid or missing. Check plugin preferences.";
  }
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("does not exist"))) {
    return "Model not available. Check transcription and chat model settings.";
  }
  return shortText(message || "Speech translation failed", 120);
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
      max-width: min(76vw, 980px);
      padding: 4px 10px;
      border-radius: 8px;
      background: rgba(0,0,0,.42);
      font-size: .72em;
      font-weight: 600;
      opacity: .8;
      white-space: normal;
      overflow-wrap: anywhere;
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

async function startLocalHelperProcess() {
  const scriptPath = pref("helperScriptPath", "");
  if (!scriptPath) return false;

  const pythonPath = pref("helperPythonPath", "python3");
  const logPath = "/tmp/iina-realtime-speech-helper.log";
  const command = [
    "nohup",
    shellQuote(pythonPath),
    shellQuote(scriptPath),
    "--host",
    "127.0.0.1",
    "--port",
    helperPort(),
    ">",
    shellQuote(logPath),
    "2>&1",
    "&"
  ].join(" ");
  const result = await utils.exec("/bin/sh", ["-lc", command]);
  return result.status === 0;
}

async function helperGet(path) {
  const response = await http.get(helperBaseUrl() + path, { headers: { "Cache-Control": "no-cache" } });
  return jsonData(response);
}

async function helperPost(path, body) {
  const response = await http.post(helperBaseUrl() + path, {
    headers: { "Content-Type": "application/json" },
    data: body
  });
  return jsonData(response);
}

async function ensureLocalHelperSession(force) {
  if (helperStartInFlight) return false;
  const media = mediaPath();
  if (!media) return false;

  const sessionKey = [
    media,
    Math.floor(currentTime()),
    pref("localAsrEngine", "faster-whisper"),
    pref("localAsrModel", "base"),
    pref("whisperCppModelPath", ""),
    pref("sourceLanguage", "auto")
  ].join("|");

  if (!force && sessionKey === helperSessionKey) return true;

  helperStartInFlight = true;
  try {
    try {
      await helperGet("/health");
    } catch (err) {
      const started = await startLocalHelperProcess();
      if (!started) {
        render("", "", "Start local ASR helper or set helperScriptPath in preferences.");
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }

    const result = await helperPost("/start", {
      media_path: media,
      start_time: currentTime(),
      ffmpeg_path: ffmpegBinary() || "ffmpeg",
      engine: pref("localAsrEngine", "faster-whisper"),
      model: pref("localAsrModel", "base"),
      device: pref("localAsrDevice", "auto"),
      compute_type: pref("localAsrComputeType", "auto"),
      whisper_cpp_path: pref("whisperCppPath", "whisper-cli"),
      whisper_cpp_model_path: pref("whisperCppModelPath", ""),
      whisper_cpp_threads: readNumber("whisperCppThreads", 0),
      language: pref("sourceLanguage", "auto"),
      window_seconds: readNumber("localAsrWindowSeconds", 2),
      stride_seconds: readNumber("localAsrStrideSeconds", 0.7),
      min_chars: readNumber("localAsrMinChars", 4),
      min_words: readNumber("localAsrMinWords", 2),
      dedupe_ratio: readNumber("localAsrDedupeRatio", 0.86),
      emit_cooldown_seconds: readNumber("localAsrEmitCooldownMs", 700) / 1000
    });

    if (result && result.ok) {
      helperSessionKey = sessionKey;
      lastHelperSeq = 0;
      return true;
    }
    render("", "", shortText((result && result.error) || "Could not start local ASR helper", 120));
    return false;
  } catch (err) {
    render("", "", "Local ASR helper unavailable. Start helper or check preferences.");
    console.error("[Realtime Speech Translator] helper start failed: " + cleanText(err && err.message));
    return false;
  } finally {
    helperStartInFlight = false;
  }
}

function startLocalHelperCapture(force) {
  ensureLocalHelperSession(force).then((ok) => {
    if (ok) pollLocalHelper();
  });
}

async function stopLocalHelperSession() {
  helperSessionKey = "";
  try {
    await helperPost("/stop", {});
  } catch (err) {
    // The helper may not be running when disabling the plugin.
  }
}

async function pollLocalHelper() {
  if (!enabled || !useLocalHelper() || helperPollInFlight || Date.now() < apiBackoffUntil) return;
  if (!helperSessionKey) {
    await ensureLocalHelperSession(false);
    return;
  }

  helperPollInFlight = true;
  try {
    const latest = await helperGet("/latest");
    if (latest.status === "error" && latest.error) {
      render("", "", shortText(latest.error, 120));
      helperSessionKey = "";
      return;
    }

    const seq = Number(latest.seq || 0);
    const transcript = cleanText(latest.text || "");
    if (!transcript || seq <= lastHelperSeq) return;

    lastHelperSeq = seq;
    const requestId = ++lastRequestId;
    const translated = await translateTranscript(transcript);
    if (requestId === lastRequestId && enabled && useLocalHelper()) {
      render(transcript, translated, "");
    }
  } catch (err) {
    helperSessionKey = "";
    console.error("[Realtime Speech Translator] helper poll failed: " + cleanText(err && err.message));
  } finally {
    helperPollInFlight = false;
  }
}

async function restartLocalHelper() {
  clearOverlay();
  helperSessionKey = "";
  lastHelperSeq = 0;
  await ensureLocalHelperSession(true);
  await pollLocalHelper();
}

function resetTimeline() {
  const now = currentTime();
  lastSegmentEnd = Math.max(0, now - readNumber("chunkSeconds", 2));
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
  if (useLocalHelper()) {
    startLocalHelperCapture(true);
    timer = setInterval(pollLocalHelper, Math.max(250, readNumber("pollIntervalMs", 650)));
  } else {
    resetTimeline();
    timer = setInterval(captureTick, Math.max(250, readNumber("pollIntervalMs", 650)));
    captureTick();
  }
}

function stopCapture() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  processing = false;
  if (useLocalHelper()) stopLocalHelperSession();
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
      throw new Error(apiErrorMessage(data.error));
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
    let details = response.reason || "";
    try {
      const data = response.data || JSON.parse(response.text || "{}");
      if (data.error) details = apiErrorMessage(data.error);
    } catch (err) {
      details = response.reason || response.text || "";
    }
    throw new Error(apiErrorMessage("translation HTTP " + response.statusCode + " " + details));
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
  if (Date.now() < apiBackoffUntil) return;
  if (!canCapture()) return;

  const now = currentTime();
  const chunkSeconds = Math.max(1, readNumber("chunkSeconds", 2));
  const maxCatchup = Math.max(chunkSeconds, readNumber("maxCatchupSeconds", 4));

  if (lastSegmentEnd === null || now < lastSegmentEnd || now - lastSegmentEnd > maxCatchup) {
    lastSegmentEnd = Math.max(0, now - chunkSeconds);
  }

  const duration = now - lastSegmentEnd;
  if (duration < Math.max(0.8, chunkSeconds * 0.65)) return;

  const start = lastSegmentEnd;
  lastSegmentEnd = now;
  processing = true;
  const requestId = ++lastRequestId;

  processSegment(start, duration, requestId)
    .catch((err) => {
      const message = apiErrorMessage(err);
      console.error("[Realtime Speech Translator] " + cleanText(err && err.message));
      if (enabled) render("", "", message);
    })
    .finally(() => {
      processing = false;
      if (enabled) setTimeout(captureTick, 0);
    });
}

migrateLatencyDefaults();

menu.addItem(menu.item("Toggle Realtime Speech Translation", () => {
  setEnabled(!enabled);
}, { keyBinding: "Ctrl+Alt+t" }));

menu.addItem(menu.item("Restart Realtime Speech Translation", () => {
  setupOverlay();
  if (useLocalHelper()) {
    restartLocalHelper();
  } else {
    resetTimeline();
    captureTick();
  }
}));

menu.addItem(menu.item("Start Local ASR Helper", () => {
  startLocalHelperProcess()
    .then((started) => core.osd(started ? "Local ASR helper started" : "Set helperScriptPath first"))
    .catch((err) => {
      console.error("[Realtime Speech Translator] " + cleanText(err && err.message));
      core.osd("Could not start local ASR helper");
    });
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
  if (enabled && useLocalHelper()) restartLocalHelper();
});

if (core.window.loaded) {
  migrateLatencyDefaults();
  setupOverlay();
  if (enabled) startCapture();
  if (!enabled) overlay.hide();
}
