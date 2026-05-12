"""Diarization — speaker labeling for transcribed segments.

**Active engine: Senko (CAM++ + CoreML)**
  - 中文 DER ~13%(AISHELL-4 基准),专门为中文优化
  - macOS CoreML 加速,M 芯片上 96 分钟音频 ~47 秒
  - 输出 192 维 L2 归一化声纹中心
  - 长音频强制走 spectral 聚类(避免 macOS libomp + hdbscan 死锁)

旧 resemblyzer + KMeans 实现保留在 `resemblyzer_diarizer.py`,可作为 fallback。
若需切回旧引擎,把下面 import 改回 `.resemblyzer_diarizer`。

⚠️ 升级注意:senko 输出 192 维 vs 旧的 256 维,**用户已有的声纹样本需要重新上传**。
"""
from .senko_diarizer import (
    diarize,
    extract_voice_embedding,
    DiarizationResult,
)

__all__ = ["diarize", "extract_voice_embedding", "DiarizationResult"]
