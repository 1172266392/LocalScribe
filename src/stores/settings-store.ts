import { create } from "zustand";
import { ipc, type AppSettings, type CorrectionMode } from "../lib/ipc";

const DEFAULT_SETTINGS: AppSettings = {
  model_id: "mlx-community/whisper-large-v3-turbo",
  backend: "auto",
  language: "zh",
  output_formats: ["txt", "srt", "json"],
  output_dir: null,
  correction: {
    enabled: false,
    auto_pipeline: false,
    provider: "deepseek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    mode: "medium",
    batch_size: 20,
    context_hint: "",
    use_glossary: true,
    concurrency: 5,
    advanced: {
      temperature: 0.1,
      max_tokens: 8192,
      top_p: 1.0,
      frequency_penalty: 0.0,
      presence_penalty: 0.0,
    },
  },
  polish: {
    enabled: false,
    model: "deepseek-v4-flash",
    advanced: {
      temperature: 0.3,
      max_tokens: 384000,
      top_p: 1.0,
      frequency_penalty: 0.0,
      presence_penalty: 0.0,
    },
  },
};

type SettingsStore = {
  settings: AppSettings;
  loaded: boolean;
  hasApiKey: boolean;
  loadFromBackend: () => Promise<void>;
  save: (next: AppSettings) => Promise<void>;
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  patchCorrection: (patch: Partial<AppSettings["correction"]>) => Promise<void>;
  patchPolish: (patch: Partial<AppSettings["polish"]>) => Promise<void>;
  setApiKey: (provider: string, key: string) => Promise<void>;
  refreshHasApiKey: () => Promise<void>;
};

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  hasApiKey: false,

  loadFromBackend: async () => {
    try {
      const s = await ipc.loadSettings();
      set({ settings: s, loaded: true });
      await get().refreshHasApiKey();
    } catch (e) {
      console.warn("loadSettings failed, using defaults", e);
      set({ loaded: true });
      await get().refreshHasApiKey();
    }
  },

  save: async (next) => {
    await ipc.saveSettings(next);
    set({ settings: next });
  },

  patch: async (key, value) => {
    const next = { ...get().settings, [key]: value };
    await ipc.saveSettings(next);
    set({ settings: next });
  },

  patchCorrection: async (patch) => {
    const next = {
      ...get().settings,
      correction: { ...get().settings.correction, ...patch },
    };
    await ipc.saveSettings(next);
    set({ settings: next });
  },

  patchPolish: async (patch) => {
    const next = {
      ...get().settings,
      polish: { ...get().settings.polish, ...patch },
    };
    await ipc.saveSettings(next);
    set({ settings: next });
  },

  setApiKey: async (provider, key) => {
    await ipc.setApiKey(provider, key);
    set({ hasApiKey: true });
  },

  refreshHasApiKey: async () => {
    const provider = get().settings.correction.provider;
    try {
      const has = await ipc.hasApiKey(provider);
      set({ hasApiKey: has });
    } catch {
      set({ hasApiKey: false });
    }
  },
}));

export const CORRECTION_MODES: { value: CorrectionMode; label: string; hint: string }[] = [
  { value: "light", label: "轻", hint: "只修明显错别字 / 同音字" },
  { value: "medium", label: "中", hint: "错字 + 专名 + 删冗余字(推荐)" },
  { value: "heavy", label: "重", hint: "上述 + 口头禅 / 重复词清理" },
];
