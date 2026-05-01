//! Python sidecar manager.
//!
//! Lazy-initialised on first command call to avoid spawning child processes during
//! `applicationDidFinishLaunching` on macOS Tahoe (which causes a non-unwinding panic).

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex, OnceCell};

use crate::ipc::{IpcEnvelope, ProgressEvent};

pub type ProgressReceiver = mpsc::UnboundedReceiver<ProgressEvent>;
pub type ProgressSender = mpsc::UnboundedSender<ProgressEvent>;

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>;

#[derive(Clone)]
pub struct SidecarHandle {
    next_id: Arc<AtomicU64>,
    pending: PendingMap,
    stdin: Arc<Mutex<ChildStdin>>,
    progress_tx: ProgressSender,
    _child: Arc<Mutex<Child>>,
}

impl SidecarHandle {
    /// Spawn `python -m scribe_py ipc`.
    pub async fn spawn(python: PathBuf, scribe_py_dir: PathBuf) -> Result<(Self, ProgressReceiver)> {
        let mut cmd = Command::new(&python);
        cmd.args(["-m", "scribe_py", "ipc"])
            .env("PYTHONPATH", scribe_py_dir.join("src"))
            .env("PYTHONUNBUFFERED", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn sidecar at {}", python.display()))?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin on sidecar"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout on sidecar"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr on sidecar"))?;

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (progress_tx, progress_rx) = mpsc::unbounded_channel::<ProgressEvent>();

        // stderr → tracing
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                tracing::warn!(target: "scribe_py.stderr", "{}", line);
            }
        });

        // stdout → dispatch
        let pending_for_reader = pending.clone();
        let progress_tx_for_reader = progress_tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<IpcEnvelope>(&line) {
                    Ok(IpcEnvelope::Response { id, result, error }) => {
                        let outcome = match (result, error) {
                            (Some(v), None) => Ok(v),
                            (_, Some(e)) => Err(anyhow!("sidecar error: {}", e.message)),
                            (None, None) => Err(anyhow!("sidecar response missing both result and error")),
                        };
                        if let Some(tx) = pending_for_reader.lock().await.remove(&id) {
                            let _ = tx.send(outcome);
                        } else {
                            tracing::warn!("orphan sidecar response id={id}");
                        }
                    }
                    Ok(IpcEnvelope::Progress(ev)) => {
                        let _ = progress_tx_for_reader.send(ev);
                    }
                    Err(e) => {
                        tracing::error!("malformed sidecar line: {e}; raw={line}");
                    }
                }
            }
            tracing::info!("sidecar stdout reader exited");
        });

        Ok((
            SidecarHandle {
                next_id: Arc::new(AtomicU64::new(1)),
                pending,
                stdin: Arc::new(Mutex::new(stdin)),
                progress_tx,
                _child: Arc::new(Mutex::new(child)),
            },
            progress_rx,
        ))
    }

    /// Send a JSON-RPC request and wait for the response.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();

        self.pending.lock().await.insert(id, tx);

        let payload = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&payload)? + "\n";

        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
        }

        rx.await
            .map_err(|_| anyhow!("sidecar dropped response channel for id={id}"))?
    }

    #[allow(dead_code)]
    pub fn progress_sender(&self) -> ProgressSender {
        self.progress_tx.clone()
    }
}

// ============================================================================
// Lazy-init wrapper
// ============================================================================

/// Holder put into Tauri state. Sidecar is spawned on first access.
pub struct SidecarLazy {
    cell: OnceCell<SidecarHandle>,
    python: PathBuf,
    scribe_py_dir: PathBuf,
    /// AppHandle is needed to forward progress events once the sidecar starts.
    app: AppHandle,
}

impl SidecarLazy {
    pub fn new(app: AppHandle, python: PathBuf, scribe_py_dir: PathBuf) -> Self {
        Self {
            cell: OnceCell::new(),
            python,
            scribe_py_dir,
            app,
        }
    }

    pub async fn handle(&self) -> Result<&SidecarHandle> {
        self.cell
            .get_or_try_init(|| async {
                tracing::info!(
                    "(lazy) spawning sidecar python={} dir={}",
                    self.python.display(),
                    self.scribe_py_dir.display()
                );
                let (handle, mut progress_rx) =
                    SidecarHandle::spawn(self.python.clone(), self.scribe_py_dir.clone()).await?;
                // forward progress events
                let app = self.app.clone();
                tokio::spawn(async move {
                    while let Some(ev) = progress_rx.recv().await {
                        let topic = format!("scribe://progress/{}", ev.method);
                        if let Err(e) = app.emit(&topic, &ev.data) {
                            tracing::warn!("emit progress failed: {e}");
                        }
                    }
                });
                tracing::info!("sidecar handle ready (lazy)");
                Ok::<SidecarHandle, anyhow::Error>(handle)
            })
            .await
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.handle().await?.call(method, params).await
    }
}

