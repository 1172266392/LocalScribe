"""ffmpeg/ffprobe helpers."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path


def find_ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def find_ffprobe() -> str | None:
    return shutil.which("ffprobe")


def probe_audio(audio: Path | str) -> dict:
    """Return {duration, size, format_name, has_audio_stream}. Raises if ffprobe missing."""
    ffprobe = find_ffprobe()
    if not ffprobe:
        raise RuntimeError("ffprobe not found in PATH. Install ffmpeg first.")
    proc = subprocess.run(
        [
            ffprobe,
            "-v", "error",
            "-show_entries", "format=duration,size,format_name",
            "-show_streams",
            "-of", "json",
            str(audio),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {proc.stderr.strip()}")
    data = json.loads(proc.stdout)
    fmt = data.get("format", {})
    has_audio = any(s.get("codec_type") == "audio" for s in data.get("streams", []))
    return {
        "duration": float(fmt.get("duration", 0)),
        "size": int(fmt.get("size", 0)),
        "format_name": fmt.get("format_name"),
        "has_audio_stream": has_audio,
    }
