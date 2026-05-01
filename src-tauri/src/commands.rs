//! `#[tauri::command]` handlers — the bridge between the React frontend and the
//! Python sidecar. Each command resolves API keys from the keychain (when LLM
//! features are used) and forwards parameters via the sidecar.

use anyhow::Result;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::sidecar::SidecarLazy;
use crate::{articles, library, model_check, secrets, settings};

macro_rules! log_cmd {
    ($name:expr) => {
        tracing::info!(target: "cmd", "→ {}", $name)
    };
    ($name:expr, $($arg:tt)*) => {
        tracing::info!(target: "cmd", "→ {} {}", $name, format!($($arg)*))
    };
}

/// Wrap an anyhow result so it serializes nicely back to the frontend.
fn map_err<T>(r: Result<T>) -> Result<T, String> {
    r.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn environment(sidecar: State<'_, SidecarLazy>) -> Result<Value, String> {
    map_err(sidecar.call("environment", json!({})).await)
}

#[tauri::command]
pub async fn check_model(
    sidecar: State<'_, SidecarLazy>,
    backend: Option<String>,
    model_id: Option<String>,
) -> Result<Value, String> {
    let params = json!({
        "backend": backend.unwrap_or_else(|| "auto".to_string()),
        "model_id": model_id,
    });
    map_err(sidecar.call("check_model", params).await)
}

#[tauri::command]
pub async fn probe_audio(
    sidecar: State<'_, SidecarLazy>,
    audio: String,
) -> Result<Value, String> {
    map_err(sidecar.call("probe_audio", json!({ "audio": audio })).await)
}

#[tauri::command]
pub async fn transcribe(
    sidecar: State<'_, SidecarLazy>,
    audio: String,
    backend: Option<String>,
    model_id: Option<String>,
    language: Option<String>,
    initial_prompt: Option<String>,
) -> Result<Value, String> {
    let params = json!({
        "audio": audio,
        "backend": backend.unwrap_or_else(|| "auto".into()),
        "model_id": model_id,
        "language": language.unwrap_or_else(|| "zh".into()),
        "initial_prompt": initial_prompt.unwrap_or_default(),
    });
    map_err(sidecar.call("transcribe", params).await)
}

#[tauri::command]
pub async fn correct_segments(
    sidecar: State<'_, SidecarLazy>,
    segments: Value,
    provider: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    batch_size: Option<u32>,
    context_hint: Option<String>,
    use_glossary: Option<bool>,
    concurrency: Option<u32>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    top_p: Option<f64>,
    frequency_penalty: Option<f64>,
    presence_penalty: Option<f64>,
) -> Result<Value, String> {
    let n_segments = segments.as_array().map(|a| a.len()).unwrap_or(0);
    log_cmd!("correct_segments", "n_segments={n_segments}");
    let provider = provider.unwrap_or_else(|| "deepseek".into());
    let api_key = match secrets::get_api_key(&provider).map_err(|e| format!("{e:#}"))? {
        Some(k) => k,
        None => return Err(format!("No API key stored for provider {provider:?}")),
    };
    tracing::info!(target: "cmd", "  api_key={}*** model={:?}", &api_key[..6], model);

    let params = json!({
        "segments": segments,
        "api_key": api_key,
        "base_url": base_url.unwrap_or_else(|| "https://api.deepseek.com".into()),
        "model": model.unwrap_or_else(|| "deepseek-v4-flash".into()),
        "mode": mode.unwrap_or_else(|| "medium".into()),
        "batch_size": batch_size.unwrap_or(20),
        "context_hint": context_hint.unwrap_or_default(),
        "use_glossary": use_glossary.unwrap_or(true),
        "concurrency": concurrency.unwrap_or(5),
        "temperature": temperature.unwrap_or(0.1),
        "max_tokens": max_tokens.unwrap_or(8192),
        "top_p": top_p.unwrap_or(1.0),
        "frequency_penalty": frequency_penalty.unwrap_or(0.0),
        "presence_penalty": presence_penalty.unwrap_or(0.0),
    });
    let payload_size = serde_json::to_string(&params).map(|s| s.len()).unwrap_or(0);
    tracing::info!(target: "cmd", "  forwarding to sidecar (payload_size={payload_size} bytes)");
    let r = map_err(sidecar.call("correct", params).await);
    tracing::info!(target: "cmd", "  correct_segments returned: ok={}", r.is_ok());
    r
}

#[tauri::command]
pub async fn polish_article(
    sidecar: State<'_, SidecarLazy>,
    segments: Value,
    provider: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    top_p: Option<f64>,
    frequency_penalty: Option<f64>,
    presence_penalty: Option<f64>,
) -> Result<Value, String> {
    let provider = provider.unwrap_or_else(|| "deepseek".into());
    let api_key = match secrets::get_api_key(&provider).map_err(|e| format!("{e:#}"))? {
        Some(k) => k,
        None => return Err(format!("No API key stored for provider {provider:?}")),
    };

    let params = json!({
        "segments": segments,
        "api_key": api_key,
        "base_url": base_url.unwrap_or_else(|| "https://api.deepseek.com".into()),
        "model": model.unwrap_or_else(|| "deepseek-v4-flash".into()),
        "temperature": temperature.unwrap_or(0.3),
        "max_tokens": max_tokens.unwrap_or(384000),
        "top_p": top_p.unwrap_or(1.0),
        "frequency_penalty": frequency_penalty.unwrap_or(0.0),
        "presence_penalty": presence_penalty.unwrap_or(0.0),
    });
    map_err(sidecar.call("polish", params).await)
}

// ---- correction control (pause / resume / cancel) ----

#[tauri::command]
pub async fn correct_pause(sidecar: State<'_, SidecarLazy>) -> Result<Value, String> {
    log_cmd!("correct_pause");
    map_err(sidecar.call("correct_pause", json!({})).await)
}

#[tauri::command]
pub async fn correct_resume(sidecar: State<'_, SidecarLazy>) -> Result<Value, String> {
    log_cmd!("correct_resume");
    map_err(sidecar.call("correct_resume", json!({})).await)
}

#[tauri::command]
pub async fn correct_cancel(sidecar: State<'_, SidecarLazy>) -> Result<Value, String> {
    log_cmd!("correct_cancel");
    map_err(sidecar.call("correct_cancel", json!({})).await)
}

#[tauri::command]
pub async fn correct_status(sidecar: State<'_, SidecarLazy>) -> Result<Value, String> {
    map_err(sidecar.call("correct_status", json!({})).await)
}

// ---- secrets ----

#[tauri::command]
pub fn set_api_key(provider: String, api_key: String) -> Result<(), String> {
    secrets::set_api_key(&provider, &api_key).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, String> {
    secrets::get_api_key(&provider)
        .map(|opt| opt.is_some())
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    secrets::delete_api_key(&provider).map_err(|e| format!("{e:#}"))
}

// ---- settings ----

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| settings::settings_path(&d))
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<settings::Settings, String> {
    let path = settings_path(&app)?;
    settings::load(&path).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: settings::Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    crate::settings::save(&path, &settings).map_err(|e| format!("{e:#}"))
}

// ---- model cache ----

#[tauri::command]
pub fn check_model_cache(model_id: String) -> Result<model_check::ModelStatus, String> {
    model_check::check(&model_id).map_err(|e| format!("{e:#}"))
}

// ---- library (auto-saved transcripts) ----

#[tauri::command]
pub fn library_save_raw(args: library::SaveRawArgs) -> Result<library::SavedMeta, String> {
    log_cmd!("library_save_raw", "stem={}", args.stem);
    library::save_raw(args).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn library_save_corrected(
    args: library::SaveCorrectedArgs,
) -> Result<library::SavedMeta, String> {
    log_cmd!("library_save_corrected", "stem={}", args.stem);
    library::save_corrected(args).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn library_save_polished(
    args: library::SavePolishedArgs,
) -> Result<library::SavedMeta, String> {
    log_cmd!("library_save_polished", "stem={}", args.stem);
    library::save_polished(args).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn library_list() -> Result<Vec<library::SavedMeta>, String> {
    library::list_library().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn library_load(stem: String) -> Result<library::LoadedTask, String> {
    library::load_task(&stem).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn library_delete(stem: String) -> Result<(), String> {
    library::delete_task(&stem).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn library_archive(stem: String) -> Result<Option<String>, String> {
    log_cmd!("library_archive", "stem={}", stem);
    library::archive_task(&stem).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn library_root_path() -> Result<String, String> {
    Ok(library::library_root().to_string_lossy().into_owned())
}

// ---- articles (固化知识库) ----

#[tauri::command]
pub fn article_save(args: articles::SaveArticleArgs) -> Result<articles::ArticleMeta, String> {
    log_cmd!("article_save", "title={}", args.title);
    articles::save_article(args).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn article_list() -> Result<Vec<articles::ArticleMeta>, String> {
    articles::list_articles().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn article_delete(filename: String) -> Result<(), String> {
    articles::delete_article(&filename).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn article_rename(old_filename: String, new_title: String) -> Result<articles::ArticleMeta, String> {
    articles::rename_article(&old_filename, &new_title).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn article_read(filename: String) -> Result<String, String> {
    articles::read_article(&filename).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn articles_root_path() -> Result<String, String> {
    Ok(articles::articles_root().to_string_lossy().into_owned())
}
