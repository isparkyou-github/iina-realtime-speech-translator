#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/realtime-translator.iinaplugin"
zip -r ../realtime-subtitle-translator.iinaplgz .

