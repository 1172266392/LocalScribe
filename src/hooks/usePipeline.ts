// 流水线 hook:
// - 自动:只跑转录(快,无网络依赖)
// - 手动:校对 / 排版 通过暴露的函数按需触发(在 ResultTabs 按钮点击时调用)

import { useCallback, useEffect, useRef } from "react";
import { ipc, onProgress } from "../lib/ipc";
import { buildJson, buildSrt, buildTxt, fmtTs } from "../lib/format";
import { useSettings } from "../stores/settings-store";
import { useTasks } from "../stores/tasks-store";

// 模块级流水线状态 —— hook 和外部的 cancelTask() 共享同一份。
// 为什么不用 useRef:cancelTask 是独立 export 的函数(在 ResultTabs / TaskQueue 里调),
// 它必须能复位 running 标志,否则点取消后 runningRef 永远是 true,新任务卡在 "等待"。
const pipelineState = {
  /** 是否正在跑转录(全局唯一,Python sidecar 单进程串行) */
  running: false,
  /** 已被用户取消的 task id 集合 —— 流水线 async 块每 await 完检查,命中就丢结果 */
  cancelledIds: new Set<string>(),
};

export function usePipeline() {
  const tasks = useTasks((s) => s.tasks);
  const setStage = useTasks((s) => s.setStage);
  const setProgress = useTasks((s) => s.setProgress);
  const setResult = useTasks((s) => s.setResult);
  const setCorrected = useTasks((s) => s.setCorrected);
  const setPolished = useTasks((s) => s.setPolished);
  const setError = useTasks((s) => s.setError);

  const settings = useSettings((s) => s.settings);

  const transcribingIdRef = useRef<string | null>(null);
  const correctingIdRef = useRef<string | null>(null);

  // Forward sidecar progress events to whichever task is currently running.
  // 关键:统一单位到 0-100 百分比。伪进度(下方 useEffect)也是 0-100,这样两者
  // 不会因为 total 字段含义切换(分块数 vs 100)而导致 UI 反复跳。
  // 同时不允许进度倒退(防止 fake 估算偏大后被真值暴跌覆盖)。
  useEffect(() => {
    let unsubT: (() => void) | undefined;
    let unsubC: (() => void) | undefined;
    onProgress("transcribe", (data) => {
      const id = transcribingIdRef.current;
      if (!id) return;
      const cur = data.current ?? 0;
      const tot = data.total ?? 0;
      const pct = tot > 0 ? Math.min(100, Math.round((cur / tot) * 100)) : 0;
      const prev = useTasks.getState().tasks.find((t) => t.id === id)?.progress;
      const prevPct = prev && prev.total === 100 ? prev.current : 0;
      if (pct < prevPct) return; // 不倒退
      setProgress(id, { current: pct, total: 100, preview: data.preview });
    }).then((fn) => (unsubT = fn));
    onProgress("correct", (data) => {
      const id = correctingIdRef.current;
      if (!id) return;
      const cur = data.current ?? 0;
      const tot = data.total ?? 0;
      const pct = tot > 0 ? Math.min(100, Math.round((cur / tot) * 100)) : 0;
      const prev = useTasks.getState().tasks.find((t) => t.id === id)?.progress;
      const prevPct = prev && prev.total === 100 ? prev.current : 0;
      if (pct < prevPct) return;
      setProgress(id, { current: pct, total: 100 });
    }).then((fn) => (unsubC = fn));
    return () => {
      unsubT?.();
      unsubC?.();
    };
  }, [setProgress]);

  // Pseudo-progress for MLX (which doesn't emit per-segment events). Estimates
  // expected runtime from audio duration × RTF and animates progress so the
  // UI doesn't sit at 0%. Real progress events override.
  useEffect(() => {
    const t = tasks.find((x) => x.stage === "transcribing");
    if (!t) return;
    let cancelled = false;
    let interval: number | null = null;

    (async () => {
      let estDurationS = 60;
      try {
        const probe = await ipc.probeAudio(t.audio);
        estDurationS = probe.duration || 60;
      } catch {
        // ignore — keep fallback
      }
      if (cancelled) return;
      // 估算总耗时 = 音频时长 × 0.025 (MLX RTF) + 1.5s 模型加载缓冲
      const estCostMs = estDurationS * 25 + 1500;
      const startTs = Date.now();
      interval = window.setInterval(() => {
        const cur = useTasks.getState().tasks.find((x) => x.id === t.id);
        if (!cur || cur.stage !== "transcribing") {
          if (interval) window.clearInterval(interval);
          interval = null;
          return;
        }
        const elapsedMs = Date.now() - startTs;
        // 95% asymptote — don't reach 100 before real result
        const fakeFraction = 1 - Math.exp(-elapsedMs / estCostMs);
        const fakePct = Math.min(95, Math.round(fakeFraction * 95));
        const realFracPct =
          cur.progress.total > 0
            ? Math.round((cur.progress.current / cur.progress.total) * 100)
            : 0;
        if (realFracPct >= fakePct) return;
        setProgress(t.id, {
          current: fakePct,
          total: 100,
          preview: cur.progress.preview,
        });
      }, 400);
    })();

    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
    };
  }, [tasks, setProgress]);

  // Auto-run transcription only — LLM stages are now opt-in via buttons.
  useEffect(() => {
    if (pipelineState.running) return;
    const next = tasks.find((t) => t.stage === "queued");
    if (!next) return;
    pipelineState.running = true;
    const taskId = next.id;

    // 取消短路:如果任务在 await 期间被 cancelTask 标记,丢弃后续写回。
    // (Python 那边的活儿还会跑完 —— 单进程 sidecar 没法中途打断 —— 但结果不会污染 UI 和 library。)
    const isCancelled = () => pipelineState.cancelledIds.has(taskId);

    (async () => {
      try {
        transcribingIdRef.current = taskId;
        setStage(taskId, "transcribing");
        setProgress(taskId, { current: 0, total: 1 });
        const result = await ipc.transcribe({
          audio: next.audio,
          backend: settings.backend,
          model_id: settings.model_id,
          language: settings.language,
        });
        if (isCancelled()) return;

        // Optional diarization — run after transcribe, before save.
        const diar = settings.diarization;
        if (diar?.enabled && result.segments.length > 0) {
          try {
            setStage(taskId, "diarizing");
            const dr = await ipc.diarize({
              audio: next.audio,
              segments: result.segments,
              n_speakers: diar.n_speakers,
              profiles: diar.speakers,
            });
            if (isCancelled()) return;
            // Merge speaker labels back into segments by index
            for (let i = 0; i < result.segments.length && i < dr.segments.length; i++) {
              result.segments[i].speaker = dr.segments[i].speaker;
            }
          } catch (e) {
            console.warn("diarize failed (continuing without speaker labels)", e);
          }
        }

        setResult(taskId, result);
        // Auto-persist raw transcription to library (transcripts/<stem>/).
        const stem = next.filename.replace(/\.[^.]+$/, "");
        try {
          await ipc.librarySaveRaw({
            stem,
            audio_filename: next.filename,
            txt: buildTxt(result.segments, `${next.filename}\nbackend=${result.backend} duration=${result.duration.toFixed(1)}s segments=${result.segments.length}`),
            srt: buildSrt(result.segments),
            json: buildJson(result),
            result,
          });
        } catch (e) {
          console.warn("library_save_raw failed", e);
        }
      } catch (e) {
        if (!isCancelled()) setError(taskId, String(e));
      } finally {
        pipelineState.cancelledIds.delete(taskId);
        transcribingIdRef.current = null;
        pipelineState.running = false;
      }
    })();
  }, [tasks, settings, setStage, setProgress, setResult, setError]);

  /** 触发对某个已转录任务的 LLM 校对。返回成功与否的 Promise。 */
  const runCorrection = useCallback(
    async (taskId: string) => {
      const task = useTasks.getState().tasks.find((t) => t.id === taskId);
      if (!task?.result) {
        throw new Error("任务尚未完成转录");
      }
      try {
        correctingIdRef.current = taskId;
        setStage(taskId, "correcting");
        setProgress(taskId, { current: 0, total: task.result.segments.length });
        const cor = await ipc.correctSegments({
          segments: task.result.segments,
          provider: settings.correction.provider,
          base_url: settings.correction.base_url,
          model: settings.correction.model,
          mode: settings.correction.mode,
          batch_size: settings.correction.batch_size,
          context_hint: settings.correction.context_hint,
          use_glossary: settings.correction.use_glossary,
          concurrency: settings.correction.concurrency,
          temperature: settings.correction.advanced.temperature,
          max_tokens: settings.correction.advanced.max_tokens,
          top_p: settings.correction.advanced.top_p,
          frequency_penalty: settings.correction.advanced.frequency_penalty,
          presence_penalty: settings.correction.advanced.presence_penalty,
          language: task.result.language || settings.language || undefined,
        });
        if (cor.cancelled) {
          // 用户取消:仍然保存已完成的部分
          setCorrected(taskId, {
            segments: cor.segments,
            changed: cor.changed,
            total: cor.total,
            model: cor.model,
            glossary: cor.glossary,
          });
          setStage(taskId, "cancelled");
          return;
        }
        setCorrected(taskId, {
          segments: cor.segments,
          changed: cor.changed,
          total: cor.total,
          model: cor.model,
          glossary: cor.glossary,
        });
        // Auto-persist corrected outputs.
        const stem = task.filename.replace(/\.[^.]+$/, "");
        const diffLines: string[] = [`# diff: ${cor.changed} changes / ${cor.total} segments`, ""];
        for (const s of cor.segments) {
          if (s.original_text && s.text !== s.original_text) {
            diffLines.push(`[${fmtTs(s.start)}]\n  - ${s.original_text}\n  + ${s.text}\n`);
          }
        }
        try {
          await ipc.librarySaveCorrected({
            stem,
            txt: buildTxt(cor.segments, `${stem} (corrected by ${cor.model})`),
            srt: buildSrt(cor.segments),
            json: JSON.stringify(
              {
                stem,
                corrected_by: cor.model,
                changed: cor.changed,
                total: cor.total,
                glossary: cor.glossary,
                segments: cor.segments,
              },
              null,
              2,
            ),
            diff: diffLines.join("\n"),
            model: cor.model,
            changed: cor.changed,
            total: cor.total,
            glossary: cor.glossary,
          });
        } catch (e) {
          console.warn("library_save_corrected failed", e);
        }
      } catch (e) {
        setError(taskId, String(e));
        throw e;
      } finally {
        correctingIdRef.current = null;
      }
    },
    [settings, setStage, setProgress, setCorrected, setError],
  );

  /** 触发对某个任务的整篇排版。优先用校对后的 segments,没有就用原始转录。 */
  const runPolish = useCallback(
    async (taskId: string) => {
      const task = useTasks.getState().tasks.find((t) => t.id === taskId);
      if (!task?.result) {
        throw new Error("任务尚未完成转录");
      }
      const source: "corrected" | "raw" = task.corrected ? "corrected" : "raw";
      const segments = task.corrected?.segments ?? task.result.segments;
      try {
        setStage(taskId, "polishing");
        const pol = await ipc.polishArticle({
          segments,
          provider: settings.correction.provider,
          base_url: settings.correction.base_url,
          model: settings.polish.model,
          temperature: settings.polish.advanced.temperature,
          max_tokens: settings.polish.advanced.max_tokens,
          top_p: settings.polish.advanced.top_p,
          frequency_penalty: settings.polish.advanced.frequency_penalty,
          presence_penalty: settings.polish.advanced.presence_penalty,
        });
        setPolished(taskId, {
          text: pol.text,
          model: pol.model,
          source,
          truncated: pol.truncated,
          finish_reason: pol.finish_reason,
          input_chars: pol.input_chars,
        });
        const stem = task.filename.replace(/\.[^.]+$/, "");
        try {
          await ipc.librarySavePolished({ stem, text: pol.text, model: pol.model, source });
        } catch (e) {
          console.warn("library_save_polished failed", e);
        }
      } catch (e) {
        setError(taskId, String(e));
        throw e;
      }
    },
    [settings, setStage, setPolished, setError],
  );

  /** 一键链式跑完 LLM 校对 → 整篇排版。校对失败/取消则不再排版。 */
  const runPipelineFull = useCallback(
    async (taskId: string) => {
      try {
        await runCorrection(taskId);
      } catch {
        return;
      }
      const after = useTasks.getState().tasks.find((t) => t.id === taskId);
      if (after?.stage !== "corrected") return;
      try {
        await runPolish(taskId);
      } catch {
        // already surfaces via stage="error"
      }
    },
    [runCorrection, runPolish],
  );

  // Auto-pipeline:转录完成后,如果设置开了"自动跑完整流水线"且 LLM 已启用,自动接力校对 + 排版。
  const autoTriggeredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!settings.correction.enabled) return;
    if (!settings.correction.auto_pipeline) return;
    const t = tasks.find(
      (x) => x.stage === "transcribed" && !autoTriggeredRef.current.has(x.id),
    );
    if (!t) return;
    autoTriggeredRef.current.add(t.id);
    runPipelineFull(t.id).catch(() => {});
  }, [tasks, settings.correction.enabled, settings.correction.auto_pipeline, runPipelineFull]);

  return { runCorrection, runPolish, runPipelineFull };
}

// Standalone control actions — safe to call from anywhere (no React state).
export async function pauseCorrection(taskId: string): Promise<void> {
  const cur = useTasks.getState().tasks.find((t) => t.id === taskId);
  if (cur?.stage !== "correcting") return;
  try {
    await ipc.correctPause();
    useTasks.getState().setStage(taskId, "correcting_paused");
  } catch (e) {
    console.warn("pause failed", e);
  }
}

export async function resumeCorrection(taskId: string): Promise<void> {
  const cur = useTasks.getState().tasks.find((t) => t.id === taskId);
  if (cur?.stage !== "correcting_paused") return;
  try {
    await ipc.correctResume();
    useTasks.getState().setStage(taskId, "correcting");
  } catch (e) {
    console.warn("resume failed", e);
  }
}

export async function cancelCorrection(_taskId: string): Promise<void> {
  try {
    await ipc.correctCancel();
    // runCorrection's promise resolves with cancelled=true → stage flips to "cancelled".
  } catch (e) {
    console.warn("cancel failed", e);
  }
}

export function cancelTask(taskId: string): void {
  const cur = useTasks.getState().tasks.find((t) => t.id === taskId);
  if (!cur) return;

  // For stages that support cancellation
  const cancellableStages = ["transcribing", "diarizing", "correcting", "correcting_paused", "polishing", "translating"];

  if (!cancellableStages.includes(cur.stage)) return;

  // For correction, use the proper cancel API (Python sidecar 有真正的取消通道)
  if (cur.stage === "correcting" || cur.stage === "correcting_paused") {
    cancelCorrection(taskId);
    return;
  }

  // 其它阶段:Python 端没有取消机制,我们做"前端层取消":
  //   1. 标记 cancelledIds,让流水线 async 块完成后丢结果(不写回 store / library)
  //   2. 立即把 running 标志归位,新任务能马上进入流水线
  //      (新任务发的 transcribe 命令会在 Python 端排队,等老任务跑完再处理)
  //   3. UI 直接显示 cancelled
  pipelineState.cancelledIds.add(taskId);
  pipelineState.running = false;
  useTasks.getState().setStage(taskId, "cancelled");
  useTasks.getState().setError(taskId, "用户取消");
}

export type PipelineActions = ReturnType<typeof usePipeline>;
