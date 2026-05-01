import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import clsx from "clsx";

import { buildJson, buildMd, buildSrt, buildTxt, fmtDuration } from "../lib/format";
import type { Segment } from "../lib/ipc";
import { useSettings } from "../stores/settings-store";
import type { Task } from "../stores/tasks-store";
import { Article, Check, Copy, Download, FileText, Hourglass, Lock, Pencil, Refresh } from "./Icons";
import PinArticleDialog from "./PinArticleDialog";

type Tab = "raw" | "corrected" | "article";

const TAB_META: Record<Tab, { label: string; icon: React.ReactNode }> = {
  raw: { label: "原文", icon: <FileText size={13} /> },
  corrected: { label: "校对", icon: <Pencil size={13} /> },
  article: { label: "文章", icon: <Article size={13} /> },
};

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

  // Auto-jump to the most informative tab when new data arrives.
  useEffect(() => {
    if (hasPolished) setTab("article");
    else if (hasCorrected) setTab("corrected");
  }, [hasPolished, hasCorrected]);

  const result = task.result;
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
        <div className="px-3 text-ui-sm text-fg-mute">
          {result.backend} · {fmtDuration(result.duration)} · {result.segments.length} 段
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto px-6 py-4 bg-editor">
        {tab === "raw" && <RawSegments segments={result.segments} />}
        {tab === "corrected" &&
          (hasCorrected ? (
            <CorrectedSegments
              segments={task.corrected!.segments}
              changed={task.corrected!.changed}
              total={task.corrected!.total}
              model={task.corrected!.model}
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

function RawSegments({ segments }: { segments: Segment[] }) {
  return (
    <ul className="space-y-1 font-mono text-ui leading-relaxed">
      {segments.map((s, i) => (
        <li key={i} className="flex gap-3 min-w-0 group">
          <span className="text-ui-sm text-fg-mute pt-0.5 whitespace-nowrap shrink-0 select-none w-12 text-right">
            {formatTimeShort(s.start)}
          </span>
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
}: {
  segments: Segment[];
  changed: number;
  total: number;
  model: string;
}) {
  return (
    <div className="space-y-3">
      <div className="text-ui-sm text-fg-mute pb-2 border-b border-border/60">
        模型 <span className="text-fg-dim font-mono">{model}</span> · 改动 {changed}/{total} 段
        <span className="ml-3 text-ok">绿色</span> 为校对后,
        <span className="text-err line-through ml-1">删除线</span> 为原文
      </div>
      <ul className="space-y-1 font-mono text-ui leading-relaxed">
        {segments.map((s, i) => {
          const changedSeg = s.original_text && s.original_text !== s.text;
          return (
            <li key={i} className="flex gap-3 min-w-0">
              <span className="text-ui-sm text-fg-mute pt-0.5 whitespace-nowrap shrink-0 select-none w-12 text-right">
                {formatTimeShort(s.start)}
              </span>
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
