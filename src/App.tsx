import { useEffect, useMemo, useState } from "react";

import ArticlesPanel from "./components/ArticlesPanel";
import ArticleViewer from "./components/ArticleViewer";
import DropZone from "./components/DropZone";
import DuplicateFileDialog, { type DuplicateChoice } from "./components/DuplicateFileDialog";
import type { ArticleMeta, LibraryMeta } from "./lib/ipc";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Hourglass,
  Pause,
  Settings as SettingsIcon,
  Sparkle,
  Warning,
} from "./components/Icons";
import LibraryPanel from "./components/LibraryPanel";
import Logo from "./components/Logo";
import ResultTabs from "./components/ResultTabs";
import SettingsDialog from "./components/SettingsDialog";
import TaskQueue from "./components/TaskQueue";
import { usePipeline } from "./hooks/usePipeline";
import { ipc, type EnvironmentInfo, type ModelStatus } from "./lib/ipc";
import { useSettings } from "./stores/settings-store";
import { useTasks } from "./stores/tasks-store";

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{
    path: string;
    filename: string;
    existing: LibraryMeta;
    queued: string[];
  } | null>(null);
  const [activeArticle, setActiveArticle] = useState<ArticleMeta | null>(null);
  const [articlesRefresh, setArticlesRefresh] = useState(0);

  const loadSettings = useSettings((s) => s.loadFromBackend);
  const tasks = useTasks((s) => s.tasks);
  const activeId = useTasks((s) => s.activeId);
  const addTask = useTasks((s) => s.add);
  const settings = useSettings((s) => s.settings);

  const { runCorrection, runPolish, runPipelineFull } = usePipeline();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadSettings();
        const e = await ipc.environment();
        if (!cancelled) setEnv(e);
        const m = await ipc.checkModel({ backend: "auto" });
        if (!cancelled) setModelStatus(m);
      } catch (err) {
        if (!cancelled) setBootError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSettings]);

  const activeTask = tasks.find((t) => t.id === activeId) ?? null;

  async function handleFiles(paths: string[]) {
    // Check for duplicates against history library
    let library: LibraryMeta[] = [];
    try {
      library = await ipc.libraryList();
    } catch {
      /* ignore — fall back to direct queueing */
    }
    const byStem = new Map(library.map((m) => [m.stem, m]));

    const remaining = [...paths];
    while (remaining.length > 0) {
      const p = remaining.shift()!;
      const filename = p.split(/[\\/]/).pop() || p;
      const stem = filename.replace(/\.[^.]+$/, "");
      const existing = byStem.get(stem);
      if (existing) {
        // Pause processing, show modal — user choice resumes via handler
        setDuplicate({ path: p, filename, existing, queued: remaining });
        return;
      }
      addTask(p);
    }
  }

  async function handleDuplicateChoice(choice: DuplicateChoice) {
    if (!duplicate) return;
    const { path, existing, queued } = duplicate;

    if (choice === "cancel") {
      setDuplicate(null);
      // resume remaining queue
      if (queued.length) await handleFiles(queued);
      return;
    }

    if (choice === "load") {
      try {
        const loaded = await ipc.libraryLoad(existing.stem);
        const id = useTasks.getState().add(loaded.raw_json.audio || existing.stem);
        useTasks.getState().setStage(id, "transcribed");
        useTasks.getState().setResult(id, loaded.raw_json);
        if (loaded.corrected_json) {
          useTasks.getState().setCorrected(id, {
            segments: loaded.corrected_json.segments,
            changed: loaded.corrected_json.changed ?? 0,
            total: loaded.corrected_json.total ?? loaded.corrected_json.segments.length,
            model: loaded.corrected_json.corrected_by ?? existing.correction_model ?? "?",
          });
        }
        if (loaded.polished_text) {
          useTasks.getState().setPolished(id, {
            text: loaded.polished_text,
            model: existing.polish_model ?? "?",
            source: (existing.polish_source as "corrected" | "raw") ?? (existing.has_corrected ? "corrected" : "raw"),
          });
        }
        useTasks.getState().setActive(id);
      } catch (e) {
        console.warn("load existing failed", e);
      }
    } else if (choice === "redo") {
      try {
        await ipc.libraryArchive(existing.stem);
      } catch (e) {
        console.warn("archive failed", e);
      }
      addTask(path);
    }

    setDuplicate(null);
    if (queued.length) await handleFiles(queued);
  }

  return (
    <div className="h-full flex flex-col bg-editor">
      <TitleBar onOpenSettings={() => setSettingsOpen(true)} />

      {/* Body: sidebar + main */}
      <div className="flex-1 min-h-0 flex">
        {/* Primary sidebar */}
        <aside className="w-[300px] shrink-0 pane flex flex-col">
          <SidebarSection title="导入" defaultOpen>
            <div className="px-2 pb-2">
              <DropZone onPick={handleFiles} />
            </div>
          </SidebarSection>

          <SidebarSection title="任务队列" badge={tasks.length || undefined} defaultOpen>
            <TaskQueue />
          </SidebarSection>

          <SidebarSection title="历史库" defaultOpen>
            <LibraryPanel />
          </SidebarSection>

          <SidebarSection title="文章库" defaultOpen className="flex-1 min-h-0">
            <ArticlesPanel
              activeFilename={activeArticle?.filename ?? null}
              onSelect={(m) => {
                setActiveArticle(m);
              }}
              refreshKey={articlesRefresh}
            />
          </SidebarSection>
        </aside>

        {/* Main editor area */}
        <main className="flex-1 min-w-0 flex flex-col bg-editor">
          {bootError && (
            <div className="px-3 py-2 text-ui-sm text-err bg-err/10 border-b border-border/60">
              后端未连接: <span className="font-mono">{bootError}</span>
            </div>
          )}
          {modelStatus && !modelStatus.exists && (
            <div className="px-3 py-2 text-ui-sm text-warn bg-warn/10 border-b border-border/60">
              ⚠ 模型 <span className="font-mono">{modelStatus.model_id}</span> 未在缓存
            </div>
          )}

          {activeArticle ? (
            <ArticleViewer
              meta={activeArticle}
              onClose={() => setActiveArticle(null)}
              onChanged={() => {
                setArticlesRefresh((n) => n + 1);
                setActiveArticle(null);
              }}
            />
          ) : activeTask?.result ? (
            <ResultTabs
              task={activeTask}
              onCorrect={() => runCorrection(activeTask.id)}
              onPolish={() => runPolish(activeTask.id)}
              onPipelineFull={() => runPipelineFull(activeTask.id)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : (
            <EmptyState
              hasTasks={tasks.length > 0}
              activeStage={activeTask?.stage}
            />
          )}
        </main>
      </div>

      <StatusBar env={env} settings={settings} activeTask={activeTask} />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {duplicate && (
        <DuplicateFileDialog
          filename={duplicate.filename}
          existing={duplicate.existing}
          onChoose={handleDuplicateChoice}
        />
      )}
    </div>
  );
}

// ============================================================================
// Title bar (VSCode style — 32px, dark gray)
// ============================================================================

function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <header className="shrink-0 h-9 bg-titlebar text-fg flex items-center justify-between px-3 select-none border-b border-black/40">
      <div className="flex items-center gap-2">
        <Logo size={18} />
        <span className="text-ui font-medium">LocalScribe</span>
        <span className="text-ui-sm text-fg-mute">v0.1.0</span>
      </div>
      <button onClick={onOpenSettings} className="btn-ghost h-7 px-2" title="设置">
        <SettingsIcon size={14} />
        <span>设置</span>
      </button>
    </header>
  );
}

// ============================================================================
// Sidebar section (collapsible, VSCode primary sidebar style)
// ============================================================================

function SidebarSection({
  title,
  badge,
  defaultOpen = true,
  className = "",
  children,
}: {
  title: string;
  badge?: number;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`pane-section flex flex-col ${className}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="pane-section-header"
      >
        <span className="flex items-center gap-1">
          {open ? <ChevronDown size={12} className="text-fg-mute" /> : <ChevronRight size={12} className="text-fg-mute" />}
          <span>{title}</span>
          {badge !== undefined && (
            <span className="ml-1 text-fg-mute normal-case tracking-normal">{badge}</span>
          )}
        </span>
      </button>
      {open && <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>}
    </section>
  );
}

// ============================================================================
// Status bar (VSCode style — 22px, blue)
// ============================================================================

function StatusBar({
  env,
  settings,
  activeTask,
}: {
  env: EnvironmentInfo | null;
  settings: ReturnType<typeof useSettings.getState>["settings"];
  activeTask: ReturnType<typeof useTasks.getState>["tasks"][number] | null;
}) {
  const stageLabel = activeTask
    ? STAGE_TO_LABEL[activeTask.stage] || activeTask.stage
    : "就绪";
  const stagePct = useMemo(() => {
    if (!activeTask) return null;
    if (activeTask.progress.total <= 0) return null;
    return Math.round((activeTask.progress.current / activeTask.progress.total) * 100);
  }, [activeTask]);

  const stageIcon = (() => {
    const s = activeTask?.stage;
    if (s === "transcribing" || s === "correcting" || s === "polishing") return <Hourglass size={11} />;
    if (s === "transcribed" || s === "corrected" || s === "polished") return <Check size={11} />;
    if (s === "correcting_paused") return <Pause size={11} />;
    if (s === "error") return <Warning size={11} />;
    return null;
  })();

  return (
    <footer className="shrink-0 h-[22px] bg-statusbar text-white text-ui-sm flex items-center justify-between px-2 select-none">
      <div className="flex items-center gap-3">
        <StatusItem icon={stageIcon} label={stageLabel + (stagePct !== null ? ` ${stagePct}%` : "")} />
        {activeTask?.filename && (
          <StatusItem icon={<FileText size={11} />} label={activeTask.filename} />
        )}
      </div>
      <div className="flex items-center gap-3">
        <StatusItem
          icon={<SettingsIcon size={11} />}
          label={`${env?.default_backend ?? "..."} · ${settings.model_id.split("/").pop()}`}
          title="转录后端 + 模型"
        />
        {settings.correction.enabled && (
          <StatusItem
            icon={<Sparkle size={11} />}
            label={`LLM ${settings.correction.model}`}
            title="LLM 校对启用中"
          />
        )}
      </div>
    </footer>
  );
}

const STAGE_TO_LABEL: Record<string, string> = {
  queued: "等待",
  transcribing: "转录中",
  transcribed: "转录完成",
  correcting: "校对中",
  correcting_paused: "校对已暂停",
  corrected: "校对完成",
  polishing: "排版中",
  polished: "排版完成",
  error: "错误",
  cancelled: "已取消",
};

function StatusItem({ icon, label, title }: { icon: React.ReactNode; label: string; title?: string }) {
  return (
    <span className="flex items-center gap-1 hover:bg-white/10 px-1 cursor-default" title={title}>
      {icon && <span className="opacity-80">{icon}</span>}
      <span className="truncate max-w-[300px]">{label}</span>
    </span>
  );
}

// ============================================================================
// Empty state in main area
// ============================================================================

function EmptyState({ hasTasks, activeStage }: { hasTasks: boolean; activeStage?: string }) {
  const settings = useSettings((s) => s.settings);
  const hasApiKey = useSettings((s) => s.hasApiKey);
  const llmReady = settings.correction.enabled && hasApiKey;

  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-2 text-fg-dim p-6">
      <Logo size={64} className="opacity-40" />
      {!hasTasks ? (
        <>
          <div className="text-ui-lg mt-4">把音频或视频拖到左侧</div>
          <div className="text-ui-sm text-fg-mute max-w-md leading-relaxed mt-1">
            支持 m4a / mp3 / wav / mp4 / mov 等 · Apple Silicon 上 1 小时音频约 1-2 分钟转完
            <br />
            完全离线运行 · 可选 LLM 校对(默认关闭)
          </div>

          {/* 首次启动引导:LLM 未配置时给出醒目提示 */}
          {!llmReady && (
            <div className="mt-6 max-w-lg w-full bg-accent/5 border border-accent/30 rounded-sm p-4 text-left">
              <div className="text-ui font-medium text-accent mb-2">
                🎯 想让转录稿更准确?启用 LLM 校对
              </div>
              <div className="text-ui-sm text-fg-dim leading-relaxed space-y-1.5">
                <div>· 字级校对(同音字/错别字)+ 整篇排版</div>
                <div>· 推荐 <span className="font-mono text-fg">DeepSeek-v4-flash</span>,1 小时音频约 0.5 元</div>
                <div>· API Key 存系统钥匙串,音频不会上传</div>
              </div>
              <div className="mt-3 text-ui-sm text-fg-mute">
                申请 key:<a className="text-accent hover:underline" href="https://platform.deepseek.com" target="_blank" rel="noreferrer">platform.deepseek.com</a>
              </div>
            </div>
          )}
        </>
      ) : activeStage === "transcribing" ? (
        <>
          <div className="text-ui-lg mt-4">正在转录…</div>
          <div className="text-ui-sm text-fg-mute mt-1">查看左栏任务卡的进度</div>
        </>
      ) : (
        <div className="text-ui-lg mt-4">点击左栏任务或历史库的条目查看结果</div>
      )}
    </div>
  );
}
