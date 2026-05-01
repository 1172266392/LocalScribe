"""Shared data types for the transcription pipeline."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Segment:
    start: float
    end: float
    text: str
    original_text: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d = {"start": self.start, "end": self.end, "text": self.text}
        if self.original_text is not None and self.original_text != self.text:
            d["original_text"] = self.original_text
        return d


@dataclass
class TranscribeOptions:
    language: str | None = "zh"
    model_id: str = "mlx-community/whisper-large-v3-turbo"
    initial_prompt: str = ""
    word_timestamps: bool = False


@dataclass
class TranscribeResult:
    audio: str
    language: str | None
    duration: float
    transcribe_seconds: float
    rtf: float
    backend: str
    model_id: str
    segments: list[Segment] = field(default_factory=list)
    filter_stats: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "audio": self.audio,
            "language": self.language,
            "duration": self.duration,
            "transcribe_seconds": self.transcribe_seconds,
            "rtf": self.rtf,
            "backend": self.backend,
            "model_id": self.model_id,
            "segments": [s.to_dict() for s in self.segments],
            "filter_stats": self.filter_stats,
        }
