"""Apple Silicon MLX transcriber + 4-layer hallucination defense.

四层防御(从源头到兜底):
  ① VAD 输入清理       — silero-vad 检测说话区间,Whisper 段落不在说话区间则丢弃
  ② 解码硬化           — condition_on_previous_text=False + no_speech / compression / logprob 阈值
  ③ 置信度自校         — Whisper 自报 avg_logprob,过低段丢弃
  ④ 模式后处理         — token 重复、字符密度、段间相似度、已知幻觉短语黑名单

返回的 segments 不再有幻觉,且 result 上挂 `filter_stats` 暴露每层过滤数量。
"""
from __future__ import annotations

import os
from difflib import SequenceMatcher
from pathlib import Path

from .transcriber_base import ProgressCallback, Transcriber
from .types import Segment, TranscribeOptions

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


def _resolve_model_path(model_id: str) -> str:
    """优先使用项目内置 models/ 目录,缺失再回落到 HF repo id。

    解析顺序:
      1. 环境变量 LOCALSCRIBE_MODEL_DIR (绝对路径)
      2. <project_root>/models/<basename>     ← 默认随仓库分发
      3. <repo_root>/models/<basename>        ← 兼容打包后 .app/Resources
      4. 原始 model_id (HF cache 兜底)
    """
    basename = model_id.rsplit("/", 1)[-1]

    # 1. 显式环境变量
    env_dir = os.environ.get("LOCALSCRIBE_MODEL_DIR")
    if env_dir:
        p = Path(env_dir).expanduser()
        if (p / "weights.safetensors").exists():
            return str(p)
        candidate = p / basename
        if (candidate / "weights.safetensors").exists():
            return str(candidate)

    # 2. 向上找 LocalScribe 项目根 (含 scribe-py/ + package.json)
    here = Path(__file__).resolve()
    for ancestor in here.parents:
        if (ancestor / "scribe-py").is_dir() and (ancestor / "package.json").is_file():
            local = ancestor / "models" / basename
            if (local / "weights.safetensors").exists():
                return str(local)
            break

    # 3. 兜底:HF repo id (mlx-whisper 自己去缓存或下载)
    return model_id

# ============================================================================
# Layer 4 patterns(短语黑名单 + 重复检测)
# ============================================================================

STRONG_HALLUCINATION_PHRASES: tuple[str, ...] = (
    "请不吝点赞",
    "打赏支持",
    "明镜与点点栏目",
    "明镜栏目",
    "點點欄目",
    "請按讚訂閱",
    "字幕由Amara",
    "字幕志愿者",
    "由社群字幕",
    "Please subscribe",
    "Please like and subscribe",
    "Like and subscribe",
    # 字幕组 / 视频平台水印型
    "优优独播",
    "獨播劇場",
    "YoYo Television",
    "Television Series Exclusive",
    "YouTube",  # 真说"YouTube"概率低于幻觉
    "本节目",
    "本视频",
    "我们下期再见",
    "我们下次再见",
    "下期再见",
    "下次再见",
)
WEAK_HALLUCINATION_PHRASES: tuple[str, ...] = (
    "感谢观看",
    "感谢您的观看",
    "请订阅",
    "请订阅本频道",
    "请点赞",
    "请关注",
    "谢谢观看",
    "谢谢大家",
    "Thanks for watching",
    "Thank you for watching",
    "Subscribe",
)


def _hits_phrases(text: str, phrases: tuple[str, ...]) -> bool:
    t = text.strip().rstrip("，。！？,.!? ")
    return any(p in t for p in phrases)


def _is_repetitive(text: str) -> bool:
    """Token 级或字符级高度重复检测,不依赖具体短语。

    保守起见:正常文本(>10 字)的 unique-ratio 通常 > 0.5;低于 0.4 就极不正常。
    """
    t = text.strip()
    if len(t) < 6:
        return False
    # 1) 空格分词:unique/total < 0.4 且 ≥3 词 → 重复(英文型)
    words = t.split()
    if len(words) >= 3 and len(set(words)) / len(words) < 0.4:
        return True
    # 2) 1-8 字符 seed 重复(中文 "甚麼甚麼甚麼" / "嗯嗯嗯嗯" 都要捕获)
    for span in range(1, 9):
        if len(t) < span * 3:
            continue
        seed = t[:span]
        if not seed.strip():
            continue
        # 整段大部分由 seed 构成
        if t.count(seed) * span >= len(t) * 0.6 and t.count(seed) >= 3:
            return True
    # 3) 单字符占比过高(如 '一一一啊一一')
    if len(t) >= 6:
        from collections import Counter
        cnt = Counter(t.replace(" ", ""))
        total = sum(cnt.values())
        if total > 0 and cnt.most_common(1)[0][1] / total > 0.6:
            return True
    return False


def _density_anomalous(text: str, start: float, end: float) -> bool:
    """字符密度异常:中文正常 4-7 字/秒。> 12 视为塞满了重复内容。"""
    duration = max(0.001, end - start)
    chars = len(text.strip().replace(" ", ""))
    if chars < 10:
        return False
    return chars / duration > 12.0


def _segment_pair_similar(a: str, b: str, thresh: float = 0.9) -> bool:
    if not a or not b:
        return False
    return SequenceMatcher(None, a, b).ratio() >= thresh


# ============================================================================
# Layer 1: VAD pre/post filter
# ============================================================================

_vad_model = None


def _get_vad_model():
    global _vad_model
    if _vad_model is None:
        from silero_vad import load_silero_vad
        _vad_model = load_silero_vad()
    return _vad_model


def _vad_speech_ranges(audio_path: Path) -> list[tuple[float, float]]:
    """返回说话区间列表 [(start_s, end_s), ...]。失败返回 []。"""
    try:
        from silero_vad import get_speech_timestamps, read_audio

        model = _get_vad_model()
        wav = read_audio(str(audio_path), sampling_rate=16000)
        # min_silence_duration_ms=500: 容忍小停顿;min_speech_duration_ms=250: 短词不漏
        ts = get_speech_timestamps(
            wav,
            model,
            sampling_rate=16000,
            min_silence_duration_ms=500,
            min_speech_duration_ms=250,
        )
        return [(t["start"] / 16000.0, t["end"] / 16000.0) for t in ts]
    except Exception:  # noqa: BLE001
        return []


def _in_any_range(t: float, ranges: list[tuple[float, float]]) -> bool:
    """二分查 t 是否落在任一 (lo, hi) 区间内。"""
    if not ranges:
        return True  # VAD 失败时不过滤
    lo, hi = 0, len(ranges) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        a, b = ranges[mid]
        if t < a:
            hi = mid - 1
        elif t > b:
            lo = mid + 1
        else:
            return True
    return False


# ============================================================================
# 主过滤函数:四层依次跑,统计每层删除数
# ============================================================================

def _filter_all_layers(
    raw_segments: list[dict],
    audio_path: Path,
) -> tuple[list[Segment], dict]:
    """raw_segments 是 mlx-whisper 原始返回,带 avg_logprob / no_speech_prob 等字段。

    返回 (干净段, stats)。stats 包含每层删除数,用于 UI 显示。
    """
    stats = {"input": len(raw_segments), "vad": 0, "logprob": 0, "phrases": 0, "repetition": 0, "density": 0, "similarity": 0}

    # 转成 dict 列表方便保留 metadata
    items = [
        {
            "start": float(s["start"]),
            "end": float(s["end"]),
            "text": s.get("text", "").strip(),
            "avg_logprob": float(s.get("avg_logprob", 0.0)),
            "no_speech_prob": float(s.get("no_speech_prob", 0.0)),
            "compression_ratio": float(s.get("compression_ratio", 0.0)),
            "keep": True,
            "drop_reason": None,
        }
        for s in raw_segments
        if s.get("text", "").strip()
    ]

    # --- Layer 1: VAD ---
    speech_ranges = _vad_speech_ranges(audio_path)
    if speech_ranges:
        for it in items:
            mid = (it["start"] + it["end"]) / 2
            if not _in_any_range(mid, speech_ranges):
                it["keep"] = False
                it["drop_reason"] = "vad"
                stats["vad"] += 1

    # --- Layer 3: avg_logprob (低置信丢弃) ---
    LOGPROB_THRESHOLD = -1.0
    for it in items:
        if not it["keep"]:
            continue
        if it["avg_logprob"] != 0.0 and it["avg_logprob"] < LOGPROB_THRESHOLD:
            it["keep"] = False
            it["drop_reason"] = "logprob"
            stats["logprob"] += 1

    # --- Layer 4a: 重复检测 ---
    for it in items:
        if not it["keep"]:
            continue
        if _is_repetitive(it["text"]):
            it["keep"] = False
            it["drop_reason"] = "repetition"
            stats["repetition"] += 1

    # --- Layer 4b: 字符密度异常 ---
    for it in items:
        if not it["keep"]:
            continue
        if _density_anomalous(it["text"], it["start"], it["end"]):
            it["keep"] = False
            it["drop_reason"] = "density"
            stats["density"] += 1

    # --- Layer 4c: 强幻觉短语单段立删 ---
    for it in items:
        if not it["keep"]:
            continue
        if _hits_phrases(it["text"], STRONG_HALLUCINATION_PHRASES):
            it["keep"] = False
            it["drop_reason"] = "phrases"
            stats["phrases"] += 1

    # --- Layer 4d: 弱幻觉短语 ---
    # 规则:连续 ≥2 段命中 → 删;或 单段命中 + 周围 5 秒无说话 → 删(孤立判定)
    n = len(items)
    i = 0
    while i < n:
        if items[i]["keep"] and _hits_phrases(items[i]["text"], WEAK_HALLUCINATION_PHRASES):
            j = i
            while j < n and items[j]["keep"] and _hits_phrases(items[j]["text"], WEAK_HALLUCINATION_PHRASES):
                j += 1
            run = j - i
            if run >= 2:
                # 连续命中删
                for k in range(i, j):
                    items[k]["keep"] = False
                    items[k]["drop_reason"] = "phrases"
                    stats["phrases"] += 1
            elif run == 1:
                # 单段命中,检查孤立:前后段间隔 ≥ 5 秒(被静默包围)→ 删
                cur = items[i]
                prev = next((it for it in reversed(items[:i]) if it["keep"]), None)
                nxt = next((it for it in items[j:] if it["keep"]), None)
                gap_before = cur["start"] - (prev["end"] if prev else 0)
                gap_after = (nxt["start"] if nxt else cur["end"] + 999) - cur["end"]
                if gap_before >= 5 or gap_after >= 5:
                    cur["keep"] = False
                    cur["drop_reason"] = "phrases"
                    stats["phrases"] += 1
            i = j
        else:
            i += 1

    # --- Layer 4e: 段间相似度 ≥ 3 段连续高相似 ---
    for i in range(len(items) - 2):
        if not all(items[i + k]["keep"] for k in range(3)):
            continue
        a, b, c = items[i]["text"], items[i + 1]["text"], items[i + 2]["text"]
        if _segment_pair_similar(a, b) and _segment_pair_similar(b, c):
            for k in (i + 1, i + 2):
                items[k]["keep"] = False
                items[k]["drop_reason"] = "similarity"
                stats["similarity"] += 1

    cleaned = [
        Segment(start=it["start"], end=it["end"], text=it["text"])
        for it in items
        if it["keep"]
    ]
    stats["output"] = len(cleaned)
    stats["removed_total"] = stats["input"] - stats["output"]
    return cleaned, stats


# ============================================================================
# Transcriber implementation
# ============================================================================


class MLXTranscriber(Transcriber):
    backend = "mlx"

    last_filter_stats: dict = {}

    def _run(
        self,
        audio: Path,
        options: TranscribeOptions,
        on_progress: ProgressCallback | None,
    ) -> tuple[list[Segment], str | None]:
        import mlx_whisper

        repo = options.model_id or DEFAULT_MODEL
        resolved = _resolve_model_path(repo)
        # 本地路径已找到 → 不再访问网络;否则保留 mlx-whisper 默认行为
        if resolved != repo:
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
        kwargs = {
            "path_or_hf_repo": resolved,
            "language": options.language,
            "word_timestamps": options.word_timestamps,
            # ---- Layer 2: 解码硬化 ----
            "condition_on_previous_text": False,
            "no_speech_threshold": 0.6,
            "compression_ratio_threshold": 2.4,
            "logprob_threshold": -1.0,
        }
        if options.initial_prompt:
            kwargs["initial_prompt"] = options.initial_prompt

        result = mlx_whisper.transcribe(str(audio), **kwargs)
        raw_segments = [s for s in result.get("segments", []) if s.get("text", "").strip()]

        # ---- Layers 1, 3, 4: filter pipeline ----
        if on_progress:
            on_progress({"stage": "post_filter_start", "raw_segments": len(raw_segments)})
        segments, stats = _filter_all_layers(raw_segments, audio)
        self.last_filter_stats = stats

        if on_progress:
            on_progress({
                "stage": "post_filter_done",
                "filter_stats": stats,
            })
            on_progress({"current": len(segments), "total": len(segments), "stage": "done"})

        return segments, result.get("language")
