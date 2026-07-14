//! Bridge between the WebView frontend and the `omp` engine sidecar.
//!
//! The engine runs as a separate process in RPC mode (`omp --mode rpc-ui`),
//! speaking newline-delimited JSON (NDJSON) over stdio:
//!   - frontend -> engine: one JSON command per line on stdin
//!   - engine -> frontend: one JSON frame per line on stdout
//!
//! This module owns the child process. It exposes three Tauri commands
//! (`start_engine`, `send_rpc`, `stop_engine`) and forwards engine output to
//! the WebView as Tauri events:
//!   - `rpc://frame`  — one stdout line (a JSON frame) from the engine
//!   - `rpc://stderr` — one stderr line (diagnostics/logs)
//!   - `rpc://exit`   — engine stdout closed (process exited)

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

pub const FRAME_EVENT: &str = "rpc://frame";
pub const STDERR_EVENT: &str = "rpc://stderr";
pub const EXIT_EVENT: &str = "rpc://exit";

/// Holds the running engine process. `None` when no engine is running.
#[derive(Default)]
pub struct EngineState {
    inner: Mutex<Option<Engine>>,
}

struct Engine {
    child: Child,
    stdin: ChildStdin,
}

impl EngineState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Deserialize, Default)]
pub struct StartArgs {
    /// Workspace directory the agent should operate in. Defaults to the
    /// process working directory when omitted.
    pub cwd: Option<String>,
}

/// Resolve the argv used to launch the engine.
///
/// Override with `OMP_ENGINE_ARGV` (a JSON array of strings) for development —
/// e.g. run from source:
///   `["bun", "<repo>/packages/coding-agent/src/cli.ts", "--mode", "rpc-ui"]`
/// Default (production): the bundled `omp` sidecar on PATH.
/// Locate the engine program. In a packaged app the `omp` sidecar sits next to
/// the main executable (Tauri strips the target-triple suffix from `externalBin`
/// when bundling); in development it is resolved from PATH. `OMP_ENGINE_ARGV`
/// (handled in {@link engine_argv}) overrides both.
fn resolve_engine_program() -> String {
    let name = if cfg!(windows) { "omp.exe" } else { "omp" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    "omp".to_string()
}

#[cfg(debug_assertions)]
fn dev_source_engine_argv() -> Option<Vec<String>> {
    let cli = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("coding-agent")
        .join("src")
        .join("cli.ts");
    if !cli.is_file() {
        return None;
    }
    Some(vec![
        "bun".to_string(),
        cli.to_string_lossy().into_owned(),
        "--mode".to_string(),
        "rpc-ui".to_string(),
    ])
}

#[cfg(not(debug_assertions))]
fn dev_source_engine_argv() -> Option<Vec<String>> {
    None
}

fn engine_argv() -> Vec<String> {
    if let Ok(raw) = std::env::var("OMP_ENGINE_ARGV") {
        if let Ok(argv) = serde_json::from_str::<Vec<String>>(&raw) {
            if !argv.is_empty() {
                return argv;
            }
        }
    }
    if let Some(argv) = dev_source_engine_argv() {
        return argv;
    }
    vec![resolve_engine_program(), "--mode".to_string(), "rpc-ui".to_string()]
}

#[tauri::command]
pub fn start_engine(
    app: AppHandle,
    state: State<'_, EngineState>,
    args: StartArgs,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    // Replace any running engine (e.g. when the user switches workspace) so a
    // restart never races against a not-yet-reaped previous child. Reap the whole
    // tree, not just the direct child, or LSP/bash grandchildren leak per switch.
    if let Some(mut existing) = guard.take() {
        reap_process_tree(&mut existing.child);
    }

    let argv = engine_argv();
    let (program, rest) = argv.split_first().ok_or("empty engine argv")?;

    let mut cmd = Command::new(program);
    cmd.args(rest);
    // The engine gates `setTitle` behind PI_RPC_EMIT_TITLE (see rpc-mode.ts
    // shouldEmitRpcTitles). This desktop host renders the title as the window
    // document title, so opt in — otherwise setTitle is silently dropped.
    cmd.env("PI_RPC_EMIT_TITLE", "1");
    if let Some(cwd) = args.cwd.as_deref() {
        if !cwd.is_empty() {
            cmd.current_dir(cwd);
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Put the engine in its own process group so shutdown can signal the whole
    // tree (the engine spawns bash/eval/LSP children). On Unix the group id
    // equals the child pid; `stop_engine` kills the negative pgid. Windows has
    // no fork/pgid — there we reap the tree via `taskkill /T` in stop_engine.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn engine '{program}': {e}"))?;

    let stdout = child.stdout.take().ok_or("engine stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("engine stderr unavailable")?;
    let stdin = child.stdin.take().ok_or("engine stdin unavailable")?;

    // stdout reader: forward each NDJSON line to the WebView.
    {
        let app = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        let _ = app.emit(FRAME_EVENT, line);
                    }
                    Err(_) => break,
                }
            }
            let _ = app.emit(EXIT_EVENT, ());
        });
    }

    // stderr reader: forward diagnostics.
    {
        let app = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app.emit(STDERR_EVENT, line);
            }
        });
    }

    *guard = Some(Engine { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn send_rpc(state: State<'_, EngineState>, line: String) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let engine = guard.as_mut().ok_or("engine not started")?;
    engine
        .stdin
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    engine.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    engine.stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn stop_engine(state: State<'_, EngineState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(mut engine) = guard.take() {
        reap_process_tree(&mut engine.child);
    }
    Ok(())
}

/// Terminate the engine and its whole descendant tree (the engine spawns
/// bash/eval/LSP children). Leaving them behind leaks processes on every
/// workspace switch and app exit.
fn reap_process_tree(child: &mut Child) {
    let pid = child.id();

    #[cfg(unix)]
    {
        // The child leads its own process group (set at spawn via process_group(0)),
        // so a negative pid signals every process in the group. SIGTERM first for a
        // graceful stop, then SIGKILL as a backstop — kill(2) on the group is
        // cheaper and more reliable than walking the process table.
        unsafe {
            libc_kill(-(pid as i32), SIGTERM);
        }
        // Give the tree a brief moment to exit on SIGTERM before forcing.
        std::thread::sleep(std::time::Duration::from_millis(150));
        unsafe {
            libc_kill(-(pid as i32), SIGKILL);
        }
    }

    #[cfg(windows)]
    {
        // No process groups on Windows; `taskkill /T` walks and kills the tree
        // rooted at the engine pid. /F forces termination; errors (already-exited)
        // are ignored.
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    // Reap the direct child so it doesn't linger as a zombie (Unix) / handle
    // (Windows). kill() is a no-op if the signal above already took it down.
    let _ = child.kill();
    let _ = child.wait();
}

// Minimal libc bindings for the Unix group-kill path. Avoids pulling the whole
// `libc`/`nix` crate for two symbols. `kill(2)` with a negative pid targets the
// process group; the constants match Linux/macOS/BSD (POSIX-fixed values).
#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;
#[cfg(unix)]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    // engine_argv() reads a process-global env var, so these assertions share one
    // #[test] to avoid racing other tests that might read the environment.
    #[test]
    fn engine_argv_resolution() {
        // OMP_ENGINE_ARGV override wins and is parsed as a JSON string array.
        // SAFETY: single-threaded within this test; no other test touches this var.
        unsafe {
            std::env::set_var("OMP_ENGINE_ARGV", r#"["bun","cli.ts","--mode","rpc-ui"]"#);
        }
        assert_eq!(engine_argv(), vec!["bun", "cli.ts", "--mode", "rpc-ui"]);

        // Malformed JSON falls through to the default resolution (never panics).
        unsafe {
            std::env::set_var("OMP_ENGINE_ARGV", "not json");
        }
        let argv = engine_argv();
        assert_eq!(argv.last().map(String::as_str), Some("rpc-ui"));
        assert!(argv.contains(&"--mode".to_string()));

        // Empty array is ignored (treated as absent), same default fallthrough.
        unsafe {
            std::env::set_var("OMP_ENGINE_ARGV", "[]");
        }
        assert_eq!(engine_argv().last().map(String::as_str), Some("rpc-ui"));

        unsafe {
            std::env::remove_var("OMP_ENGINE_ARGV");
        }
    }

    #[test]
    fn resolve_engine_program_resolves_to_omp() {
        // With no sibling binary next to the test harness exe, resolution falls
        // through to the bare `omp` program name (found on PATH at runtime). When a
        // sibling IS found (packaged app), it's an absolute path ending in the
        // platform binary name.
        let prog = resolve_engine_program();
        let platform_name = if cfg!(windows) { "omp.exe" } else { "omp" };
        assert!(
            prog == "omp" || prog.ends_with(platform_name),
            "unexpected engine program: {prog}"
        );
    }
}
