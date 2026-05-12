"""Senko + CAM++ 中文说话人分离(替换原 resemblyzer + KMeans)。

为什么换:
- CAM++ 在中文上 DER ~13%(AISHELL-4),resemblyzer 主英文训练效果差
- senko 用 CoreML 加速 → 96 分钟音频 ~47 秒搞定(原方案分钟级)
- 输出 192 维声纹中心(原 256 维 resemblyzer),声纹库需要重新上传样本

为什么不用 senko 默认 umap_hdbscan:
- macOS 上 libomp 冲突会死锁(senko + scikit-learn / hdbscan 各自带 libomp)
- 强制走 spectral 即可,慢一点但稳定。这里所有长度的音频都走 spectral
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

# 缓解 macOS libomp 冲突 —— senko / sklearn / numpy 各自带 libomp 副本同时加载会卡死
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")

# 声纹库匹配阈值(senko 192d centroid 上的 cosine)
# 0.875 是 senko 推荐的同录音同人阈值,跨录音同人通常 0.70-0.85,这里取中段
MATCH_THRESHOLD = 0.70

SR = 16_000


@dataclass
class DiarizedSegment:
    start: float
    end: float
    text: str
    speaker: str  # "三修" / "SPEAKER_A" 等


@dataclass
class DiarizationResult:
    segments: list[DiarizedSegment]
    speakers: list[str]
    cluster_count: int
    matched_profiles: dict[str, str]  # display_name → real name (匹配过的)
    stats: dict


def _ffmpeg_to_16k_wav(audio: Path) -> Path:
    """转码任意音频到 16kHz mono pcm_s16le 临时 wav(senko 要求的输入格式)。"""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_path = tmp.name
    tmp.close()
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(audio), "-ac", "1", "-ar", str(SR),
         "-acodec", "pcm_s16le", tmp_path],
        check=True,
    )
    return Path(tmp_path)


def _make_diarizer():
    """构建 senko Diarizer。warmup=False 避免 macOS 上 hdbscan warmup 死锁。"""
    import senko
    d = senko.Diarizer(device='auto', warmup=False, quiet=True)
    # 强制所有音频长度都用 spectral —— umap_hdbscan 在 macOS libomp 上死锁
    d.umap_hdbscan_cluster = d.spectral_cluster
    return d


def extract_voice_embedding(audio: Path) -> list[float]:
    """从样本音频提取 192 维 L2 归一化声纹向量。

    用 senko 跑一遍 diarization,取出现时长最长的 speaker 的 centroid。
    假设上传的样本以目标说话人为主。返回长度 192。
    """
    wav = _ffmpeg_to_16k_wav(audio)
    try:
        d = _make_diarizer()
        res = d.diarize(str(wav))
        centroids = res.get('speaker_centroids', {})
        if not centroids:
            raise ValueError("senko 未提取到任何声纹中心 — 音频可能无人声 / 太短")

        # 取主导说话人(说话总时长最长)
        dur = defaultdict(float)
        for s in res.get('raw_segments', []):
            dur[s['speaker']] += s['end'] - s['start']
        dominant = (
            max(dur.items(), key=lambda x: x[1])[0]
            if dur
            else next(iter(centroids))
        )
        emb = np.asarray(centroids[dominant], dtype=np.float32)
        emb = emb / (np.linalg.norm(emb) + 1e-9)
        return emb.astype(float).tolist()
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass


def diarize(
    audio: Path,
    segments: Sequence[dict],
    n_speakers: int = 0,  # senko 自动检测,此参数仅保留以兼容旧 API
    profiles: Iterable[dict] | None = None,
    on_progress=None,
) -> DiarizationResult:
    """对 whisper 给出的 segments 打 speaker 标签。

    流程:
      1. ffmpeg 转 16k mono wav
      2. senko 跑 VAD + Fbank + CAM++ embeddings + spectral clustering
      3. 给每个 whisper segment 找重叠最多的 senko speaker
      4. (可选)用 senko 192d centroid vs profiles 匹配真实姓名
    """
    profiles = list(profiles or [])

    if on_progress:
        on_progress({"stage": "diarize_load_audio"})
    wav = _ffmpeg_to_16k_wav(audio)
    try:
        if on_progress:
            on_progress({"stage": "diarize_init"})
        d = _make_diarizer()

        if on_progress:
            on_progress({"stage": "diarize_run"})
        senko_res = d.diarize(str(wav))
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass

    raw_segs = senko_res.get('raw_segments') or []
    centroids = senko_res.get('speaker_centroids') or {}

    if on_progress:
        on_progress({
            "stage": "diarize_cluster",
            "speakers": senko_res.get('raw_speakers_detected', len(centroids)),
        })

    # ---- 把 whisper segment → senko speaker(按时间重叠投票) ----
    def label_for_window(s: float, e: float) -> str:
        """返回与 [s,e] 重叠最多的 senko speaker id。"""
        if not raw_segs:
            return "SPEAKER_01"
        best_spk = None
        best_overlap = 0.0
        for rs in raw_segs:
            ov = max(0.0, min(rs['end'], e) - max(rs['start'], s))
            if ov > best_overlap:
                best_overlap = ov
                best_spk = rs['speaker']
        if best_spk is not None:
            return best_spk
        # 完全无重叠 —— 取时间上最近的说话区间
        mid = (s + e) / 2
        return min(
            raw_segs,
            key=lambda r: min(abs(mid - r['start']), abs(mid - r['end'])),
        )['speaker']

    # ---- 声纹库匹配:senko 192d centroid vs profiles ----
    matched: dict[str, str] = {}  # senko speaker id -> real name
    if profiles and centroids:
        prof_pairs: list[tuple[str, np.ndarray]] = []
        skipped_dim = 0
        for p in profiles:
            emb = np.asarray(p.get('embedding') or [], dtype=np.float32)
            if emb.shape != (192,):
                # 旧 resemblyzer 的 256 维 profile 不兼容 —— 用户需重新上传
                skipped_dim += 1
                continue
            emb = emb / (np.linalg.norm(emb) + 1e-9)
            prof_pairs.append((p.get('name') or 'SPEAKER', emb))

        for spk_id, cent in centroids.items():
            cent_arr = np.asarray(cent, dtype=np.float32)
            cent_arr = cent_arr / (np.linalg.norm(cent_arr) + 1e-9)
            best_name, best_sim = None, -1.0
            for name, emb in prof_pairs:
                sim = float(cent_arr @ emb)
                if sim > best_sim:
                    best_sim = sim
                    best_name = name
            if best_name and best_sim >= MATCH_THRESHOLD:
                matched[spk_id] = best_name

        if on_progress and skipped_dim:
            on_progress({
                "stage": "diarize_profile_skipped",
                "reason": "old 256d profiles incompatible — please re-upload voice samples",
                "skipped": skipped_dim,
            })

    if on_progress:
        on_progress({"stage": "diarize_assign", "matched": matched})

    # ---- 命名:senko SPEAKER_01/02 → SPEAKER_A/B(更友好)+ 应用匹配 ----
    senko_speakers = sorted({s['speaker'] for s in raw_segs})
    label_map: dict[str, str] = {}
    next_letter_idx = 0
    for sk in senko_speakers:
        if sk in matched:
            label_map[sk] = matched[sk]
        else:
            label_map[sk] = f"SPEAKER_{chr(ord('A') + next_letter_idx)}"
            next_letter_idx += 1

    # ---- 给每个 whisper segment 打标签 ----
    out_segs: list[DiarizedSegment] = []
    speakers_seen: list[str] = []
    for seg in segments:
        s, e = float(seg['start']), float(seg['end'])
        senko_spk = label_for_window(s, e)
        spk = label_map.get(senko_spk, "SPEAKER_A")
        if spk not in speakers_seen:
            speakers_seen.append(spk)
        out_segs.append(DiarizedSegment(
            start=s, end=e,
            text=str(seg.get('text') or ''),
            speaker=spk,
        ))

    return DiarizationResult(
        segments=out_segs,
        speakers=speakers_seen,
        cluster_count=len(senko_speakers),
        # 公开的 matched_profiles 用最终展示名(SPEAKER_A 或真名)→ 真名
        # 这样 UI 端展示一致
        matched_profiles={label_map[sk]: matched[sk] for sk in matched if sk in label_map},
        stats={
            'engine': 'senko',
            'embedding_dim': 192,
            'senko_raw_segments': len(raw_segs),
            'senko_speakers_detected': int(senko_res.get('raw_speakers_detected', 0)),
            'senko_speakers_merged': int(senko_res.get('merged_speakers_detected', 0)),
            'segment_count': len(out_segs),
            'matched_profile_count': len(matched),
            'timing': senko_res.get('timing_stats', {}),
            'duration_s': float(raw_segs[-1]['end']) if raw_segs else 0.0,
        },
    )
