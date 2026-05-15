# Realtime Speech Translator for IINA

This IINA plugin transcribes the playing audio in near real time, translates the recognized speech, and renders the translation as a video overlay.

## Features

- Reads the current playback time and extracts short audio chunks with `ffmpeg`.
- Sends each chunk to a speech-to-text endpoint.
- Sends recognized speech to an OpenAI-compatible `/v1/chat/completions` endpoint for translation.
- Shows the recognized speech and translation in an overlay.
- Adds a Plugin menu toggle with `Ctrl+Alt+t`.

## Requirements

- IINA 1.4.0 or later.
- `ffmpeg` and `curl` available in `PATH`.

Install ffmpeg with Homebrew:

```sh
brew install ffmpeg
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
- Set `Speech transcription URL`.
- Set `Speech transcription model`.
- Set `Chat translation URL`.
- Set `Chat translation model`.
- Set `Target language`, for example `Simplified Chinese`.

The plugin does not translate existing subtitle files. It extracts audio from playback, transcribes speech, and translates the transcript.
