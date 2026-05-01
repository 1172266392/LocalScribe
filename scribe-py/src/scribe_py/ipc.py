"""JSON-RPC 2.0 over stdin/stdout. One JSON per line.

Architecture (since v0.2):
  - **reader thread** reads stdin and pushes parsed requests onto a queue
  - **main loop** processes requests:
    * Control methods (correct_pause / correct_resume / correct_cancel) are handled
      synchronously on the main thread — they just toggle flags on the global CONTROL.
    * Long-running methods (transcribe / correct / polish / ...) are submitted to
      a worker thread pool so the main loop keeps reading control commands while
      a correction is in flight.

Request:
  {"id": 1, "method": "transcribe", "params": {...}}

Response:
  {"id": 1, "result": {...}}
  {"id": 1, "error": {"code": -32000, "message": "..."}}

Progress notification (no id, server → client only):
  {"event": "progress", "method": "transcribe", "data": {...}}
"""
from __future__ import annotations

import json
import queue
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .control import CONTROL
from .core.audio import find_ffmpeg, find_ffprobe, probe_audio
from .core.selector import default_model_id, is_apple_silicon, make_transcriber
from .core.types import Segment, TranscribeOptions
from .correctors.openai_compatible import OpenAICompatibleCorrector
from .polishers.article_polisher import ArticlePolisher

# stdout writes need to be atomic across threads.
_emit_lock = threading.Lock()


def _emit(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    with _emit_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def _segments_from_dicts(items: list[dict]) -> list[Segment]:
    return [Segment(start=float(s["start"]), end=float(s["end"]), text=s["text"]) for s in items]


def _make_progress(method: str):
    def cb(data: dict) -> None:
        _emit({"event": "progress", "method": method, "data": data})
    return cb


# ---- method handlers ----

def handle_check_model(params: dict) -> dict:
    backend = params.get("backend", "auto")
    model_id = params.get("model_id") or default_model_id(backend)
    repo_dir = model_id.replace("/", "--")
    cache_dir = Path.home() / ".cache" / "huggingface" / "hub" / f"models--{repo_dir}"
    return {
        "backend": backend,
        "model_id": model_id,
        "exists": cache_dir.exists(),
        "path": str(cache_dir) if cache_dir.exists() else None,
    }


def handle_probe_audio(params: dict) -> dict:
    audio = params["audio"]
    info = probe_audio(audio)
    return {
        "audio": audio,
        "ffmpeg": find_ffmpeg(),
        "ffprobe": find_ffprobe(),
        **info,
    }


def handle_environment(params: dict) -> dict:
    return {
        "apple_silicon": is_apple_silicon(),
        "default_backend": "mlx" if is_apple_silicon() else "ct2",
        "ffmpeg": find_ffmpeg(),
        "ffprobe": find_ffprobe(),
        "default_model_id": default_model_id(),
    }


def handle_transcribe(params: dict) -> dict:
    audio = params["audio"]
    backend = params.get("backend", "auto")
    options = TranscribeOptions(
        language=params.get("language", "zh"),
        model_id=params.get("model_id") or default_model_id(backend),
        initial_prompt=params.get("initial_prompt", ""),
        word_timestamps=bool(params.get("word_timestamps", False)),
    )
    transcriber = make_transcriber(backend)
    result = transcriber.transcribe(audio, options, on_progress=_make_progress("transcribe"))
    return result.to_dict()


def handle_correct(params: dict) -> dict:
    # Reset shared control before starting a fresh run.
    CONTROL.reset()
    segments = _segments_from_dicts(params["segments"])
    corrector = OpenAICompatibleCorrector(
        api_key=params["api_key"],
        base_url=params.get("base_url", "https://api.deepseek.com"),
        model=params.get("model", "deepseek-v4-flash"),
        mode=params.get("mode", "medium"),
        batch_size=int(params.get("batch_size", 20)),
        temperature=float(params.get("temperature", 0.1)),
        max_tokens=int(params.get("max_tokens", 8192)),
        top_p=float(params.get("top_p", 1.0)),
        frequency_penalty=float(params.get("frequency_penalty", 0.0)),
        presence_penalty=float(params.get("presence_penalty", 0.0)),
        use_glossary=bool(params.get("use_glossary", True)),
        concurrency=int(params.get("concurrency", 5)),
    )
    out = corrector.correct(
        segments,
        context_hint=params.get("context_hint", ""),
        on_progress=_make_progress("correct"),
        control=CONTROL,
    )
    changed = sum(1 for s in out if s.text != (s.original_text or s.text))
    return {
        "segments": [s.to_dict() for s in out],
        "changed": changed,
        "total": len(out),
        "model": corrector.model,
        "mode": corrector.mode,
        "glossary": corrector.last_glossary,
        "cancelled": corrector.last_cancelled,
        "concurrency": corrector.concurrency,
    }


def handle_polish(params: dict) -> dict:
    segments = _segments_from_dicts(params["segments"])
    polisher = ArticlePolisher(
        api_key=params["api_key"],
        base_url=params.get("base_url", "https://api.deepseek.com"),
        model=params.get("model", "deepseek-v4-flash"),
        temperature=float(params.get("temperature", 0.3)),
        max_tokens=int(params.get("max_tokens", 384000)),
        top_p=float(params.get("top_p", 1.0)),
        frequency_penalty=float(params.get("frequency_penalty", 0.0)),
        presence_penalty=float(params.get("presence_penalty", 0.0)),
    )
    out = polisher.polish(segments)
    text = out.get("text", "")
    return {
        "text": text,
        "model": polisher.model,
        "char_count": len(text),
        "finish_reason": out.get("finish_reason", "stop"),
        "truncated": out.get("truncated", False),
        "input_chars": out.get("input_chars", 0),
    }


# ---- control methods (instant, run on main thread) ----

def handle_correct_pause(_params: dict) -> dict:
    CONTROL.request_pause()
    return {"status": "paused"}


def handle_correct_resume(_params: dict) -> dict:
    CONTROL.request_resume()
    return {"status": "resumed"}


def handle_correct_cancel(_params: dict) -> dict:
    CONTROL.request_cancel()
    return {"status": "cancelling"}


def handle_correct_status(_params: dict) -> dict:
    return {
        "paused": CONTROL.is_paused(),
        "cancelled": CONTROL.is_cancelled(),
    }


HANDLERS: dict[str, Any] = {
    "check_model": handle_check_model,
    "probe_audio": handle_probe_audio,
    "environment": handle_environment,
    "transcribe": handle_transcribe,
    "correct": handle_correct,
    "polish": handle_polish,
    "correct_pause": handle_correct_pause,
    "correct_resume": handle_correct_resume,
    "correct_cancel": handle_correct_cancel,
    "correct_status": handle_correct_status,
}

# Methods that must run on the main thread (so they can interrupt long-running ops).
CONTROL_METHODS = {
    "correct_pause",
    "correct_resume",
    "correct_cancel",
    "correct_status",
}


# ---- main loop ----

def _dispatch(rid: Any, method: str, params: dict) -> None:
    """Execute a handler and emit response. Catches all exceptions."""
    if method not in HANDLERS:
        _emit({"id": rid, "error": {"code": -32601, "message": f"Method not found: {method}"}})
        return
    try:
        result = HANDLERS[method](params)
        _emit({"id": rid, "result": result})
    except Exception as e:  # noqa: BLE001
        _emit({
            "id": rid,
            "error": {
                "code": -32000,
                "message": str(e),
                "data": {"traceback": traceback.format_exc()},
            },
        })


def run() -> None:
    """Reader thread + worker pool. See module docstring."""
    request_q: queue.Queue = queue.Queue()
    stop_flag = threading.Event()

    def reader() -> None:
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except json.JSONDecodeError as e:
                    _emit({"error": {"code": -32700, "message": f"Parse error: {e}"}})
                    continue
                request_q.put(req)
        finally:
            stop_flag.set()
            # Wake up the main loop with a sentinel so it can shut down.
            request_q.put(None)

    threading.Thread(target=reader, name="ipc-reader", daemon=True).start()

    # max_workers=4: enough for one transcribe + one correct in flight + a polish + buffer.
    executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ipc-worker")

    try:
        while not stop_flag.is_set() or not request_q.empty():
            try:
                req = request_q.get(timeout=0.5)
            except queue.Empty:
                continue
            if req is None:  # sentinel from reader on stdin EOF
                break

            rid = req.get("id")
            method = req.get("method")
            params = req.get("params", {}) or {}

            if method in CONTROL_METHODS:
                # Run synchronously on the main thread for instant response.
                _dispatch(rid, method, params)
            else:
                # Dispatch to a worker so we keep reading control commands.
                executor.submit(_dispatch, rid, method, params)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
