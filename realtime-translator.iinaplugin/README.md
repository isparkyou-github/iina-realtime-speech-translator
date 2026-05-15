# Realtime Subtitle Translator for IINA

This IINA plugin translates the current text subtitle line in real time and renders the translation as a video overlay.

## Features

- Watches mpv's `sub-text` property for the currently displayed subtitle.
- Sends each new subtitle line to an OpenAI-compatible `/v1/chat/completions` endpoint.
- Caches translated lines during playback to avoid repeated requests.
- Shows the original subtitle and translation in an overlay.
- Adds a Plugin menu toggle with `Ctrl+Alt+t`.

## Install

1. Open IINA 1.4.0 or later.
2. Open Settings > Plugins.
3. Install the packed `realtime-subtitle-translator.iinaplgz`, or link this folder for development.

For development linking, IINA's documentation supports:

```sh
ln -s /path/to/realtime-translator.iinaplugin "$HOME/Library/Application Support/com.colliderli.iina/plugins/realtime-translator.iinaplugin-dev"
```

## Configure

In IINA Settings > Plugins > Realtime Subtitle Translator > Preferences:

- Set `OpenAI-compatible chat completions URL`.
- Set `API key`.
- Set `Model`.
- Set `Target language`, for example `Simplified Chinese`.

The plugin requires text subtitles. Bitmap subtitles such as PGS/DVD subtitles cannot be translated through mpv's `sub-text` property.
