import { useEffect, useState } from "react";
import clsx from "clsx";
import { CORRECTION_MODES, useSettings } from "../stores/settings-store";
import { ipc, type CorrectionMode, type LLMAdvanced } from "../lib/ipc";
import PrivacyNotice from "./PrivacyNotice";

type Props = { open: boolean; onClose: () => void };
type Tab = "general" | "model" | "correction" | "diarization" | "about";

const TABS: { value: Tab; label: string }[] = [
  { value: "general", label: "常规" },
  { value: "model", label: "模型" },
  { value: "correction", label: "校对" },
  { value: "diarization", label: "说话人" },
  { value: "about", label: "关于" },
];

export default function SettingsDialog({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("general");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
      <div className="bg-sidebar border border-border rounded-sm shadow-2xl max-w-3xl w-full m-6 max-h-[85vh] flex flex-col">
        <header className="flex items-center justify-between px-4 h-10 border-b border-border">
          <h2 className="text-ui-lg font-medium">设置</h2>
          <button onClick={onClose} className="btn-ghost h-7 px-2">关闭</button>
        </header>
        <nav className="flex border-b border-border bg-tabbar">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={clsx(
                "btn-tab",
                tab === t.value && "btn-tab-active bg-sidebar",
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="flex-1 overflow-auto px-5 py-4">
          {tab === "general" && <GeneralTab />}
          {tab === "model" && <ModelTab />}
          {tab === "correction" && <CorrectionTab />}
          {tab === "diarization" && <DiarizationTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 items-start">
      <div className="pt-1.5">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-text-mute mt-0.5">{hint}</div>}
      </div>
      <div className="col-span-2">{children}</div>
    </div>
  );
}

function GeneralTab() {
  const { settings, patch } = useSettings();
  const [outputDir, setOutputDir] = useState(settings.output_dir ?? "");
  return (
    <div className="space-y-4">
      <Field label="默认语言" hint="留空 = 自动检测">
        <select
          className="select"
          value={settings.language}
          onChange={(e) => patch("language", e.target.value)}
        >
          <option value="">自动检测</option>
          <option value="zh">中文</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
        </select>
      </Field>
      <Field label="输出格式">
        <div className="flex flex-wrap gap-3">
          {["txt", "srt", "json", "md"].map((f) => (
            <label key={f} className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={settings.output_formats.includes(f)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? Array.from(new Set([...settings.output_formats, f]))
                    : settings.output_formats.filter((x) => x !== f);
                  patch("output_formats", next);
                }}
              />
              <span>.{f}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label="默认输出目录" hint="留空 = 与音频同目录">
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="/Users/.../transcripts"
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            onBlur={() => patch("output_dir", outputDir || null)}
          />
        </div>
      </Field>
    </div>
  );
}

function ModelTab() {
  const { settings, patch } = useSettings();
  return (
    <div className="space-y-4">
      <Field label="后端" hint="auto:Apple GPU / 其他 CPU">
        <select
          className="select"
          value={settings.backend}
          onChange={(e) => patch("backend", e.target.value)}
        >
          <option value="auto">auto(推荐)</option>
          <option value="mlx">mlx(仅 Apple Silicon)</option>
          <option value="ct2">ct2(faster-whisper, 跨平台)</option>
        </select>
      </Field>
      <Field label="模型 ID">
        <input
          className="input w-full"
          value={settings.model_id}
          onChange={(e) => patch("model_id", e.target.value)}
        />
      </Field>
      <div className="text-xs text-text-mute pt-2">
        默认 <span className="font-mono">large-v3-turbo</span> 在 Apple Silicon 上 RTF ~0.02x,
        1 小时音频约 1-2 分钟转完。
      </div>
    </div>
  );
}

function CorrectionTab() {
  const { settings, hasApiKey, patchCorrection, patchPolish, setApiKey, refreshHasApiKey } = useSettings();
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [savedHint, setSavedHint] = useState("");

  useEffect(() => {
    refreshHasApiKey();
  }, [settings.correction.provider, refreshHasApiKey]);

  function handleEnable(checked: boolean) {
    if (checked && !settings.correction.enabled) {
      setShowPrivacy(true);
    } else {
      patchCorrection({ enabled: checked });
    }
  }

  async function saveKey() {
    if (!keyDraft) return;
    await setApiKey(settings.correction.provider, keyDraft);
    setKeyDraft("");
    setSavedHint(`✅ 已保存到系统钥匙串(${new Date().toLocaleTimeString()})`);
    setTimeout(() => setSavedHint(""), 4000);
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-amber-300 bg-amber-300/10 border border-amber-300/20 rounded-md p-3">
        ⚠️ 启用 LLM 校对会将转录文字发送到第三方 API。录音文件本身不上传。商务/敏感场景建议保持关闭。
      </div>

      <Field label="启用 LLM 校对">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.correction.enabled}
            onChange={(e) => handleEnable(e.target.checked)}
          />
          {settings.correction.enabled ? "已启用" : "未启用"}
        </label>
      </Field>

      <Field label="自动一键流程" hint="转录完成后自动接力执行 校对 → 排版,无需手动点按钮">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={!settings.correction.enabled}
            checked={settings.correction.auto_pipeline}
            onChange={(e) => patchCorrection({ auto_pipeline: e.target.checked })}
          />
          {settings.correction.auto_pipeline ? "已启用" : "未启用"}
        </label>
      </Field>

      <Field label="提供商">
        <select
          className="select"
          value={settings.correction.provider}
          disabled={!settings.correction.enabled}
          onChange={(e) => patchCorrection({ provider: e.target.value })}
        >
          <option value="deepseek">DeepSeek</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="custom">自定义(OpenAI 协议)</option>
        </select>
      </Field>

      <Field label="Base URL">
        <input
          className="input w-full"
          disabled={!settings.correction.enabled}
          value={settings.correction.base_url}
          onChange={(e) => patchCorrection({ base_url: e.target.value })}
        />
      </Field>

      <Field label="模型">
        <input
          className="input w-full"
          disabled={!settings.correction.enabled}
          value={settings.correction.model}
          onChange={(e) => patchCorrection({ model: e.target.value })}
        />
      </Field>

      <Field label="API Key" hint={hasApiKey ? "已存在(系统钥匙串)" : "请输入并保存"}>
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <input
              type="password"
              className="input flex-1 font-mono"
              disabled={!settings.correction.enabled}
              placeholder={hasApiKey ? "••••••••••(已保存)" : "sk-..."}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
            <button
              className="btn"
              disabled={!settings.correction.enabled || !keyDraft}
              onClick={saveKey}
            >
              保存
            </button>
            <button
              className="btn-ghost"
              disabled={!settings.correction.enabled || !hasApiKey}
              onClick={async () => {
                await ipc.deleteApiKey(settings.correction.provider);
                refreshHasApiKey();
              }}
            >
              清除
            </button>
          </div>
          {savedHint && <div className="text-xs text-emerald-400">{savedHint}</div>}
        </div>
      </Field>

      <Field label="校对强度">
        <div className="flex gap-1.5">
          {CORRECTION_MODES.map((m) => (
            <button
              key={m.value}
              disabled={!settings.correction.enabled}
              onClick={() => patchCorrection({ mode: m.value as CorrectionMode })}
              className={clsx(
                "flex-1 py-2 px-2 rounded-md text-sm border transition-colors",
                settings.correction.mode === m.value
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-bg-border bg-bg/40 text-text-dim hover:text-text",
              )}
            >
              <div className="font-medium">{m.label}</div>
              <div className="text-xs opacity-70">{m.hint}</div>
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="急速模式"
        hint="跳过术语提取阶段(Pass 1),只跑分批校对。通用内容快约 30%,专业内容(人名/术语多)准确率会略降。"
      >
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={!settings.correction.enabled}
            checked={!settings.correction.use_glossary}
            onChange={(e) => patchCorrection({ use_glossary: !e.target.checked })}
          />
          {!settings.correction.use_glossary ? "已开启(更快)" : "未开启(更准)"}
        </label>
      </Field>

      <Field label="上下文提示词" hint="可选,告诉模型这段音频的领域">
        <textarea
          className="textarea w-full"
          rows={2}
          disabled={!settings.correction.enabled}
          placeholder="例:这是法律咨询会议;这是圣经新约..."
          value={settings.correction.context_hint}
          onChange={(e) => patchCorrection({ context_hint: e.target.value })}
        />
      </Field>

      <div className="border-t border-bg-border pt-4 mt-4">
        <Field label="启用文章排版" hint="基于校对结果再做一次整篇排版,生成连续散文">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={!settings.correction.enabled}
              checked={settings.polish.enabled}
              onChange={(e) => patchPolish({ enabled: e.target.checked })}
            />
            {settings.polish.enabled ? "已启用" : "未启用"}
          </label>
        </Field>
      </div>

      <AdvancedParamsSection />

      {showPrivacy && (
        <PrivacyNotice
          onAccept={() => {
            patchCorrection({ enabled: true });
            setShowPrivacy(false);
          }}
          onCancel={() => setShowPrivacy(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// 高级 LLM 参数面板(可折叠,带通俗说明)
// ============================================================================

type ParamSpec = {
  key: keyof LLMAdvanced;
  label: string;
  hint: string; // 给非技术用户看的说明
  min: number;
  max: number;
  step: number;
  defaultRecommended: number;
};

// 只暴露最常用的参数。其他(max_tokens / top_p / frequency / presence)走默认值,
// 极少需要调,真出问题时(如截断)文章页会有醒目警告条引导用户。
const CORRECTION_PARAMS: ParamSpec[] = [
  {
    key: "temperature",
    label: "稳定性(温度)",
    hint: "拖向左侧 = 每次结果一致、严谨保守(推荐用于校对);拖向右侧 = 更自由发挥,但可能瞎改。",
    min: 0,
    max: 1.5,
    step: 0.05,
    defaultRecommended: 0.1,
  },
];

const POLISH_PARAMS: ParamSpec[] = [
  {
    key: "temperature",
    label: "稳定性(温度)",
    hint: "拖向左侧 = 严格按原文加标点和分段;拖向右侧 = 更自由的语气重塑(建议 0.3 左右,平衡通顺与忠实)。",
    min: 0,
    max: 1.5,
    step: 0.05,
    defaultRecommended: 0.3,
  },
];

function AdvancedParamsSection() {
  const [open, setOpen] = useState(false);
  const settings = useSettings((s) => s.settings);
  const patchCorrection = useSettings((s) => s.patchCorrection);
  const patchPolish = useSettings((s) => s.patchPolish);

  function setCorrAdv(key: keyof LLMAdvanced, value: number) {
    patchCorrection({ advanced: { ...settings.correction.advanced, [key]: value } });
  }
  function setPolishAdv(key: keyof LLMAdvanced, value: number) {
    patchPolish({ advanced: { ...settings.polish.advanced, [key]: value } });
  }
  function resetCorr() {
    patchCorrection({
      advanced: {
        temperature: 0.1, max_tokens: 8192, top_p: 1.0, frequency_penalty: 0, presence_penalty: 0,
      },
    });
  }
  function resetPolish() {
    patchPolish({
      advanced: {
        temperature: 0.3, max_tokens: 65536, top_p: 1.0, frequency_penalty: 0, presence_penalty: 0,
      },
    });
  }

  return (
    <div className="mt-4 border-t border-bg-border pt-4">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm font-medium text-text-dim hover:text-text flex items-center gap-1"
      >
        <span>{open ? "▼" : "▶"}</span>
        <span>高级参数(温度 / 最大输出 / 并发等)</span>
      </button>

      {open && (
        <div className="mt-3 space-y-5">
          {/* 校对相关:并发 + 批大小 + 词表 */}
          <fieldset className="space-y-3 border border-bg-border rounded-md p-3">
            <legend className="px-2 text-xs text-text-dim">校对 · 流水线</legend>

            <ParamRow
              label="并发数"
              hint="同时发起几个 LLM 校对请求。15 = 推荐(适合 DeepSeek);更高需注意 API 限流。"
              min={1}
              max={30}
              step={1}
              value={settings.correction.concurrency}
              recommended={15}
              onChange={(v) => patchCorrection({ concurrency: v })}
            />
            <ParamRow
              label="批大小"
              hint="校对时每次给 LLM 几段。30 = 推荐;更大 LLM 容易乱,更小调用次数多。"
              min={5}
              max={100}
              step={5}
              value={settings.correction.batch_size}
              recommended={30}
              onChange={(v) => patchCorrection({ batch_size: v })}
            />
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm">启用术语表(两阶段校对)</div>
                <div className="text-xs text-text-mute mt-0.5">
                  开始校对前先扫全文提取专有名词,后续每批校对时强制保持一致。
                  <br />
                  <strong className="text-fg">关闭 = 急速模式</strong>:跳过术语提取,通用内容速度提升约 30%,
                  专业内容(术语多/人名多)准确率会略降。
                </div>
              </div>
              <label className="inline-flex items-center gap-2 pt-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={settings.correction.use_glossary}
                  onChange={(e) => patchCorrection({ use_glossary: e.target.checked })}
                />
                {settings.correction.use_glossary ? "开" : "急速模式"}
              </label>
            </div>
          </fieldset>

          {/* 校对 LLM 参数 */}
          <fieldset className="space-y-3 border border-bg-border rounded-md p-3">
            <legend className="px-2 text-xs text-text-dim">校对 · LLM 参数</legend>
            {CORRECTION_PARAMS.map((p) => (
              <ParamRow
                key={`c-${p.key}`}
                label={p.label}
                hint={p.hint}
                min={p.min}
                max={p.max}
                step={p.step}
                value={settings.correction.advanced[p.key]}
                recommended={p.defaultRecommended}
                onChange={(v) => setCorrAdv(p.key, v)}
              />
            ))}
            <button onClick={resetCorr} className="btn-ghost text-xs">恢复推荐值</button>
          </fieldset>

          {/* 排版 LLM 参数 */}
          <fieldset className="space-y-3 border border-bg-border rounded-md p-3">
            <legend className="px-2 text-xs text-text-dim">排版 · LLM 参数</legend>
            {POLISH_PARAMS.map((p) => (
              <ParamRow
                key={`p-${p.key}`}
                label={p.label}
                hint={p.hint}
                min={p.min}
                max={p.max}
                step={p.step}
                value={settings.polish.advanced[p.key]}
                recommended={p.defaultRecommended}
                onChange={(v) => setPolishAdv(p.key, v)}
              />
            ))}
            <button onClick={resetPolish} className="btn-ghost text-xs">恢复推荐值</button>
          </fieldset>
        </div>
      )}
    </div>
  );
}

function ParamRow({
  label,
  hint,
  min,
  max,
  step,
  value,
  recommended,
  onChange,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  recommended: number;
  onChange: (v: number) => void;
}) {
  const isRecommended = Math.abs(value - recommended) < step * 0.5;
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm flex items-center gap-2">
          <span>{label}</span>
          {!isRecommended && (
            <button
              onClick={() => onChange(recommended)}
              className="text-xs text-text-mute hover:text-accent underline"
              title="恢复推荐值"
            >
              ↺ 推荐 {recommended}
            </button>
          )}
        </div>
        <div className="text-xs text-text-mute mt-0.5 leading-relaxed">{hint}</div>
      </div>
      <div className="flex flex-col items-end gap-1 w-32 shrink-0">
        <input
          type="number"
          className="input w-full text-right"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) onChange(v);
          }}
        />
        <input
          type="range"
          className="w-full accent-accent"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
      </div>
    </div>
  );
}

function DiarizationTab() {
  const settings = useSettings((s) => s.settings);
  const patchDiarization = useSettings((s) => s.patchDiarization);
  const diar = settings.diarization
    ?? { enabled: false, n_speakers: 2, speakers: [] };

  const [busy, setBusy] = useState<"none" | "extract">("none");
  const [error, setError] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState("");

  async function addSpeaker() {
    setError(null);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Audio", extensions: ["m4a", "mp3", "wav", "mp4", "mov", "ogg", "flac", "aac", "opus", "webm"] }],
      });
      if (!picked || typeof picked !== "string") return;
      const name = pendingName.trim() || `说话人${diar.speakers.length + 1}`;
      setBusy("extract");
      const { ipc: ipcMod } = await import("../lib/ipc");
      const { embedding } = await ipcMod.extractVoiceEmbedding(picked);
      await patchDiarization({
        speakers: [
          ...diar.speakers,
          { name, embedding, created_at: new Date().toISOString() },
        ],
      });
      setPendingName("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("none");
    }
  }

  async function renameSpeaker(idx: number, newName: string) {
    const next = diar.speakers.map((s, i) => i === idx ? { ...s, name: newName } : s);
    await patchDiarization({ speakers: next });
  }

  async function deleteSpeaker(idx: number) {
    const next = diar.speakers.filter((_, i) => i !== idx);
    await patchDiarization({ speakers: next });
  }

  return (
    <div className="space-y-5 text-ui">
      <div className="bg-info/5 border border-info/20 rounded-sm p-3 text-ui-sm text-fg-dim leading-relaxed">
        <strong className="text-fg">说话人分离</strong>:转录完成后,自动用 Resemblyzer 声纹模型 + KMeans
        把音频切成 N 个说话人,每段标注 <span className="font-mono text-fg">SPEAKER_A/B/...</span>。
        <br />
        在下面登记声纹样本(每人一段 ≥ 5 秒纯人声),系统会自动用真实姓名替代泛标签(三修 / 位总 等)。
      </div>

      <Field label="启用说话人分离" hint="转录完成后自动跑 diarization">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={diar.enabled}
            onChange={(e) => patchDiarization({ enabled: e.target.checked })}
          />
          {diar.enabled ? "已启用" : "未启用"}
        </label>
      </Field>

      <Field
        label="说话人数量"
        hint="自动 = silhouette 扫描 K=2-8 自选最优(推荐);也可手动指定 1-8(1=单人跳过聚类)"
      >
        <div className="flex gap-1.5 flex-wrap">
          <button
            disabled={!diar.enabled}
            onClick={() => patchDiarization({ n_speakers: 0 })}
            className={clsx(
              "px-3 py-1.5 rounded-md text-sm border transition-colors",
              diar.n_speakers === 0
                ? "border-accent bg-accent/10 text-accent"
                : "border-bg-border bg-bg/40 text-text-dim hover:text-text",
            )}
          >
            自动
          </button>
          {[1, 2, 3, 4, 5, 6, 8].map((n) => (
            <button
              key={n}
              disabled={!diar.enabled}
              onClick={() => patchDiarization({ n_speakers: n })}
              className={clsx(
                "w-10 py-1.5 rounded-md text-sm border transition-colors",
                diar.n_speakers === n
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-bg-border bg-bg/40 text-text-dim hover:text-text",
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </Field>

      <div className="border-t border-bg-border pt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium text-fg">声纹库</div>
          <div className="text-ui-sm text-fg-mute">{diar.speakers.length} 人</div>
        </div>

        {diar.speakers.length === 0 ? (
          <div className="text-ui-sm text-fg-mute italic py-3">
            还没有登记的声纹。下方上传音频样本,LocalScribe 会自动为该说话人提取 256 维声纹特征(不存音频本体)。
          </div>
        ) : (
          <ul className="space-y-1.5 mb-3">
            {diar.speakers.map((spk, idx) => (
              <li key={idx} className="flex items-center gap-2 bg-bg/40 border border-bg-border rounded-sm px-3 py-2">
                <input
                  className="flex-1 bg-transparent border-none outline-none text-fg text-sm"
                  defaultValue={spk.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== spk.name) renameSpeaker(idx, v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
                <span className="text-ui-sm text-fg-mute">256 dims</span>
                <button
                  onClick={() => deleteSpeaker(idx)}
                  className="text-ui-sm text-err hover:underline"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <input
            className="flex-1 px-3 py-1.5 bg-bg/40 border border-bg-border rounded-sm text-sm"
            placeholder="人名(可选,例:三修)"
            value={pendingName}
            onChange={(e) => setPendingName(e.target.value)}
            disabled={!diar.enabled}
          />
          <button
            onClick={addSpeaker}
            disabled={!diar.enabled || busy === "extract"}
            className="btn"
          >
            {busy === "extract" ? "提取中…" : "+ 添加声纹样本"}
          </button>
        </div>

        {error && (
          <div className="mt-2 text-ui-sm text-err bg-err/10 border border-err/30 rounded-sm px-3 py-2">
            {error}
          </div>
        )}

        <div className="mt-3 text-ui-sm text-fg-mute leading-relaxed">
          <strong>用法</strong>:每人录一段 5-30 秒纯人声(可以是这次会议开头的自我介绍片段),
          上传后命名。转录时若 cosine 相似度 ≥ 0.65 则自动用此姓名,否则保留 <span className="font-mono">SPEAKER_X</span>。
          <br />
          <strong>隐私</strong>:声纹是 256 维数字向量,**不可逆推回原始音频**,只存在本地 settings.json 里。
        </div>
      </div>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="space-y-4 text-ui">
      <div>
        <div className="text-ui-lg font-medium text-fg">LocalScribe v1.0.1</div>
        <div className="text-ui-sm text-fg-mute mt-0.5">离线录音转文字 · MIT License</div>
      </div>

      {/* 出品方 */}
      <div className="bg-accent/5 border border-accent/30 rounded-sm p-3 space-y-1.5">
        <div className="text-ui-sm text-accent font-medium">出品方</div>
        <div className="text-fg leading-relaxed">
          <span className="font-medium">涌智星河</span> · SwarmPath · 寒三修
        </div>
        <div className="text-ui-sm text-fg-dim leading-relaxed">
          LocalScribe 是涌智星河旗下的开源产品,致力于为个人与小团队提供
          <span className="text-fg">隐私友好、本地可控、AI 增强</span>
          的内容创作与知识沉淀工具。所有代码以 MIT 协议开源,商业与非商业使用皆免费。
        </div>
      </div>

      {/* 技术栈 */}
      <div className="text-fg-dim leading-relaxed">
        基于 OpenAI Whisper large-v3-turbo。Apple Silicon 经 mlx-whisper 加速,其他平台经 faster-whisper。
        可选 LLM 字级校对与整篇排版(默认关闭,需启用 + 配置 API Key)。
      </div>
      <dl className="text-ui-sm space-y-1.5">
        <Row term="Whisper" def="© OpenAI · MIT License" />
        <Row term="mlx-whisper" def="© Apple ML Research · MIT License" />
        <Row term="faster-whisper" def="© SYSTRAN · MIT License" />
        <Row term="silero-vad" def="© Silero Team · MIT License" />
        <Row term="Tauri 2 · React 18" def="© Tauri / React contributors" />
        <Row term="DeepSeek API" def="© DeepSeek (作为 LLM 提供商之一可选接入)" />
      </dl>
    </div>
  );
}

function Row({ term, def }: { term: string; def: string }) {
  return (
    <div className="flex gap-3">
      <dt className="text-fg w-32 shrink-0">{term}</dt>
      <dd className="text-fg-mute">{def}</dd>
    </div>
  );
}
