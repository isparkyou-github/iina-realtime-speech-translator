#!/usr/bin/env python3
import argparse
import collections
import difflib
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
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


def normalize_text(value):
    return clean_text(value).lower().strip(" .,!?;:'\"，。！？；：、")


def number_config(config, key, default):
    value = config.get(key)
    if value is None or value == "":
        return default
    return type(default)(value)


def int_config(config, key, default):
    value = config.get(key)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


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


def available_binary(path_or_name):
    if not path_or_name:
        return ""
    if os.path.sep in path_or_name:
        return path_or_name if os.path.exists(path_or_name) and os.access(path_or_name, os.X_OK) else ""
    return shutil.which(path_or_name) or ""


class AsrWorker:
    def __init__(self, config):
        self.config = config
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.process = None
        self.asr_process = None
        self.model = None
        self.last_text = ""
        self.last_normalized = ""
        self.last_emit_at = 0.0
        self.engine = self.config.get("engine") or "faster-whisper"
        self.whisper_cpp_server_url = ""

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
        if self.asr_process and self.asr_process.poll() is None:
            self.asr_process.terminate()
            try:
                self.asr_process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.asr_process.kill()

    def load_model(self):
        if self.engine == "whisper.cpp":
            self.load_whisper_cpp()
            return

        if WhisperModel is None:
            raise RuntimeError(
                "faster-whisper is not installed. Run: python3 -m pip install -r helper/requirements.txt"
            )
        model_name = self.config.get("model") or "base"
        device = self.config.get("device") or "auto"
        compute_type = self.config.get("compute_type") or "auto"
        set_state(status="loading-model", error="")
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)

    def load_whisper_cpp(self):
        command = self.config.get("whisper_cpp_server_path") or ""
        if not command:
            cli_command = self.config.get("whisper_cpp_path") or "whisper-cli"
            cli_path = available_binary(cli_command)
            if cli_path and os.path.basename(cli_path) == "whisper-cli":
                sibling = os.path.join(os.path.dirname(cli_path), "whisper-server")
                command = sibling if os.path.exists(sibling) else "whisper-server"
            else:
                command = "whisper-server"
        command_path = available_binary(command)
        if not command_path:
            raise RuntimeError(
                "whisper-server command not found. Install whisper.cpp with Homebrew."
            )

        model_path = self.config.get("whisper_cpp_model_path") or self.config.get("model_path") or ""
        if not model_path or not os.path.exists(model_path):
            raise RuntimeError(
                "Whisper.cpp model path is required. Download a ggml model and set Whisper.cpp model path."
            )

        self.config["whisper_cpp_server_path"] = command_path
        self.config["whisper_cpp_model_path"] = model_path
        set_state(status="loading-whisper.cpp", error="")
        self.start_whisper_cpp_server()

    def free_port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def wait_for_port(self, port, timeout=35):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.asr_process and self.asr_process.poll() is not None:
                raise RuntimeError("whisper-server exited before it was ready")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    return
            except OSError:
                time.sleep(0.2)
        raise RuntimeError("whisper-server did not become ready")

    def start_whisper_cpp_server(self):
        port = int_config(self.config, "whisper_cpp_server_port", 0) or self.free_port()
        language = self.config.get("language") or "auto"
        threads = int_config(self.config, "whisper_cpp_threads", 0)
        args = [
            self.config["whisper_cpp_server_path"],
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "-m",
            self.config["whisper_cpp_model_path"],
            "-l",
            language,
            "-nt",
            "-bo",
            "1",
            "-bs",
            "1",
            "-nth",
            "0.65",
        ]
        if threads > 0:
            args.extend(["-t", str(threads)])

        self.asr_process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.wait_for_port(port)
        self.whisper_cpp_server_url = "http://127.0.0.1:%s/inference" % port

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
        if self.engine == "whisper.cpp":
            return self.transcribe_window_whisper_cpp(pcm)

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

    def transcribe_window_whisper_cpp(self, pcm):
        fd, path = tempfile.mkstemp(prefix="iina-rst-", suffix=".wav")
        os.close(fd)
        try:
            write_wav(path, pcm)
            data, content_type = self.multipart_payload(
                {
                    "temperature": "0.0",
                    "temperature_inc": "0.0",
                    "response_format": "json",
                },
                "file",
                path,
            )
            request = urllib.request.Request(
                self.whisper_cpp_server_url,
                data=data,
                headers={"Content-Type": content_type},
                method="POST",
            )
            with urllib.request.urlopen(
                request,
                timeout=max(20, int(number_config(self.config, "window_seconds", 2.0) * 10)),
            ) as response:
                payload = response.read().decode("utf-8", "replace")
            return self.extract_whisper_cpp_text(payload)
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def multipart_payload(self, fields, file_field, file_path):
        boundary = "iina-rst-%d" % int(time.time() * 1000000)
        chunks = []
        for name, value in fields.items():
            chunks.append(("--%s\r\n" % boundary).encode("utf-8"))
            chunks.append(('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode("utf-8"))
            chunks.append(str(value).encode("utf-8"))
            chunks.append(b"\r\n")

        filename = os.path.basename(file_path)
        chunks.append(("--%s\r\n" % boundary).encode("utf-8"))
        header = (
            'Content-Disposition: form-data; name="%s"; filename="%s"\r\n'
            "Content-Type: audio/wav\r\n\r\n"
        ) % (file_field, filename)
        chunks.append(header.encode("utf-8"))
        with open(file_path, "rb") as handle:
            chunks.append(handle.read())
        chunks.append(b"\r\n")
        chunks.append(("--%s--\r\n" % boundary).encode("utf-8"))
        return b"".join(chunks), "multipart/form-data; boundary=%s" % boundary

    def extract_whisper_cpp_text(self, payload):
        cleaned = clean_text(payload)
        if not cleaned:
            return ""
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            return clean_text(re.sub(r"\[[^\]]+\]", " ", cleaned))

        if isinstance(data, dict):
            if data.get("text"):
                return clean_text(data["text"])
            if isinstance(data.get("segments"), list):
                return clean_text(" ".join(clean_text(segment.get("text", "")) for segment in data["segments"]))
            if isinstance(data.get("transcription"), list):
                return clean_text(" ".join(clean_text(segment.get("text", "")) for segment in data["transcription"]))
        return cleaned

    def should_emit(self, text):
        normalized = normalize_text(text)
        if not normalized:
            return False

        min_chars = number_config(self.config, "min_chars", 4)
        min_words = number_config(self.config, "min_words", 2)
        if len(normalized) < min_chars:
            return False
        if len(normalized.split()) < min_words and len(normalized) < 8:
            return False

        now = time.time()
        cooldown = max(0.0, number_config(self.config, "emit_cooldown_seconds", 0.7))
        if now - self.last_emit_at < cooldown:
            return False

        if not self.last_normalized:
            return True

        if normalized == self.last_normalized:
            return False
        if normalized in self.last_normalized or self.last_normalized in normalized:
            return False

        ratio = difflib.SequenceMatcher(None, normalized, self.last_normalized).ratio()
        dedupe_ratio = number_config(self.config, "dedupe_ratio", 0.86)
        return ratio < dedupe_ratio

    def emit_text(self, text):
        self.last_text = text
        self.last_normalized = normalize_text(text)
        self.last_emit_at = time.time()
        with state_lock:
            state["seq"] += 1
            state["text"] = text
            state["status"] = "listening"
            state["error"] = ""
            state["updated_at"] = time.time()

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
                if self.should_emit(text):
                    self.emit_text(text)

            code = self.process.poll()
            if code not in (0, None) and not self.stop_event.is_set():
                stderr = self.process.stderr.read().decode("utf-8", "replace")
                raise RuntimeError(clean_text(stderr) or "ffmpeg exited with status %s" % code)
            set_state(running=False, status="stopped")
        except Exception as exc:
            set_state(running=False, status="error", error=clean_text(exc))
        finally:
            if self.asr_process and self.asr_process.poll() is None:
                self.asr_process.terminate()
                try:
                    self.asr_process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.asr_process.kill()


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
            data["whisper_cpp_available"] = bool(available_binary("whisper-server"))
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
