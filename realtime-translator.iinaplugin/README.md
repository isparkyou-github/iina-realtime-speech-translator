# Realtime Speech Translator for IINA

This IINA plugin transcribes the playing audio in near real time, translates the recognized speech, and renders the translation as a video overlay.

## Features

- Supports a local low-latency ASR helper powered by `ffmpeg` and `faster-whisper`.
- Supports `whisper.cpp` as a free local ASR engine using `whisper-server` and ggml models.
- Filters short, repeated, and overly similar recognition windows before translating.
- Keeps the older cloud API chunk-upload mode as a fallback.
- Sends recognized speech to an OpenAI-compatible `/v1/chat/completions` endpoint for translation.
- Shows the recognized speech and translation in an overlay.
- Keeps the previous translation visible while processing; it does not show unrelated listening/translating status text.
- Adds a Plugin menu toggle with `Ctrl+Alt+t`.

## Requirements

- IINA 1.4.0 or later.
- `ffmpeg` available in `PATH`.
- Python 3 plus `faster-whisper` for the default local-helper mode.
- Optional: `whisper.cpp` and a ggml model file for the free local `whisper.cpp` engine.

Install ffmpeg with Homebrew:

```sh
brew install ffmpeg
```

If IINA cannot find `ffmpeg`, set `ffmpeg path` in plugin preferences. Common Homebrew paths are `/opt/homebrew/bin/ffmpeg` on Apple Silicon and `/usr/local/bin/ffmpeg` on Intel Macs.

Install the helper dependency:

```sh
python3 -m pip install -r helper/requirements.txt
```

Optional free local `whisper.cpp` engine:

```sh
brew install whisper-cpp
mkdir -p "$HOME/Models/whisper.cpp"
curl -L -o "$HOME/Models/whisper.cpp/ggml-base.bin" \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

Start the helper:

```sh
python3 helper/local_asr_helper.py
```

## Install

1. Open IINA.
2. Open Settings > Plugins.
3. Install the packed `realtime-speech-translator.iinaplgz`, or link this folder for development.

For development linking, IINA's documentation supports:

```sh
ln -s /path/to/realtime-translator.iinaplugin "$HOME/Library/Application Support/com.colliderli.iina/plugins/realtime-translator.iinaplugin-dev"
```

## Configure

In IINA Settings > Plugins > Realtime Speech Translator > Preferences:

- Set `API key`.
- Set `ASR backend` to `local-helper`.
- Set `Local ASR engine` to `faster-whisper` or `whisper.cpp`.
- For `whisper.cpp`, set `Whisper.cpp command path` and `Whisper.cpp model path`; the helper derives `whisper-server` from the command path.
- Set `ffmpeg path` if auto-detection does not find it.
- Set `Speech transcription URL`.
- Set `Speech transcription model`.
- Set `Chat translation URL`.
- Set `Chat translation model`.
- Set `Target language`, for example `Simplified Chinese`.

The plugin does not translate existing subtitle files. It extracts audio from playback, transcribes speech, and translates the transcript.

## Troubleshooting

If the overlay says `OpenAI quota exceeded`, the configured API key has no usable quota or billing access. Check billing, project limits, and the API key, or switch to another compatible provider in plugin preferences.
