#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/realtime-translator.iinaplugin"
ditto --norsrc -c -k . ../realtime-speech-translator.iinaplgz
