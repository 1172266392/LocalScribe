"""Auto-select transcriber backend based on platform."""
from __future__ import annotations

import platform

from .transcriber_base import Transcriber


def is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def make_transcriber(backend: str = "auto") -> Transcriber:
    """Return a Transcriber instance.

    backend:
      - "auto"  → MLX on Apple Silicon, faster-whisper otherwise
      - "mlx"   → 强制 MLX (Apple Silicon only)
      - "ct2"   → 强制 faster-whisper
    """
    if backend == "auto":
        backend = "mlx" if is_apple_silicon() else "ct2"

    if backend == "mlx":
        from .transcriber_mlx import MLXTranscriber

        return MLXTranscriber()
    if backend == "ct2":
        from .transcriber_ct2 import CT2Transcriber

        return CT2Transcriber()
    raise ValueError(f"Unknown backend: {backend!r}")


def default_model_id(backend: str = "auto") -> str:
    if backend == "auto":
        backend = "mlx" if is_apple_silicon() else "ct2"
    if backend == "mlx":
        from .transcriber_mlx import DEFAULT_MODEL

        return DEFAULT_MODEL
    if backend == "ct2":
        from .transcriber_ct2 import DEFAULT_MODEL

        return DEFAULT_MODEL
    raise ValueError(f"Unknown backend: {backend!r}")
