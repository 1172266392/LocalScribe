"""Transcriber abstract base class."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable

from .types import Segment, TranscribeOptions, TranscribeResult

ProgressCallback = Callable[[dict], None]


class Transcriber(ABC):
    """所有转录后端的统一接口。子类实现 `_run`,基类负责计时和打包结果。"""

    backend: str = "base"

    @abstractmethod
    def _run(
        self,
        audio: Path,
        options: TranscribeOptions,
        on_progress: ProgressCallback | None,
    ) -> tuple[list[Segment], str | None]:
        """子类实现:返回 (segments, detected_language)。"""

    def transcribe(
        self,
        audio: Path | str,
        options: TranscribeOptions | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> TranscribeResult:
        import time

        audio_path = Path(audio)
        opts = options or TranscribeOptions()
        t0 = time.time()
        segments, detected = self._run(audio_path, opts, on_progress)
        elapsed = time.time() - t0
        duration = segments[-1].end if segments else 0.0
        rtf = elapsed / duration if duration else 0.0
        return TranscribeResult(
            audio=str(audio_path),
            language=detected or opts.language,
            duration=duration,
            transcribe_seconds=elapsed,
            rtf=rtf,
            backend=self.backend,
            model_id=opts.model_id,
            segments=segments,
            filter_stats=getattr(self, "last_filter_stats", {}) or {},
        )
