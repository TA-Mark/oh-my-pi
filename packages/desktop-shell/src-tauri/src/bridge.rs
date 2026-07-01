//! Spawn + health-probe the desktop-bridge child process.
//!
//! Two spawn strategies, tried in order:
//!   1. **Bundled JS via bundled Bun** — `bun run resources/bridge/omp-bridge.js`
//!      (production). Produced by `bun run prep-sidecar` before each Tauri
//!      build. We do NOT use `bun build --compile` for the bridge because
//!      the resulting standalone exe cannot see napi (`.node`) exports for
//!      the pi-natives addon at runtime (works fine when required by a plain
//!      `bun` runtime). See prep-sidecar.ts for context.
//!   2. **Bun source (dev)** — `bun run packages/desktop-bridge/src/server.ts`
//!      from whatever copy of the monorepo we can locate.
//!
//! Either way we hold the child handle and kill it on app exit.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
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
    // Tauri strips the target-triple suffix in the final bundle, but keeps it
    // during `cargo run` from src-tauri. Try the stripped form first (release
    // installer layout), then the triple-suffixed form (dev with prep-deps).
    let stripped = dir.join(format!("bun{ext}"));
    if stripped.exists() {
        return Some(stripped);
    }
    let candidate = dir.join(format!("bun-{TARGET_TRIPLE}{ext}"));
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

pub enum BridgeProcess {
    Plain(Child),
}

impl BridgeProcess {
    pub async fn kill(self) -> Result<()> {
        match self {
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
    eprintln!(
        "  bun:   {}",
        deps.bun_path.as_deref().map(Path::display).map(|d| d.to_string()).unwrap_or_else(|| "(missing)".into())
    );
    eprintln!(
        "  native:{}",
        deps.native_node.as_deref().map(Path::display).map(|d| d.to_string()).unwrap_or_else(|| "(missing)".into())
    );

    let child = spawn_bun_script(app, install_dir.as_deref(), port, &deps)?;
    wait_for_health(port, health_timeout).await?;
    Ok(BridgeProcess::Plain(child))
}

fn spawn_bun_script(app: &AppHandle, install_dir: Option<&std::path::Path>, port: u16, deps: &BundledDeps) -> Result<Child> {
    // Prefer the bundled Bun (lets dev mode work even without system Bun once
    // prep-deps has run); fall back to $BUN_BIN, then `bun` on PATH.
    let bun = deps
        .bun_path
        .as_ref()
        .map(|p| p.display().to_string())
        .or_else(|| std::env::var("BUN_BIN").ok())
        .unwrap_or_else(|| "bun".to_string());
    let entry = locate_bridge_entry(app, install_dir)
        .context("could not locate bridge entry (resources/bridge/omp-bridge.js or packages/desktop-bridge/src/server.ts)")?;

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

fn locate_bridge_entry(app: &AppHandle, install_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    if let Ok(env_path) = std::env::var("OMP_BRIDGE_ENTRY") {
        let p = PathBuf::from(env_path);
        if p.exists() {
            return Some(p);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Production: bundled JS staged by prep-sidecar.ts + shipped as a Tauri
    // resource. Tauri stages resources into `resource_dir()/resources/`; the
    // bundle sits at `resources/bridge/omp-bridge.js`.
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("resources").join("bridge").join("omp-bridge.js"));
    }
    // Dev / manual layouts: look for the raw TS source.
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
