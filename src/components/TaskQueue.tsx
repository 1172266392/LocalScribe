import clsx from "clsx";
import { useTasks, type Task, type TaskStage } from "../stores/tasks-store";
import { fmtDuration } from "../lib/format";
import { cancelCorrection, pauseCorrection, resumeCorrection } from "../hooks/usePipeline";
import {
  Check,
  Close,
  FileText,
  Hourglass,
  Pause,
  Play,
  Trash,
  Warning,
} from "./Icons";

const STAGE_LABEL: Record<TaskStage, string> = {
  queued: "等待",
  transcribing: "转录",
  transcribed: "转录完成",
  correcting: "校对",
  correcting_paused: "暂停",
  corrected: "校对完成",
  polishing: "排版",
  polished: "完成",
  error: "失败",
  cancelled: "取消",
};

const STAGE_COLOR: Record<TaskStage, string> = {
  queued: "text-fg-mute",
  transcribing: "text-accent",
  transcribed: "text-fg-dim",
  correcting: "text-warn",
  correcting_paused: "text-warn/70",
  corrected: "text-fg-dim",
  polishing: "text-ok",
  polished: "text-ok",
  error: "text-err",
  cancelled: "text-fg-mute",
};

function StageIcon({ stage, className }: { stage: TaskStage; className?: string }) {
  if (stage === "transcribing" || stage === "correcting" || stage === "polishing")
    return <Hourglass size={11} className={className} />;
  if (stage === "transcribed" || stage === "corrected" || stage === "polished")
    return <Check size={11} className={className} />;
  if (stage === "correcting_paused") return <Pause size={11} className={className} />;
  if (stage === "error") return <Warning size={11} className={className} />;
  return <span className={`inline-block w-2 h-2 rounded-full bg-current ${className ?? ""}`} />;
}

function progressPct(t: Task): number {
  if (!t.progress.total) return 0;
  return Math.min(100, Math.round((t.progress.current / t.progress.total) * 100));
}

export default function TaskQueue() {
  const tasks = useTasks((s) => s.tasks);
  const activeId = useTasks((s) => s.activeId);
  const setActive = useTasks((s) => s.setActive);
  const remove = useTasks((s) => s.remove);
  const clearAll = useTasks((s) => s.clearAll);

  if (tasks.length === 0) {
    return (
      <div className="px-3 py-2 text-ui-sm text-fg-mute">
        还没有任务。从上方拖入或选择文件。
      </div>
    );
  }

  return (
    <div className="text-ui">
      {tasks.map((t) => {
        const pct = progressPct(t);
        const isActive = activeId === t.id;
        const showProgress =
          t.stage === "transcribing" || t.stage === "correcting" || t.stage === "polishing";
        return (
          <div
            key={t.id}
            onClick={() => setActive(t.id)}
            className={clsx(
              "list-item flex-col items-stretch py-1.5",
              isActive && "list-item-active",
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={12} className="text-fg-mute shrink-0" />
              <span className="flex-1 min-w-0 truncate font-mono text-ui">{t.filename}</span>
              <span className={clsx("flex items-center gap-1 text-ui-sm shrink-0", STAGE_COLOR[t.stage])}>
                <StageIcon stage={t.stage} />
                {STAGE_LABEL[t.stage]}
                {showProgress && ` ${pct}%`}
              </span>
            </div>

            {showProgress && (
              <div className="mt-1 h-[3px] rounded bg-border/60 overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}

            {t.progress.preview && t.stage === "transcribing" && (
              <div className="mt-1 text-ui-sm text-fg-mute truncate">{t.progress.preview}</div>
            )}

            {t.result && (
              <>
                <div className="mt-0.5 text-ui-sm text-fg-mute">
                  {fmtDuration(t.result.duration)} · {t.result.segments.length} 段 · RTF {t.result.rtf.toFixed(3)}
                </div>
                {t.result.filter_stats && (t.result.filter_stats.removed_total ?? 0) > 0 && (
                  <div className="mt-0.5 text-ui-sm text-warn/80" title={JSON.stringify(t.result.filter_stats, null, 2)}>
                    已过滤幻觉 {t.result.filter_stats.removed_total} 段
                    {t.result.filter_stats.vad ? ` · VAD ${t.result.filter_stats.vad}` : ""}
                    {t.result.filter_stats.logprob ? ` · 低置信 ${t.result.filter_stats.logprob}` : ""}
                    {t.result.filter_stats.repetition ? ` · 重复 ${t.result.filter_stats.repetition}` : ""}
                    {t.result.filter_stats.phrases ? ` · 黑词 ${t.result.filter_stats.phrases}` : ""}
                    {t.result.filter_stats.density ? ` · 密度异常 ${t.result.filter_stats.density}` : ""}
                    {t.result.filter_stats.similarity ? ` · 相似 ${t.result.filter_stats.similarity}` : ""}
                  </div>
                )}
              </>
            )}

            {t.error && (
              <div className="mt-1 text-ui-sm text-err truncate" title={t.error}>{t.error}</div>
            )}

            <div className="mt-1 flex items-center gap-0.5">
              {t.stage === "correcting" && (
                <>
                  <ToolbarBtn icon={<Pause size={11} />} label="暂停" onClick={() => pauseCorrection(t.id)} />
                  <ToolbarBtn icon={<Close size={11} />} label="取消" onClick={() => cancelCorrection(t.id)} className="hover:text-err" />
                </>
              )}
              {t.stage === "correcting_paused" && (
                <>
                  <ToolbarBtn icon={<Play size={11} />} label="继续" onClick={() => resumeCorrection(t.id)} className="text-ok hover:text-ok" />
                  <ToolbarBtn icon={<Close size={11} />} label="取消" onClick={() => cancelCorrection(t.id)} className="hover:text-err" />
                </>
              )}
              <span className="flex-1" />
              <ToolbarBtn
                icon={<Trash size={11} />}
                label="删除"
                onClick={() => remove(t.id)}
                className="hover:text-err"
              />
            </div>
          </div>
        );
      })}

      {tasks.length > 1 && (
        <div className="px-3 py-1.5 border-t border-border/60">
          <button onClick={clearAll} className="btn-ghost h-6 text-ui-sm">
            <Trash size={11} /> 清空队列
          </button>
        </div>
      )}
    </div>
  );
}

function ToolbarBtn({
  icon,
  label,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={clsx("flex items-center gap-1 px-1.5 h-5 text-ui-sm text-fg-mute hover:text-fg rounded-sm hover:bg-hover", className)}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
