//! Whisper model cache detection.
//!
//! Standard HuggingFace cache layout: `~/.cache/huggingface/hub/models--<org>--<name>/`.

use anyhow::Result;
use std::path::PathBuf;

pub fn hf_cache_root() -> PathBuf {
    if let Ok(p) = std::env::var("HF_HOME") {
        return PathBuf::from(p).join("hub");
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".cache").join("huggingface").join("hub");
    }
    PathBuf::from(".cache/huggingface/hub")
}

pub fn cache_dir_for(model_id: &str) -> PathBuf {
    let dir_name = format!("models--{}", model_id.replace('/', "--"));
    hf_cache_root().join(dir_name)
}

#[derive(Debug, serde::Serialize)]
pub struct ModelStatus {
    pub model_id: String,
    pub exists: bool,
    pub path: Option<String>,
}

pub fn check(model_id: &str) -> Result<ModelStatus> {
    let path = cache_dir_for(model_id);
    let exists = path.exists();
    Ok(ModelStatus {
        model_id: model_id.to_string(),
        exists,
        path: if exists { Some(path.to_string_lossy().into_owned()) } else { None },
    })
}
