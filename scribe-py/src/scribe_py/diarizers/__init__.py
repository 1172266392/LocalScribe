"""Diarization — speaker labeling for transcribed segments.

Currently provides a Resemblyzer + KMeans implementation that:
  1. Extracts 256-dim speaker embeddings from the audio (Resemblyzer VoiceEncoder)
  2. Clusters them into N speakers via KMeans
  3. Aligns each transcribed segment to embedding timestamps and assigns by majority vote
  4. Optionally matches cluster centroids against a registered "voice library" (cosine
     similarity) to label speakers with real names instead of SPEAKER_A/B
"""
from .resemblyzer_diarizer import (
    diarize,
    extract_voice_embedding,
    DiarizationResult,
)

__all__ = ["diarize", "extract_voice_embedding", "DiarizationResult"]
