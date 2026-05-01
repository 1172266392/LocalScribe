//! Persistent app settings — `<app_data_dir>/settings.json`.
//!
//! Stores: model size, default language, output formats, output dir,
//! correction config (provider/base_url/model/mode — but NOT api_key, that's in keychain).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub model_id: String,
    pub backend: String, // "auto" | "mlx" | "ct2"
    pub language: String,
    pub output_formats: Vec<String>, // ["txt", "srt", "json"]
    pub output_dir: Option<String>,
    pub correction: CorrectionSettings,
    pub polish: PolishSettings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct LLMAdvanced {
    pub temperature: f64,
    pub max_tokens: u32,
    pub top_p: f64,
    pub frequency_penalty: f64,
    pub presence_penalty: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct CorrectionSettings {
    pub enabled: bool,
    pub auto_pipeline: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub mode: String, // "light" | "medium" | "heavy"
    pub batch_size: u32,
    pub context_hint: String,
    pub use_glossary: bool,
    pub concurrency: u32,
    pub advanced: LLMAdvanced,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct PolishSettings {
    pub enabled: bool,
    pub model: String,
    pub advanced: LLMAdvanced,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model_id: "mlx-community/whisper-large-v3-turbo".into(),
            backend: "auto".into(),
            language: "zh".into(),
            output_formats: vec!["txt".into(), "srt".into(), "json".into()],
            output_dir: None,
            correction: CorrectionSettings::default(),
            polish: PolishSettings::default(),
        }
    }
}

impl Default for CorrectionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_pipeline: false,
            provider: "deepseek".into(),
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-v4-flash".into(),
            mode: "medium".into(),
            batch_size: 30,
            context_hint: String::new(),
            use_glossary: true,
            concurrency: 15,
            advanced: LLMAdvanced {
                temperature: 0.1,
                max_tokens: 8192,
                top_p: 1.0,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
            },
        }
    }
}

impl Default for PolishSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            model: "deepseek-v4-flash".into(),
            advanced: LLMAdvanced {
                temperature: 0.3,
                max_tokens: 384000,
                top_p: 1.0,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
            },
        }
    }
}

impl Default for LLMAdvanced {
    fn default() -> Self {
        Self {
            temperature: 0.1,
            max_tokens: 8192,
            top_p: 1.0,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
        }
    }
}

pub fn load(path: &Path) -> Result<Settings> {
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("read settings: {}", path.display()))?;
    let mut s: Settings = serde_json::from_str(&raw).with_context(|| "parse settings.json")?;
    let migrated = migrate(&mut s);
    if migrated {
        // 把迁移结果写回磁盘,下次启动直接读新值
        if let Err(e) = save(path, &s) {
            tracing::warn!("settings migration save failed: {e:#}");
        } else {
            tracing::info!("settings migrated to new defaults (concurrency/batch_size)");
        }
    }
    Ok(s)
}

/// 老版本默认值 → 新版本默认值的迁移。返回是否实际改了。
///
/// 仅在用户保留**旧默认值**时才迁移 — 如果用户曾手动改过(比如 concurrency=10),
/// 不动他的选择。
fn migrate(s: &mut Settings) -> bool {
    let mut changed = false;
    if s.correction.concurrency == 5 {
        s.correction.concurrency = 15;
        changed = true;
    }
    if s.correction.batch_size == 20 {
        s.correction.batch_size = 30;
        changed = true;
    }
    changed
}

pub fn save(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let raw = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, raw).with_context(|| format!("write settings: {}", path.display()))?;
    Ok(())
}

/// Resolve the settings file location: `<app_data_dir>/settings.json`.
/// `app_data` should be obtained from Tauri's path resolver in the command layer.
pub fn settings_path(app_data: &Path) -> PathBuf {
    app_data.join("settings.json")
}
