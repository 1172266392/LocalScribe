//! LocalScribe Tauri backend library.
//!
//! Sidecar is **lazy-initialised** on first command call. Spawning the Python child
//! process during `applicationDidFinishLaunching` triggers a non-unwinding panic on
//! macOS Tahoe (26.x), so we defer it.

pub mod articles;
mod commands;
pub mod ipc;
pub mod library;
pub mod model_check;
pub mod secrets;
pub mod settings;
pub mod sidecar;

use std::path::PathBuf;
use tauri::Manager;
use tracing_subscriber::{fmt, EnvFilter};

use crate::sidecar::SidecarLazy;

/// Locate the Python interpreter and the scribe-py package directory.
///
/// Resolution order (first match wins):
///   1. `LOCALSCRIBE_DEV_ROOT` env var override
///   2. cwd's parent (works for `cargo run` / `tauri dev`)
///   3. exe's ancestors (works for some run modes)
///   4. Hardcoded absolute path — for personal-use packaged `.app` on this machine.
///      Replace with PyInstaller-bundled sidecar in the distributable build.
fn dev_python_paths() -> (PathBuf, PathBuf) {
    fn looks_ok(root: &std::path::Path) -> bool {
        root.join(".venv/bin/python3").exists() && root.join("scribe-py").exists()
    }

    if let Ok(p) = std::env::var("LOCALSCRIBE_DEV_ROOT") {
        let r = PathBuf::from(p);
        if looks_ok(&r) {
            return (r.join(".venv/bin/python3"), r.join("scribe-py"));
        }
    }

    if let Some(p) = std::env::current_dir().ok().and_then(|c| c.parent().map(|p| p.to_path_buf())) {
        if looks_ok(&p) {
            return (p.join(".venv/bin/python3"), p.join("scribe-py"));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        while let Some(p) = cur {
            if looks_ok(p) {
                return (p.join(".venv/bin/python3"), p.join("scribe-py"));
            }
            cur = p.parent();
        }
    }

    let hard = PathBuf::from("/Users/apple/gitCommit/SwarmPathAI/LocalScribe");
    (hard.join(".venv/bin/python3"), hard.join("scribe-py"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(true)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Construct the lazy sidecar holder *synchronously* — no child process spawn here.
            let app_handle = app.handle().clone();
            let (python, scribe_py_dir) = dev_python_paths();
            tracing::info!(
                "registering lazy sidecar (python={}, scribe_py_dir={})",
                python.display(),
                scribe_py_dir.display()
            );
            app.manage(SidecarLazy::new(app_handle, python, scribe_py_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::environment,
            commands::check_model,
            commands::probe_audio,
            commands::transcribe,
            commands::correct_segments,
            commands::correct_pause,
            commands::correct_resume,
            commands::correct_cancel,
            commands::correct_status,
            commands::polish_article,
            commands::set_api_key,
            commands::has_api_key,
            commands::delete_api_key,
            commands::load_settings,
            commands::save_settings,
            commands::check_model_cache,
            commands::library_save_raw,
            commands::library_save_corrected,
            commands::library_save_polished,
            commands::library_list,
            commands::library_load,
            commands::library_delete,
            commands::library_archive,
            commands::library_root_path,
            commands::article_save,
            commands::article_list,
            commands::article_delete,
            commands::article_rename,
            commands::article_read,
            commands::articles_root_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LocalScribe");
}
