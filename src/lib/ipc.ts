// Typed wrappers around Tauri's `invoke` for the LocalScribe backend commands.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Segment = {
  start: number;
  end: number;
  text: string;
  original_text?: string;
};

export type FilterStats = {
  input?: number;
  output?: number;
  removed_total?: number;
  vad?: number;
  logprob?: number;
  phrases?: number;
  repetition?: number;
  density?: number;
  similarity?: number;
};

export type TranscribeResult = {
  audio: string;
  language: string | null;
  duration: number;
  transcribe_seconds: number;
  rtf: number;
  backend: string;
  model_id: string;
  segments: Segment[];
  filter_stats?: FilterStats;
};

export type EnvironmentInfo = {
  apple_silicon: boolean;
  default_backend: string;
  ffmpeg: string | null;
  ffprobe: string | null;
  default_model_id: string;
};

export type ModelStatus = {
  backend?: string;
  model_id: string;
  exists: boolean;
  path: string | null;
};

export type ProbeAudioInfo = {
  audio: string;
  duration: number;
  size: number;
  format_name: string;
  has_audio_stream: boolean;
  ffmpeg: string | null;
  ffprobe: string | null;
};

export type CorrectionMode = "light" | "medium" | "heavy";

export type GlossaryEntry = {
  term: string;
  may_appear_as?: string[];
  category?: string;
  freq?: number;
};

export type CorrectResponse = {
  segments: Segment[];
  changed: number;
  total: number;
  model: string;
  mode: CorrectionMode;
  glossary: GlossaryEntry[];
  cancelled?: boolean;
  concurrency?: number;
};

export type PolishResponse = {
  text: string;
  model: string;
  char_count: number;
  finish_reason?: string;
  truncated?: boolean;
  input_chars?: number;
};

export type LLMAdvanced = {
  temperature: number;
  max_tokens: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
};

export type CorrectionSettings = {
  enabled: boolean;
  auto_pipeline: boolean;
  provider: string;
  base_url: string;
  model: string;
  mode: CorrectionMode;
  batch_size: number;
  context_hint: string;
  use_glossary: boolean;
  concurrency: number;
  advanced: LLMAdvanced;
};

export type PolishSettings = {
  enabled: boolean;
  model: string;
  advanced: LLMAdvanced;
};

export type AppSettings = {
  model_id: string;
  backend: string;
  language: string;
  output_formats: string[];
  output_dir: string | null;
  correction: CorrectionSettings;
  polish: PolishSettings;
};

// ---- backend bridge ----

export const ipc = {
  environment: () => invoke<EnvironmentInfo>("environment"),
  checkModel: (params?: { backend?: string; model_id?: string }) =>
    invoke<ModelStatus>("check_model", params ?? {}),
  probeAudio: (audio: string) => invoke<ProbeAudioInfo>("probe_audio", { audio }),
  transcribe: (params: {
    audio: string;
    backend?: string;
    model_id?: string;
    language?: string;
    initial_prompt?: string;
  }) => invoke<TranscribeResult>("transcribe", params),
  correctSegments: (params: {
    segments: Segment[];
    provider?: string;
    base_url?: string;
    model?: string;
    mode?: CorrectionMode;
    batch_size?: number;
    context_hint?: string;
    use_glossary?: boolean;
    concurrency?: number;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
  }) => invoke<CorrectResponse>("correct_segments", params),
  polishArticle: (params: {
    segments: Segment[];
    provider?: string;
    base_url?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
  }) => invoke<PolishResponse>("polish_article", params),

  // correction control
  correctPause: () => invoke<{ status: string }>("correct_pause"),
  correctResume: () => invoke<{ status: string }>("correct_resume"),
  correctCancel: () => invoke<{ status: string }>("correct_cancel"),
  correctStatus: () => invoke<{ paused: boolean; cancelled: boolean }>("correct_status"),

  // secrets
  setApiKey: (provider: string, apiKey: string) =>
    invoke<void>("set_api_key", { provider, apiKey }),
  hasApiKey: (provider: string) => invoke<boolean>("has_api_key", { provider }),
  deleteApiKey: (provider: string) => invoke<void>("delete_api_key", { provider }),

  // settings
  loadSettings: () => invoke<AppSettings>("load_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),

  // model cache
  checkModelCache: (model_id: string) => invoke<ModelStatus>("check_model_cache", { model_id }),

  // library
  librarySaveRaw: (args: {
    stem: string;
    audio_filename: string;
    txt: string;
    srt: string;
    json: string;
    result: TranscribeResult;
  }) => invoke<LibraryMeta>("library_save_raw", { args }),
  librarySaveCorrected: (args: {
    stem: string;
    txt: string;
    srt: string;
    json: string;
    diff: string;
    model: string;
    changed: number;
    total: number;
    glossary?: GlossaryEntry[];
  }) => invoke<LibraryMeta>("library_save_corrected", { args }),
  librarySavePolished: (args: {
    stem: string;
    text: string;
    model: string;
    source?: "corrected" | "raw";
  }) => invoke<LibraryMeta>("library_save_polished", { args }),
  libraryList: () => invoke<LibraryMeta[]>("library_list"),
  libraryLoad: (stem: string) => invoke<LoadedTask>("library_load", { stem }),
  libraryDelete: (stem: string) => invoke<void>("library_delete", { stem }),
  libraryArchive: (stem: string) => invoke<string | null>("library_archive", { stem }),
  libraryRootPath: () => invoke<string>("library_root_path"),

  // articles 知识库
  articleSave: (args: SaveArticleArgs) => invoke<ArticleMeta>("article_save", { args }),
  articleList: () => invoke<ArticleMeta[]>("article_list"),
  articleDelete: (filename: string) => invoke<void>("article_delete", { filename }),
  articleRename: (oldFilename: string, newTitle: string) =>
    invoke<ArticleMeta>("article_rename", { oldFilename, newTitle }),
  articleRead: (filename: string) => invoke<string>("article_read", { filename }),
  articlesRootPath: () => invoke<string>("articles_root_path"),
};

export type SaveArticleArgs = {
  title: string;
  content: string;
  source_audio?: string;
  source_stem?: string;
  duration_seconds?: number;
  model?: string;
  based_on?: "corrected" | "raw";
  tags?: string[];
  note?: string;
  overwrite?: boolean;
};

export type ArticleMeta = {
  title: string;
  filename: string;
  path: string;
  source_audio: string | null;
  source_stem: string | null;
  duration_seconds: number | null;
  char_count: number;
  model: string | null;
  based_on: string | null;
  tags: string[];
  note: string | null;
  created_at: string;
  modified_at: string;
};

export type LibraryMeta = {
  stem: string;
  audio_filename: string;
  duration: number;
  segments: number;
  backend: string;
  model_id: string;
  created_at: number;
  updated_at: number;
  has_corrected: boolean;
  has_polished: boolean;
  correction_model: string | null;
  correction_changed: number | null;
  correction_glossary: GlossaryEntry[] | null;
  polish_model: string | null;
  polish_source: string | null;
};

export type LoadedTask = {
  meta: LibraryMeta;
  raw_json: TranscribeResult;
  corrected_json: { segments: Segment[]; corrected_by?: string; changed?: number; total?: number } | null;
  polished_text: string | null;
};

// ---- progress events ----

export type ProgressData = {
  current?: number;
  total?: number;
  preview?: string;
  stage?: string;
  error?: string;
};

export type ProgressMethod = "transcribe" | "correct";

export function onProgress(
  method: ProgressMethod,
  handler: (data: ProgressData) => void,
): Promise<UnlistenFn> {
  return listen<ProgressData>(`scribe://progress/${method}`, (e) => handler(e.payload));
}
