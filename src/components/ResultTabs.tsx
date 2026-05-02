import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import clsx from "clsx";

import { buildJson, buildMd, buildSrt, buildTxt, fmtDuration } from "../lib/format";
import type { Segment } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useSettings } from "../stores/settings-store";
import { type Task, useTasks } from "../stores/tasks-store";
import { Article, Check, Copy, Download, FileText, Hourglass, Lock, Pencil, Refresh } from "./Icons";
import PinArticleDialog from "./PinArticleDialog";

type Tab = "raw" | "corrected" | "article";
type ViewMode = "timeline" | "dialog";

const TAB_META: Record<Tab, { label: string; icon: React.ReactNode }> = {
  raw: { label: "原文", icon: <FileText size={13} /> },
  corrected: { label: "校对", icon: <Pencil size={13} /> },
  article: { label: "文章", icon: <Article size={13} /> },
};

// VSCode-friendly palette,8 路循环
const SPEAKER_PALETTE = [
  "text-sky-300 border-sky-300/40 bg-sky-500/10",
  "text-orange-300 border-orange-300/40 bg-orange-500/10",
  "text-emerald-300 border-emerald-300/40 bg-emerald-500/10",
  "text-pink-300 border-pink-300/40 bg-pink-500/10",
  "text-violet-300 border-violet-300/40 bg-violet-500/10",
  "text-yellow-300 border-yellow-300/40 bg-yellow-500/10",
  "text-cyan-300 border-cyan-300/40 bg-cyan-500/10",
  "text-rose-300 border-rose-300/40 bg-rose-500/10",
];

function collectSpeakers(segments: Segment[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    if (s.speaker && !out.includes(s.speaker)) out.push(s.speaker);
  }
  return out;
}
function speakerChipClass(speakers: string[], who: string): string {
  const idx = speakers.indexOf(who);
  return SPEAKER_PALETTE[idx >= 0 ? idx % SPEAKER_PALETTE.length : 0];
}

/** 把连续 ≤ 1.2s 间隔的同一 speaker 段合并成 turn(对话视图用) */
function groupBySpeakerTurns(segments: Segment[]): Array<{
  speaker?: string;
  start: number;
  end: number;
  segments: Segment[];
}> {
  const turns: Array<{ speaker?: string; start: number; end: number; segments: Segment[] }> = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    const sameSpeaker = last && last.speaker === s.speaker;
    const closeInTime = last && s.start - last.end < 1.2;
    if (last && sameSpeaker && closeInTime) {
      last.end = s.end;
      last.segments.push(s);
    } else {
      turns.push({ speaker: s.speaker, start: s.start, end: s.end, segments: [s] });
    }
  }
  return turns;
}

type Props = {
  task: Task;
  onCorrect: () => Promise<void> | void;
  onPolish: () => Promise<void> | void;
  onPipelineFull: () => Promise<void> | void;
  onOpenSettings: () => void;
  onArticleSaved?: () => void;
};

export default function ResultTabs({ task, onCorrect, onPolish, onPipelineFull, onOpenSettings, onArticleSaved }: Props) {
  const [tab, setTab] = useState<Tab>("raw");
  const hasCorrected = !!task.corrected;
  const hasPolished = !!task.polished;
  const setResult = useTasks((s) => s.setResult);
  const setCorrected = useTasks((s) => s.setCorrected);

  // Auto-jump to the most informative tab when new data arrives.
  useEffect(() => {
    if (hasPolished) setTab("article");
    else if (hasCorrected) setTab("corrected");
  }, [hasPolished, hasCorrected]);

  const result = task.result;

  // 有 speaker → 默认对话视图;没有 → 时间戳列表
  const hasSpeakers = (result?.segments ?? []).some((s) => !!s.speaker);
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  useEffect(() => {
    setViewMode(hasSpeakers ? "dialog" : "timeline");
  }, [hasSpeakers]);

  /** 全局重命名说话人 — 所有 raw/corrected segments 中 speaker===oldName 的都替换为 newName,
      并把改动写回 raw/corrected JSON 持久化。 */
  const renameSpeaker = async (oldName: string, newName: string) => {
    if (!result) return;
    const renameSeg = (s: Segment): Segment =>
      s.speaker === oldName ? { ...s, speaker: newName } : s;

    // 1. raw segments
    const newSegs = result.segments.map(renameSeg);
    setResult(task.id, { ...result, segments: newSegs });

    // 2. corrected segments(若有)
    if (task.corrected) {
      const newCorrected = task.corrected.segments.map(renameSeg);
      setCorrected(task.id, { ...task.corrected, segments: newCorrected });
    }

    // 3. 持久化到 raw JSON(transcripts/<stem>/<stem>.json)
    const stem = task.filename.replace(/\.[^.]+$/, "");
    try {
      await ipc.librarySaveRaw({
        stem,
        audio_filename: task.filename,
        txt: buildTxt(newSegs, `${task.filename}\nbackend=${result.backend} duration=${result.duration.toFixed(1)}s segments=${newSegs.length}`),
        srt: buildSrt(newSegs),
        json: buildJson({ ...result, segments: newSegs }),
        result: { ...result, segments: newSegs },
      });
    } catch (e) {
      console.warn("rename: save raw failed", e);
    }

    // 4. 持久化到 corrected JSON(若有)
    if (task.corrected) {
      const newCorrSegs = task.corrected.segments.map(renameSeg);
      try {
        await ipc.librarySaveCorrected({
          stem,
          txt: buildTxt(newCorrSegs),
          srt: buildSrt(newCorrSegs),
          json: JSON.stringify({ segments: newCorrSegs.map((s) => ({
            start: s.start, end: s.end, text: s.text,
            original_text: s.original_text, speaker: s.speaker,
          })) }, null, 2),
          diff: "",
          model: task.corrected.model,
          changed: task.corrected.changed,
          total: task.corrected.total,
          glossary: task.corrected.glossary,
        });
      } catch (e) {
        console.warn("rename: save corrected failed", e);
      }
    }
  };

  if (!result) {
    return <div className="text-sm text-text-mute">（转录尚未完成）</div>;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* VSCode-style editor tab bar */}
      <header className="shrink-0 flex items-center justify-between bg-tabbar border-b border-border">
        <div className="flex items-center">
          {(["raw", "corrected", "article"] as Tab[]).map((k) => {
            const isActive = tab === k;
            const isReady =
              k === "raw" || (k === "corrected" && hasCorrected) || (k === "article" && hasPolished);
            return (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={clsx(
                  "btn-tab",
                  isActive && "btn-tab-active",
                  isActive && "bg-editor",
                )}
              >
                {TAB_META[k].icon}
                <span>{TAB_META[k].label}</span>
                {isReady && k !== "raw" && <Check size={10} className="text-ok" />}
              </button>
            );
          })}
        </div>
        <div className="px-3 flex items-center gap-3 text-ui-sm text-fg-mute">
          {hasSpeakers && (
            <div className="inline-flex border border-border rounded-sm overflow-hidden">
              <button
                onClick={() => setViewMode("dialog")}
                className={clsx(
                  "px-2 py-0.5 text-xs",
                  viewMode === "dialog"
                    ? "bg-accent/20 text-accent"
                    : "text-fg-mute hover:text-fg",
                )}
                title="按说话人合并为对话气泡"
              >
                对话
              </button>
              <button
                onClick={() => setViewMode("timeline")}
                className={clsx(
                  "px-2 py-0.5 text-xs border-l border-border",
                  viewMode === "timeline"
                    ? "bg-accent/20 text-accent"
                    : "text-fg-mute hover:text-fg",
                )}
                title="逐段带时间戳"
              >
                时间戳
              </button>
            </div>
          )}
          <span>
            {result.backend} · {fmtDuration(result.duration)} · {result.segments.length} 段
          </span>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto px-6 py-4 bg-editor">
        {tab === "raw" && (
          <RawTabContent task={task} viewMode={viewMode} onRenameSpeaker={renameSpeaker} />
        )}
        {tab === "corrected" &&
          (hasCorrected ? (
            <CorrectedSegments
              segments={task.corrected!.segments}
              changed={task.corrected!.changed}
              total={task.corrected!.total}
              model={task.corrected!.model}
              viewMode={viewMode}
              onRenameSpeaker={renameSpeaker}
            />
          ) : (
            <CorrectionCTA
              busy={task.stage === "correcting"}
              onCorrect={onCorrect}
              onPipelineFull={onPipelineFull}
              onOpenSettings={onOpenSettings}
            />
          ))}
        {tab === "article" &&
          (hasPolished ? (
            <ArticleView
              text={task.polished!.text}
              model={task.polished!.model}
              source={task.polished!.source}
              truncated={task.polished!.truncated}
              inputChars={task.polished!.input_chars}
            />
          ) : (
            <PolishCTA
              busy={task.stage === "polishing"}
              hasCorrected={hasCorrected}
              onPolish={onPolish}
              onOpenSettings={onOpenSettings}
            />
          ))}
      </div>

      <ExportBar
        task={task}
        tab={tab}
        onCorrect={onCorrect}
        onPolish={onPolish}
        onArticleSaved={onArticleSaved}
      />
    </div>
  );
}

// ============================================================================
// 内容渲染
// ============================================================================

function SpeakerChip({
  speakers,
  who,
  onRename,
}: {
  speakers: string[];
  who?: string;
  onRename?: (oldName: string, newName: string) => void;
}) {
  if (!speakers.length) return null;
  const clickable = !!(who && onRename);
  return (
    <span
      onClick={
        clickable
          ? (e) => {
              e.stopPropagation();
              const next = window.prompt(
                `把 "${who}" 改成什么名字?\n(全局生效:所有标着 ${who} 的段都会一起换)`,
                who,
              );
              if (next && next.trim() && next.trim() !== who) {
                onRename!(who!, next.trim());
              }
            }
          : undefined
      }
      title={clickable ? "点击改名(全局生效)" : undefined}
      className={clsx(
        "shrink-0 px-1.5 py-0.5 rounded-sm border text-xs font-medium whitespace-nowrap select-none",
        who ? speakerChipClass(speakers, who) : "text-fg-mute border-border",
        clickable && "cursor-pointer hover:brightness-125",
      )}
    >
      {who ?? "?"}
    </span>
  );
}

function RawTabContent({ task, viewMode, onRenameSpeaker }: {
  task: Task;
  viewMode: ViewMode;
  onRenameSpeaker?: (oldName: string, newName: string) => void;
}) {
  const segments = task.result!.segments;
  const speakers = collectSpeakers(segments);
  const settings = useSettings((s) => s.settings);
  const setResult = useTasks((s) => s.setResult);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rerun() {
    setError(null);
    setBusy(true);
    try {
      const dr = await ipc.diarize({
        audio: task.audio,
        segments,
        n_speakers: settings.diarization?.n_speakers ?? 0,
        profiles: settings.diarization?.speakers ?? [],
      });
      // 拷一份新数组让 React 知道变了
      const next = segments.map((s, i) => ({
        ...s,
        speaker: dr.segments[i]?.speaker ?? s.speaker,
      }));
      setResult(task.id, { ...task.result!, segments: next });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 pb-2 border-b border-border/60">
        <div className="text-ui-sm text-fg-mute">
          {speakers.length > 0
            ? `识别到 ${speakers.length} 位说话人:` + speakers.join(" · ")
            : "未运行说话人分离 — 点右侧按钮跑一次"}
        </div>
        <button
          onClick={rerun}
          disabled={busy}
          className="btn-ghost flex items-center gap-1.5 text-ui-sm"
          title="不重新转录,只重新识别说话人"
        >
          <Refresh size={12} className={busy ? "animate-spin" : ""} />
          {busy ? "分人中…" : speakers.length > 0 ? "重新跑分人" : "运行说话人分离"}
        </button>
      </div>
      {error && (
        <div className="text-ui-sm text-err bg-err/10 border border-err/30 rounded-sm px-3 py-2">
          {error}
        </div>
      )}
      <RawSegments segments={segments} viewMode={viewMode} onRenameSpeaker={onRenameSpeaker} />
    </div>
  );
}

function RawSegments({ segments, viewMode, onRenameSpeaker }: {
  segments: Segment[];
  viewMode: ViewMode;
  onRenameSpeaker?: (oldName: string, newName: string) => void;
}) {
  const speakers = collectSpeakers(segments);
  const hasSpeakers = speakers.length > 0;

  if (viewMode === "dialog" && hasSpeakers) {
    const turns = groupBySpeakerTurns(segments);
    return (
      <ul className="space-y-3 text-ui leading-relaxed">
        {turns.map((t, i) => (
          <li key={i} className="flex gap-3 min-w-0 group">
            <div className="flex flex-col items-start gap-1 shrink-0">
              <SpeakerChip speakers={speakers} who={t.speaker} onRename={onRenameSpeaker} />
              <span className="text-ui-sm text-fg-mute font-mono">
                {formatTimeShort(t.start)}
              </span>
            </div>
            <div className="flex-1 min-w-0 break-words text-fg">
              {t.segments.map((s) => s.text).join("")}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  // 时间戳模式
  return (
    <ul className="space-y-1 font-mono text-ui leading-relaxed">
      {segments.map((s, i) => (
        <li key={i} className="flex gap-3 min-w-0 group items-start">
          <span className="text-ui-sm text-fg-mute pt-0.5 whitespace-nowrap shrink-0 select-none w-12 text-right">
            {formatTimeShort(s.start)}
          </span>
          {hasSpeakers && <SpeakerChip speakers={speakers} who={s.speaker} onRename={onRenameSpeaker} />}
          <span className="flex-1 min-w-0 break-words text-fg">{s.text}</span>
        </li>
      ))}
    </ul>
  );
}

function CorrectedSegments({
  segments,
  changed,
  total,
  model,
  viewMode,
  onRenameSpeaker,
}: {
  segments: Segment[];
  changed: number;
  total: number;
  model: string;
  viewMode: ViewMode;
  onRenameSpeaker?: (oldName: string, newName: string) => void;
}) {
  const speakers = collectSpeakers(segments);
  const hasSpeakers = speakers.length > 0;

  const header = (
    <div className="text-ui-sm text-fg-mute pb-2 border-b border-border/60">
      模型 <span className="text-fg-dim font-mono">{model}</span> · 改动 {changed}/{total} 段
      <span className="ml-3 text-ok">绿色</span> 为校对后,
      <span className="text-err line-through ml-1">删除线</span> 为原文
    </div>
  );

  if (viewMode === "dialog" && hasSpeakers) {
    const turns = groupBySpeakerTurns(segments);
    return (
      <div className="space-y-3">
        {header}
        <ul className="space-y-3 text-ui leading-relaxed">
          {turns.map((t, i) => {
            const anyChanged = t.segments.some(
              (s) => s.original_text && s.original_text !== s.text,
            );
            return (
              <li key={i} className="flex gap-3 min-w-0">
                <div className="flex flex-col items-start gap-1 shrink-0">
                  <SpeakerChip speakers={speakers} who={t.speaker} onRename={onRenameSpeaker} />
                  <span className="text-ui-sm text-fg-mute font-mono">
                    {formatTimeShort(t.start)}
                  </span>
                </div>
                <div className="flex-1 min-w-0 break-words">
                  <div className={anyChanged ? "text-ok" : "text-fg"}>
                    {t.segments.map((s) => s.text).join("")}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {header}
      <ul className="space-y-1 font-mono text-ui leading-relaxed">
        {segments.map((s, i) => {
          const changedSeg = s.original_text && s.original_text !== s.text;
          return (
            <li key={i} className="flex gap-3 min-w-0 items-start">
              <span className="text-ui-sm text-fg-mute pt-0.5 whitespace-nowrap shrink-0 select-none w-12 text-right">
                {formatTimeShort(s.start)}
              </span>
              {hasSpeakers && <SpeakerChip speakers={speakers} who={s.speaker} onRename={onRenameSpeaker} />}
              <div className="flex-1 min-w-0 break-words">
                {changedSeg && (
                  <div className="text-ui-sm text-err/80 line-through">
                    {s.original_text}
                  </div>
                )}
                <div className={changedSeg ? "text-ok" : "text-fg"}>{s.text}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ArticleView({
  text,
  model,
  source,
  truncated,
  inputChars,
}: {
  text: string;
  model: string;
  source?: "corrected" | "raw";
  truncated?: boolean;
  inputChars?: number;
}) {
  const isCorrected = source === "corrected";
  // Heuristic fallback:LLM 没传 finish_reason 时,根据输入/输出比判断
  const ratio = inputChars && inputChars > 0 ? text.length / inputChars : null;
  const looksTruncated = truncated || (ratio !== null && ratio < 0.7);
  const completenessPct = ratio ? Math.round(ratio * 100) : null;
  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      {/* 顶部:状态徽章 + 元数据 */}
      <div className="flex flex-wrap items-center gap-2 text-ui-sm text-fg-mute pb-2 border-b border-border/60">
        {/* 完整性徽章(主要) */}
        {looksTruncated ? (
          <span className="px-2 py-0.5 rounded-sm border text-ui-sm bg-warn/15 text-warn border-warn/40 font-medium">
            ⚠ 内容不完整(可能被 max_tokens 截断)
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded-sm border text-ui-sm bg-ok/15 text-ok border-ok/40 font-medium">
            ✓ 完整生成
          </span>
        )}
        {/* 来源徽章 */}
        <span
          className={clsx(
            "px-2 py-0.5 rounded-sm border text-ui-sm",
            isCorrected
              ? "bg-ok/10 text-ok border-ok/30"
              : "bg-warn/10 text-warn border-warn/30",
          )}
        >
          {isCorrected ? "基于已校对稿" : "基于原始转录"}
        </span>
        <span>模型 <span className="text-fg-dim font-mono">{model}</span></span>
        <span>·</span>
        <span>{text.length} 字</span>
        {inputChars && (
          <>
            <span>·</span>
            <span>原 {inputChars} 字 ({completenessPct}%)</span>
          </>
        )}
      </div>

      {/* 详细告警条(仅截断时显示,提供补救建议) */}
      {looksTruncated && (
        <div className="bg-warn/5 border border-warn/30 rounded-sm p-3 text-ui-sm text-fg leading-relaxed">
          <div className="font-medium text-warn mb-1">检测到生成内容不完整</div>
          <div className="text-fg-dim">
            原始 {inputChars ?? "?"} 字仅生成了 {text.length} 字
            {completenessPct ? ` (${completenessPct}%)` : ""}。
            可能原因:LLM 输出 token 数被限制截断。
          </div>
          <div className="text-fg-dim mt-1">
            建议:打开 设置 → 校对 → 高级参数 → <span className="font-mono text-fg">排版 · 最大输出</span>,
            提高 <span className="font-mono text-fg">max_tokens</span>(已最大 384000),然后重新点 "整理为文章"。
          </div>
        </div>
      )}

      <article className="text-fg leading-loose whitespace-pre-wrap text-ui-lg">{text}</article>
    </div>
  );
}

// ============================================================================
// CTA 占位(没数据时显示触发按钮 / 提示)
// ============================================================================

function CorrectionCTA({
  busy,
  onCorrect,
  onPipelineFull,
  onOpenSettings,
}: {
  busy: boolean;
  onCorrect: () => Promise<void> | void;
  onPipelineFull: () => Promise<void> | void;
  onOpenSettings: () => void;
}) {
  const enabled = useSettings((s) => s.settings.correction.enabled);
  const hasApiKey = useSettings((s) => s.hasApiKey);
  const provider = useSettings((s) => s.settings.correction.provider);
  const model = useSettings((s) => s.settings.correction.model);

  const [error, setError] = useState<string | null>(null);

  async function trigger() {
    setError(null);
    try {
      await onCorrect();
    } catch (e) {
      setError(String(e));
    }
  }

  if (busy) {
    return (
      <div className="text-ui text-warn py-16 text-center flex flex-col items-center gap-2">
        <Hourglass size={28} />
        <div>正在校对(LLM 调用中)</div>
      </div>
    );
  }

  if (!enabled || !hasApiKey) {
    return (
      <div className="py-12 px-4 text-center flex flex-col items-center gap-3">
        <Pencil size={28} className="text-fg-mute" />
        <div className="text-ui text-fg-dim max-w-md leading-relaxed">
          {!enabled
            ? "未启用 LLM 校对。在设置中开启后可对此转录做字级校对。"
            : `LLM 校对已启用,但 ${provider} 的 API Key 尚未配置。`}
        </div>
        <button onClick={onOpenSettings} className="btn mt-1">前往设置</button>
      </div>
    );
  }

  return (
    <div className="py-12 px-4 text-center flex flex-col items-center gap-3">
      <Pencil size={28} className="text-accent" />
      <div className="text-ui text-fg-dim max-w-md leading-relaxed">
        将转录段落送至 <span className="font-mono text-fg">{model}</span> 做字级校对(修同音字 / 错别字 / ASR 冗余)。
        <br />每段保留原文用于对比。
      </div>
      {error && <div className="text-ui-sm text-err">{error}</div>}
      <div className="flex justify-center gap-2 mt-1">
        <button onClick={trigger} className="btn">开始校对</button>
        <button
          onClick={async () => {
            setError(null);
            try {
              await onPipelineFull();
            } catch (e) {
              setError(String(e));
            }
          }}
          className="btn"
          title="校对完成后自动接力做整篇排版"
        >
          校对 + 排版(一键)
        </button>
        <button onClick={onOpenSettings} className="btn-ghost">设置</button>
      </div>
    </div>
  );
}

function PolishCTA({
  busy,
  hasCorrected,
  onPolish,
  onOpenSettings,
}: {
  busy: boolean;
  hasCorrected: boolean;
  onPolish: () => Promise<void> | void;
  onOpenSettings: () => void;
}) {
  const enabled = useSettings((s) => s.settings.correction.enabled);
  const hasApiKey = useSettings((s) => s.hasApiKey);
  const model = useSettings((s) => s.settings.polish.model);

  const [error, setError] = useState<string | null>(null);

  async function trigger() {
    setError(null);
    try {
      await onPolish();
    } catch (e) {
      setError(String(e));
    }
  }

  if (busy) {
    return (
      <div className="text-ui text-ok py-16 text-center flex flex-col items-center gap-2">
        <Hourglass size={28} />
        <div>正在生成文章</div>
      </div>
    );
  }

  if (!enabled || !hasApiKey) {
    return (
      <div className="py-12 px-4 text-center flex flex-col items-center gap-3">
        <Article size={28} className="text-fg-mute" />
        <div className="text-ui text-fg-dim max-w-md leading-relaxed">
          整篇排版需要 LLM。请先在设置中启用并配置 API Key。
        </div>
        <button onClick={onOpenSettings} className="btn mt-1">前往设置</button>
      </div>
    );
  }

  return (
    <div className="py-12 px-4 text-center flex flex-col items-center gap-3">
      <Article size={28} className="text-accent" />
      <div
        className={clsx(
          "px-2.5 py-1 rounded-sm border text-ui-sm",
          hasCorrected
            ? "bg-ok/10 text-ok border-ok/30"
            : "bg-warn/10 text-warn border-warn/30",
        )}
      >
        {hasCorrected ? "将基于已校对稿生成" : "将基于原始转录生成(未校对)"}
      </div>
      <div className="text-ui text-fg-dim max-w-md leading-relaxed">
        拼成连续散文,自动加标点和分段,输出完整文字稿。模型 <span className="font-mono text-fg">{model}</span>
        {!hasCorrected && (
          <div className="mt-2 text-ui-sm text-fg-mute">
            建议先在「校对」标签运行一次校对,可显著提升排版质量。
          </div>
        )}
      </div>
      {error && <div className="text-ui-sm text-err">{error}</div>}
      <div className="flex justify-center gap-2 mt-1">
        <button onClick={trigger} className="btn">整理为文章</button>
        <button onClick={onOpenSettings} className="btn-ghost">设置</button>
      </div>
    </div>
  );
}

// ============================================================================
// 导出栏
// ============================================================================

function ExportBar({
  task,
  tab,
  onCorrect,
  onPolish,
  onArticleSaved,
}: {
  task: Task;
  tab: Tab;
  onCorrect: () => Promise<void> | void;
  onPolish: () => Promise<void> | void;
  onArticleSaved?: () => void;
}) {
  const isCorrecting = task.stage === "correcting" || task.stage === "correcting_paused";
  const isPolishing = task.stage === "polishing";
  const [pinOpen, setPinOpen] = useState(false);
  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
  }
  async function download(name: string, text: string) {
    const path = await save({
      defaultPath: name,
      filters: [{ name: "All", extensions: ["*"] }],
    });
    if (!path) return;
    await writeTextFile(path, text);
  }

  const stem = task.filename.replace(/\.[^.]+$/, "");
  const result = task.result!;
  const segments =
    tab === "corrected" && task.corrected ? task.corrected.segments : result.segments;

  // For the article tab when polished is missing, no export buttons make sense.
  if (tab === "article" && !task.polished) {
    return null;
  }
  // For corrected tab when no correction yet, hide too.
  if (tab === "corrected" && !task.corrected) {
    return null;
  }

  return (
    <div className="shrink-0 flex items-center gap-1 px-3 h-9 border-t border-border/60 bg-tabbar/60">
      {tab === "article" && task.polished ? (
        <>
          <ActionBtn icon={<Copy size={12} />} label="复制全文" onClick={() => copy(task.polished!.text)} />
          <ActionBtn icon={<Download size={12} />} label=".txt" onClick={() => download(`${stem}_完整版.txt`, task.polished!.text)} />
          <ActionBtn
            icon={<Download size={12} />}
            label=".md"
            onClick={() => {
              const meta = task.polished!.source === "corrected" ? "校对+排版" : "原文+排版";
              const md = `# ${stem}\n\n> _${meta} · ${task.polished!.model} · ${task.polished!.text.length} 字_\n\n${task.polished!.text}\n`;
              download(`${stem}_完整版.md`, md);
            }}
          />
          <span className="mx-1 h-4 w-px bg-border" />
          <ActionBtn
            icon={<Lock size={12} />}
            label="保存到文章库"
            onClick={() => setPinOpen(true)}
            title="保存为带语义化文件名的 markdown,AI agent 可通过 articles/ 读取"
          />
          <ActionBtn
            icon={<Refresh size={12} />}
            label={isPolishing ? "排版中..." : "重新生成"}
            onClick={() => onPolish()}
            disabled={isPolishing}
            title="重新跑一遍排版(基于当前校对稿/原文)"
          />
        </>
      ) : (
        <>
          <ActionBtn icon={<Copy size={12} />} label="复制(带时间戳)" onClick={() => copy(buildTxt(segments))} />
          <ActionBtn icon={<Copy size={12} />} label="复制纯文本" onClick={() => copy(segments.map((s) => s.text).join(""))} />
          <span className="mx-1 h-4 w-px bg-border" />
          <ActionBtn icon={<Download size={12} />} label=".txt" onClick={() => download(`${stem}${tab === "corrected" ? "_corrected" : ""}.txt`, buildTxt(segments, `${stem} (${tab})`))} />
          <ActionBtn icon={<Download size={12} />} label=".srt" onClick={() => download(`${stem}${tab === "corrected" ? "_corrected" : ""}.srt`, buildSrt(segments))} />
          <ActionBtn icon={<Download size={12} />} label=".md" onClick={() => download(`${stem}.md`, buildMd(segments, stem))} />
          <ActionBtn icon={<Download size={12} />} label=".json" onClick={() => download(`${stem}.json`, buildJson(result))} />
          {tab === "corrected" && task.corrected && (
            <>
              <span className="mx-1 h-4 w-px bg-border" />
              <ActionBtn
                icon={<Refresh size={12} />}
                label={isCorrecting ? "校对中..." : "重新校对"}
                onClick={() => onCorrect()}
                disabled={isCorrecting}
                title="重新跑一遍校对(覆盖当前结果)"
              />
            </>
          )}
        </>
      )}

      {pinOpen && task.polished && (
        <PinArticleDialog
          defaultTitle={stem}
          content={task.polished.text}
          source_audio={task.audio}
          source_stem={stem}
          duration_seconds={task.result?.duration}
          model={task.polished.model}
          based_on={task.polished.source}
          onClose={(saved) => {
            setPinOpen(false);
            if (saved) onArticleSaved?.();
          }}
        />
      )}
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="btn-ghost h-6 px-2 text-ui-sm"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function formatTimeShort(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
