// 流水线 hook:
// - 自动:只跑转录(快,无网络依赖)
// - 手动:校对 / 排版 通过暴露的函数按需触发(在 ResultTabs 按钮点击时调用)

import { useCallback, useEffect, useRef } from "react";
import { ipc, onProgress } from "../lib/ipc";
import { buildJson, buildSrt, buildTxt, fmtTs } from "../lib/format";
import { useSettings } from "../stores/settings-store";
import { useTasks } from "../stores/tasks-store";

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
  useEffect(() => {
    let unsubT: (() => void) | undefined;
    let unsubC: (() => void) | undefined;
    onProgress("transcribe", (data) => {
      const id = transcribingIdRef.current;
      if (!id) return;
      setProgress(id, {
        current: data.current ?? 0,
        total: data.total ?? 0,
        preview: data.preview,
      });
    }).then((fn) => (unsubT = fn));
    onProgress("correct", (data) => {
      const id = correctingIdRef.current;
      if (!id) return;
      setProgress(id, {
        current: data.current ?? 0,
        total: data.total ?? 0,
      });
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
  const runningRef = useRef(false);
  useEffect(() => {
    if (runningRef.current) return;
    const next = tasks.find((t) => t.stage === "queued");
    if (!next) return;
    runningRef.current = true;

    (async () => {
      try {
        transcribingIdRef.current = next.id;
        setStage(next.id, "transcribing");
        setProgress(next.id, { current: 0, total: 1 });
        const result = await ipc.transcribe({
          audio: next.audio,
          backend: settings.backend,
          model_id: settings.model_id,
          language: settings.language,
        });
        setResult(next.id, result);
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
        setError(next.id, String(e));
      } finally {
        transcribingIdRef.current = null;
        runningRef.current = false;
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

export type PipelineActions = ReturnType<typeof usePipeline>;
