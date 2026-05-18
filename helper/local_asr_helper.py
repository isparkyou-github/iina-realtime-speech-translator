#!/usr/bin/env python3
import argparse
import collections
import json
import os
import subprocess
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2

state_lock = threading.Lock()
worker = None
state = {
    "running": False,
    "status": "idle",
    "seq": 0,
    "text": "",
    "error": "",
    "started_at": None,
    "updated_at": None,
}

WhisperModel = None
whisper_import_error = None
try:
    from faster_whisper import WhisperModel as FasterWhisperModel
    WhisperModel = FasterWhisperModel
except Exception as exc:
    whisper_import_error = str(exc)


def clean_text(value):
    return " ".join(str(value or "").split()).strip()


def set_state(**updates):
    with state_lock:
        state.update(updates)
        state["updated_at"] = time.time()


def snapshot():
    with state_lock:
        return dict(state)


def write_wav(path, pcm):
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(BYTES_PER_SAMPLE)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)


class AsrWorker:
    def __init__(self, config):
        self.config = config
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.process = None
        self.model = None
        self.last_text = ""

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()

    def load_model(self):
        if WhisperModel is None:
            raise RuntimeError(
                "faster-whisper is not installed. Run: python3 -m pip install -r helper/requirements.txt"
            )
        model_name = self.config.get("model") or "base"
        device = self.config.get("device") or "auto"
        compute_type = self.config.get("compute_type") or "auto"
        set_state(status="loading-model", error="")
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)

    def ffmpeg_command(self):
        ffmpeg = self.config.get("ffmpeg_path") or "ffmpeg"
        media_path = self.config["media_path"]
        start_time = max(0.0, float(self.config.get("start_time") or 0))
        return [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            str(start_time),
            "-i",
            media_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "s16le",
            "-"
        ]

    def transcribe_window(self, pcm):
        fd, path = tempfile.mkstemp(prefix="iina-rst-", suffix=".wav")
        os.close(fd)
        try:
            write_wav(path, pcm)
            language = self.config.get("language")
            if language == "auto":
                language = None
            segments, _info = self.model.transcribe(
                path,
                language=language,
                beam_size=1,
                best_of=1,
                vad_filter=True,
                condition_on_previous_text=False,
                no_speech_threshold=0.65,
                temperature=0.0,
            )
            return clean_text(" ".join(segment.text for segment in segments))
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def run(self):
        try:
            self.load_model()
            window_seconds = max(1.0, float(self.config.get("window_seconds") or 2.0))
            stride_seconds = max(0.25, float(self.config.get("stride_seconds") or 0.7))
            window_bytes = int(window_seconds * SAMPLE_RATE * BYTES_PER_SAMPLE)
            stride_bytes = int(stride_seconds * SAMPLE_RATE * BYTES_PER_SAMPLE)
            audio = collections.deque(maxlen=window_bytes)

            self.process = subprocess.Popen(
                self.ffmpeg_command(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            set_state(running=True, status="listening", error="", started_at=time.time())

            while not self.stop_event.is_set():
                chunk = self.process.stdout.read(stride_bytes)
                if not chunk:
                    break
                audio.extend(chunk)
                if len(audio) < min(window_bytes, stride_bytes * 2):
                    continue

                text = self.transcribe_window(bytes(audio))
                if text and text != self.last_text:
                    self.last_text = text
                    with state_lock:
                        state["seq"] += 1
                        state["text"] = text
                        state["status"] = "listening"
                        state["error"] = ""
                        state["updated_at"] = time.time()

            code = self.process.poll()
            if code not in (0, None) and not self.stop_event.is_set():
                stderr = self.process.stderr.read().decode("utf-8", "replace")
                raise RuntimeError(clean_text(stderr) or "ffmpeg exited with status %s" % code)
            set_state(running=False, status="stopped")
        except Exception as exc:
            set_state(running=False, status="error", error=clean_text(exc))


def stop_worker():
    global worker
    if worker:
        worker.stop()
        worker = None


def start_worker(config):
    global worker
    stop_worker()
    set_state(running=False, status="starting", text="", error="", started_at=time.time())
    worker = AsrWorker(config)
    worker.start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def send_json(self, status, data):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            data = snapshot()
            data["ok"] = True
            data["whisper_available"] = WhisperModel is not None
            data["whisper_import_error"] = whisper_import_error
            self.send_json(200, data)
            return
        if path == "/latest":
            self.send_json(200, snapshot())
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/start":
            config = self.read_json()
            if not config.get("media_path"):
                self.send_json(400, {"ok": False, "error": "media_path is required"})
                return
            start_worker(config)
            self.send_json(200, {"ok": True, "state": snapshot()})
            return
        if path == "/stop":
            stop_worker()
            set_state(running=False, status="stopped")
            self.send_json(200, {"ok": True})
            return
        self.send_json(404, {"error": "not found"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("IINA realtime speech helper listening on http://%s:%s" % (args.host, args.port), flush=True)
    try:
        server.serve_forever()
    finally:
        stop_worker()


if __name__ == "__main__":
    main()

