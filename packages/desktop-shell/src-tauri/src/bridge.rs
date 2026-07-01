//! Spawn + health-probe the desktop-bridge child process.
//!
//! Two spawn strategies, tried in order:
//!   1. **Sidecar** — Tauri-bundled binary at `binaries/omp-bridge` (production).
//!      Produced by `bun run prep-sidecar` before each Tauri build.
//!   2. **Bun script** — `bun run packages/desktop-bridge/src/server.ts` from
//!      whatever copy of the monorepo we can locate (dev).
//!
//! Either way we hold the child handle and kill it on app exit.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::process::{Child, Command};

/// Filename of the precompiled native addon staged into resources/native/.
/// Mirrors the suffix the npm-published `@oh-my-pi/pi-natives-<triple>` ships.
const NATIVE_NODE_FILENAME: &str = if cfg!(target_os = "windows") {
    "pi_natives.win32-x64-baseline.node"
} else if cfg!(target_os = "macos") {
    if cfg!(target_arch = "aarch64") {
        "pi_natives.darwin-arm64.node"
    } else {
        "pi_natives.darwin-x64.node"
    }
} else {
    "pi_natives.linux-x64-gnu.node"
};

/// Rust target triple this binary was built for — used to find the matching
/// sidecar (Tauri stages sidecars as `<name>-<triple>{.exe}` next to the exe).
const TARGET_TRIPLE: &str = env!("TAURI_ENV_TARGET_TRIPLE");

#[derive(Clone, Debug)]
pub struct BundledDeps {
    pub bun_path: Option<PathBuf>,
    pub native_node: Option<PathBuf>,
}

impl BundledDeps {
    pub fn resolve(app: &AppHandle) -> Self {
        let bun_path = resolve_bundled_bun(app);
        let resource_dir = app.path().resource_dir().ok();
        let native_node = resource_dir
            .as_ref()
            .map(|d| d.join("resources").join("native").join(NATIVE_NODE_FILENAME))
            .filter(|p| p.exists());
        Self { bun_path, native_node }
    }
}

fn resolve_bundled_bun(_app: &AppHandle) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let candidate = dir.join(format!("bun-{}{}", TARGET_TRIPLE, ext));
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

pub enum BridgeProcess {
    Sidecar(CommandChild),
    Plain(Child),
}

impl BridgeProcess {
    pub async fn kill(self) -> Result<()> {
        match self {
            Self::Sidecar(child) => {
                let _ = child.kill();
            }
            Self::Plain(mut child) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            }
        }
        Ok(())
    }
}

pub fn resolve_install_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("OMP_DESKTOP_DIR") {
        return Some(PathBuf::from(dir));
    }
    if cfg!(windows) {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return Some(PathBuf::from(local).join("omp-desktop"));
        }
    }
    use tauri::Manager;
    app.path().home_dir().ok().map(|home| home.join(".local").join("share").join("omp-desktop"))
}

pub async fn spawn_and_wait(
    app: &AppHandle,
    install_dir: Option<PathBuf>,
    port: u16,
    health_timeout: Duration,
) -> Result<BridgeProcess> {
    let deps = BundledDeps::resolve(app);
    eprintln!("[desktop-shell] bundled deps:");
    eprintln!("  bun:   {}", deps.bun_path.as_deref().map(Path::display).map(|d| d.to_string()).unwrap_or_else(|| "(missing)".into()));
    eprintln!("  native:{}", deps.native_node.as_deref().map(Path::display).map(|d| d.to_string()).unwrap_or_else(|| "(missing)".into()));

    // Try sidecar first; if missing (dev w/o prep-sidecar), fall back to bun.
    match spawn_sidecar(app, install_dir.as_deref(), port, &deps) {
        Ok(child) => {
            wait_for_health(port, health_timeout).await?;
            return Ok(BridgeProcess::Sidecar(child));
        }
        Err(err) => {
            eprintln!("[desktop-shell] sidecar unavailable, falling back to bun: {err}");
        }
    }

    let child = spawn_bun_script(install_dir.as_deref(), port, &deps)?;
    wait_for_health(port, health_timeout).await?;
    Ok(BridgeProcess::Plain(child))
}

fn spawn_sidecar(
    app: &AppHandle,
    install_dir: Option<&std::path::Path>,
    port: u16,
    deps: &BundledDeps,
) -> Result<CommandChild> {
    let shell = app.shell();
    let mut cmd = shell
        .sidecar("omp-bridge")
        .context("sidecar `omp-bridge` not configured / not bundled")?
        .args(["--port", &port.to_string()]);
    if let Some(dir) = install_dir {
        cmd = cmd.env("OMP_DESKTOP_DIR", dir.display().to_string());
    }
    cmd = cmd.env("OMP_BRIDGE_PORT", port.to_string());
    if let Some(p) = deps.bun_path.as_ref() {
        cmd = cmd.env("OMP_BUNDLED_BUN", p.display().to_string());
    }
    if let Some(p) = deps.native_node.as_ref() {
        cmd = cmd.env("OMP_BUNDLED_NATIVE", p.display().to_string());
    }
    let (_rx, child) = cmd.spawn().context("failed to spawn sidecar")?;
    Ok(child)
}

fn spawn_bun_script(install_dir: Option<&std::path::Path>, port: u16, deps: &BundledDeps) -> Result<Child> {
    // Prefer the bundled Bun (lets dev mode work even without system Bun once
    // prep-deps has run); fall back to $BUN_BIN, then `bun` on PATH.
    let bun = deps
        .bun_path
        .as_ref()
        .map(|p| p.display().to_string())
        .or_else(|| std::env::var("BUN_BIN").ok())
        .unwrap_or_else(|| "bun".to_string());
    let entry = locate_bridge_entry(install_dir)
        .context("could not locate packages/desktop-bridge/src/server.ts")?;

    let mut cmd = Command::new(&bun);
    cmd.arg("run").arg(&entry).arg("--port").arg(port.to_string());
    if let Some(dir) = install_dir {
        cmd.env("OMP_DESKTOP_DIR", dir);
    }
    cmd.env("OMP_BRIDGE_PORT", port.to_string());
    if let Some(p) = deps.bun_path.as_ref() {
        cmd.env("OMP_BUNDLED_BUN", p);
    }
    if let Some(p) = deps.native_node.as_ref() {
        cmd.env("OMP_BUNDLED_NATIVE", p);
    }
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit());
    cmd.stdin(Stdio::null());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .with_context(|| format!("failed to spawn `{bun} run {}`", entry.display()))
}

fn locate_bridge_entry(install_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    if let Ok(env_path) = std::env::var("OMP_BRIDGE_ENTRY") {
        let p = PathBuf::from(env_path);
        if p.exists() {
            return Some(p);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = install_dir {
        candidates.push(dir.join("packages").join("desktop-bridge").join("src").join("server.ts"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            candidates.push(parent.join("desktop-bridge").join("src").join("server.ts"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("..").join("desktop-bridge").join("src").join("server.ts"));
    }
    candidates.into_iter().find(|p| p.exists())
}

async fn wait_for_health(port: u16, timeout: Duration) -> Result<()> {
    let url = format!("http://127.0.0.1:{port}/api/v1/health");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .context("building reqwest client")?;
    let started = Instant::now();
    let mut last_err: Option<String> = None;
    while started.elapsed() < timeout {
        match client.get(&url).send().await {
            Ok(res) if res.status().is_success() => return Ok(()),
            Ok(res) => last_err = Some(format!("HTTP {}", res.status())),
            Err(err) => last_err = Some(err.to_string()),
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(anyhow!("bridge /health never responded (last error: {})", last_err.unwrap_or_default()))
}
