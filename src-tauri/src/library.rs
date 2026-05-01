//! Library persistence — saves transcribe/correct/polish outputs to
//! `<project_root>/transcripts/<stem>/` and lists them back to the frontend.
//!
//! Layout per task:
//!   transcripts/雅各书一章/
//!   ├── 雅各书一章.txt              (raw segments with timestamps)
//!   ├── 雅各书一章.srt
//!   ├── 雅各书一章.json             (full TranscribeResult)
//!   ├── 雅各书一章_corrected.txt
//!   ├── 雅各书一章_corrected.srt
//!   ├── 雅各书一章_corrected.json   (with original_text + diff metadata)
//!   ├── 雅各书一章_diff.txt
//!   ├── 雅各书一章_完整版.txt       (polished article)
//!   └── task.json                    (cross-stage metadata)

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const LIBRARY_DIR_NAME: &str = "transcripts";

/// Resolve a development-time project root (LocalScribe source tree).
///
/// Returns `Some` when we can find a tree containing both `package.json` and
/// `scribe-py/`. Returns `None` when running from a bundled `.app` — callers
/// must use `user_data_root()` for writable data and `crate::bundle_resources_dir()`
/// for embedded resources.
pub fn dev_project_root() -> Option<PathBuf> {
    fn looks_ok(p: &Path) -> bool {
        p.join("package.json").exists() && p.join("scribe-py").exists()
    }

    if let Ok(env) = std::env::var("LOCALSCRIBE_DEV_ROOT") {
        let r = PathBuf::from(env);
        if looks_ok(&r) {
            return Some(r);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur: Option<&Path> = exe.parent();
        while let Some(p) = cur {
            if looks_ok(p) {
                return Some(p.to_path_buf());
            }
            cur = p.parent();
        }
    }
    if let Some(parent) = std::env::current_dir().ok().and_then(|c| c.parent().map(|p| p.to_path_buf())) {
        if looks_ok(&parent) {
            return Some(parent);
        }
    }
    None
}

/// Writable user-data root.
///
/// - **Bundled `.app`** → `~/Library/Application Support/LocalScribe/`
///   (per macOS conventions; survives app upgrades/reinstalls)
/// - **Dev**            → source tree root (so editing the code keeps your
///   articles + transcripts visible inside `LocalScribe/`)
/// - **Fallback**       → cwd (last resort)
pub fn user_data_root() -> PathBuf {
    if crate::bundle_resources_dir().is_some() {
        if let Some(home) = dirs::home_dir() {
            let p = home.join("Library/Application Support/LocalScribe");
            let _ = std::fs::create_dir_all(&p);
            return p;
        }
    }
    if let Some(dev) = dev_project_root() {
        return dev;
    }
    if let Some(home) = dirs::home_dir() {
        let p = home.join("Library/Application Support/LocalScribe");
        let _ = std::fs::create_dir_all(&p);
        return p;
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Backwards-compat alias retained for callers that need the LocalScribe folder.
/// Equivalent to `user_data_root()`.
pub fn project_root() -> PathBuf {
    user_data_root()
}

pub fn library_root() -> PathBuf {
    user_data_root().join(LIBRARY_DIR_NAME)
}

fn task_dir(stem: &str) -> PathBuf {
    library_root().join(stem)
}

fn ensure_dir(p: &Path) -> Result<()> {
    std::fs::create_dir_all(p).with_context(|| format!("create {}", p.display()))?;
    Ok(())
}

fn write_file(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    std::fs::write(path, contents).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

// ============================================================================
// Save APIs (called from Tauri commands)
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct SaveRawArgs {
    pub stem: String,
    pub audio_filename: String,
    pub txt: String,
    pub srt: String,
    pub json: String,
    /// Whole TranscribeResult so we can render task summaries on history list.
    pub result: Value,
}

#[derive(Debug, Deserialize)]
pub struct SaveCorrectedArgs {
    pub stem: String,
    pub txt: String,
    pub srt: String,
    pub json: String,
    pub diff: String,
    pub model: String,
    pub changed: u64,
    pub total: u64,
    #[serde(default)]
    pub glossary: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct SavePolishedArgs {
    pub stem: String,
    pub text: String,
    pub model: String,
    /// "corrected" 或 "raw" — 表明排版输入用的是校对稿还是原始转录
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Default, Debug, Serialize, Deserialize, Clone)]
pub struct SavedMeta {
    pub stem: String,
    pub audio_filename: String,
    pub duration: f64,
    pub segments: u64,
    pub backend: String,
    pub model_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub has_corrected: bool,
    pub has_polished: bool,
    pub correction_model: Option<String>,
    pub correction_changed: Option<u64>,
    pub correction_glossary: Option<Value>,
    pub polish_model: Option<String>,
    pub polish_source: Option<String>,
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn meta_path(stem: &str) -> PathBuf {
    task_dir(stem).join("task.json")
}

fn load_meta(stem: &str) -> SavedMeta {
    let p = meta_path(stem);
    if !p.exists() {
        let mut m = SavedMeta::default();
        m.stem = stem.into();
        return m;
    }
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<SavedMeta>(&s).ok())
        .unwrap_or_else(|| {
            let mut m = SavedMeta::default();
            m.stem = stem.into();
            m
        })
}

fn save_meta(meta: &SavedMeta) -> Result<()> {
    let p = meta_path(&meta.stem);
    write_file(&p, &serde_json::to_string_pretty(meta)?)
}

pub fn save_raw(args: SaveRawArgs) -> Result<SavedMeta> {
    let dir = task_dir(&args.stem);
    ensure_dir(&dir)?;
    write_file(&dir.join(format!("{}.txt", args.stem)), &args.txt)?;
    write_file(&dir.join(format!("{}.srt", args.stem)), &args.srt)?;
    write_file(&dir.join(format!("{}.json", args.stem)), &args.json)?;

    let mut meta = load_meta(&args.stem);
    let now = now_ts();
    if meta.created_at == 0 {
        meta.created_at = now;
    }
    meta.updated_at = now;
    meta.stem = args.stem.clone();
    meta.audio_filename = args.audio_filename.clone();
    if let Some(d) = args.result.get("duration").and_then(|v| v.as_f64()) {
        meta.duration = d;
    }
    if let Some(s) = args.result.get("segments").and_then(|v| v.as_array()) {
        meta.segments = s.len() as u64;
    }
    if let Some(b) = args.result.get("backend").and_then(|v| v.as_str()) {
        meta.backend = b.into();
    }
    if let Some(m) = args.result.get("model_id").and_then(|v| v.as_str()) {
        meta.model_id = m.into();
    }
    save_meta(&meta)?;
    Ok(meta)
}

pub fn save_corrected(args: SaveCorrectedArgs) -> Result<SavedMeta> {
    let dir = task_dir(&args.stem);
    ensure_dir(&dir)?;
    write_file(&dir.join(format!("{}_corrected.txt", args.stem)), &args.txt)?;
    write_file(&dir.join(format!("{}_corrected.srt", args.stem)), &args.srt)?;
    write_file(&dir.join(format!("{}_corrected.json", args.stem)), &args.json)?;
    write_file(&dir.join(format!("{}_diff.txt", args.stem)), &args.diff)?;

    let mut meta = load_meta(&args.stem);
    meta.has_corrected = true;
    meta.correction_model = Some(args.model);
    meta.correction_changed = Some(args.changed);
    meta.correction_glossary = args.glossary;
    meta.updated_at = now_ts();
    save_meta(&meta)?;
    Ok(meta)
}

pub fn save_polished(args: SavePolishedArgs) -> Result<SavedMeta> {
    let dir = task_dir(&args.stem);
    ensure_dir(&dir)?;
    let body = format!(
        "# {} — 完整文字稿\n# 排版 {}\n\n{}\n",
        args.stem, args.model, args.text
    );
    write_file(&dir.join(format!("{}_完整版.txt", args.stem)), &body)?;

    let mut meta = load_meta(&args.stem);
    meta.has_polished = true;
    meta.polish_model = Some(args.model);
    meta.polish_source = args.source;
    meta.updated_at = now_ts();
    save_meta(&meta)?;
    Ok(meta)
}

// ============================================================================
// List & load
// ============================================================================

pub fn list_library() -> Result<Vec<SavedMeta>> {
    let root = library_root();
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in std::fs::read_dir(&root).with_context(|| format!("read {}", root.display()))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = load_meta(&name);
        if !meta.stem.is_empty() && meta.created_at > 0 {
            out.push(meta);
        }
    }
    out.sort_by_key(|m| -m.updated_at);
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct LoadedTask {
    pub meta: SavedMeta,
    pub raw_json: Value,
    pub corrected_json: Option<Value>,
    pub polished_text: Option<String>,
}

pub fn load_task(stem: &str) -> Result<LoadedTask> {
    let dir = task_dir(stem);
    let raw_path = dir.join(format!("{stem}.json"));
    let raw_text = std::fs::read_to_string(&raw_path)
        .with_context(|| format!("read {}", raw_path.display()))?;
    let raw_json: Value = serde_json::from_str(&raw_text)?;

    let corrected_path = dir.join(format!("{stem}_corrected.json"));
    let corrected_json = std::fs::read_to_string(&corrected_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    let polished_path = dir.join(format!("{stem}_完整版.txt"));
    let polished_text = std::fs::read_to_string(&polished_path).ok().map(|s| {
        // Strip the two `# ...` header lines we wrote, return body only.
        let mut body_start = 0;
        let mut header_lines = 0;
        for (i, line) in s.lines().enumerate() {
            if line.starts_with('#') {
                header_lines += 1;
                continue;
            }
            if header_lines > 0 && line.trim().is_empty() {
                continue;
            }
            body_start = s
                .lines()
                .take(i)
                .map(|l| l.len() + 1)
                .sum::<usize>();
            break;
        }
        s[body_start..].trim_start().trim_end().to_string()
    });

    Ok(LoadedTask {
        meta: load_meta(stem),
        raw_json,
        corrected_json,
        polished_text,
    })
}

pub fn delete_task(stem: &str) -> Result<()> {
    let dir = task_dir(stem);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).with_context(|| format!("rm -rf {}", dir.display()))?;
    }
    Ok(())
}

/// 把已存在的 `<stem>/` 重命名为 `<stem>-YYYYMMDD-HHMM/` 防覆盖,返回新路径。
pub fn archive_task(stem: &str) -> Result<Option<String>> {
    let dir = task_dir(stem);
    if !dir.exists() {
        return Ok(None);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Format YYYYMMDD-HHMM (UTC, simple)
    let secs = now;
    let days = secs / 86400 + 719162; // 1970-01-01 = 719162 days from year 0 in proleptic Gregorian
    // simple date math without chrono
    let (year, month, day) = days_to_ymd(days);
    let hour = (secs % 86400) / 3600;
    let minute = (secs % 3600) / 60;
    let tag = format!("{:04}{:02}{:02}-{:02}{:02}", year, month, day, hour, minute);

    let mut new_name = format!("{stem}-{tag}");
    let mut new_path = library_root().join(&new_name);
    let mut suffix = 0;
    while new_path.exists() {
        suffix += 1;
        new_name = format!("{stem}-{tag}-{suffix}");
        new_path = library_root().join(&new_name);
    }
    std::fs::rename(&dir, &new_path).with_context(|| {
        format!("archive rename {} → {}", dir.display(), new_path.display())
    })?;

    // Update meta inside archived dir to reflect new stem
    let meta_path = new_path.join("task.json");
    if meta_path.exists() {
        if let Ok(raw) = std::fs::read_to_string(&meta_path) {
            if let Ok(mut meta) = serde_json::from_str::<SavedMeta>(&raw) {
                meta.stem = new_name.clone();
                let _ = save_meta(&meta);
            }
        }
    }
    Ok(Some(new_path.to_string_lossy().into_owned()))
}

/// Convert days since year 0 (proleptic) to (year, month, day).
fn days_to_ymd(days: i64) -> (i64, i64, i64) {
    let mut d = days;
    let mut year = 0i64;
    loop {
        let y_days = if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 { 366 } else { 365 };
        if d < y_days { break; }
        d -= y_days;
        year += 1;
    }
    let month_days = if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 0;
    while d >= month_days[month] {
        d -= month_days[month];
        month += 1;
    }
    (year, (month + 1) as i64, (d + 1) as i64)
}
