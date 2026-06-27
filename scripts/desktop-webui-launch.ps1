# Oh-My-Pi Desktop WebUI — Launcher (PowerShell)
# Starts the bridge/relay server and opens the WebUI in the default browser.
# Can be run directly or via the Desktop shortcut.

param(
    [string]$InstallDir = "",
    [string]$Port       = "",
    [switch]$Dev,          # dev mode: bun run dev instead of serving dist/
    [switch]$NoBrowser,    # skip auto-open browser
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

# ──────────────────────────────────────────────────────────────────────────────
# Resolve install dir — from param, registry, or env
# ──────────────────────────────────────────────────────────────────────────────
function Get-InstallDirFromRegistry {
    try {
        return (Get-ItemProperty -Path "HKCU:\Software\OhMyPi\Desktop" -Name "InstallDir" -ErrorAction Stop).InstallDir
    } catch { return $null }
}

function Get-ConfiguredPort {
    try {
        return (Get-ItemProperty -Path "HKCU:\Software\OhMyPi\Desktop" -Name "Port" -ErrorAction Stop).Port
    } catch { return "8765" }
}

$SCRIPT_DIR  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$INSTALL_DIR = if ($InstallDir) { $InstallDir }
               elseif ($env:OMP_DESKTOP_DIR) { $env:OMP_DESKTOP_DIR }
               else {
                   $reg = Get-InstallDirFromRegistry
                   if ($reg) { $reg } else { Split-Path $SCRIPT_DIR }
               }

$PORT        = if ($Port) { $Port } else { Get-ConfiguredPort }
$WEB_DIR     = Join-Path $INSTALL_DIR "packages\collab-web"
$DIST_DIR    = Join-Path $WEB_DIR "dist"
$LOG_DIR     = Join-Path $INSTALL_DIR "logs"
$RELAY_LOG   = Join-Path $LOG_DIR "relay-$(Get-Date -Format 'yyyyMMdd').log"
$LOCK_FILE   = Join-Path $LOG_DIR ".launcher.lock"

$APP_URL     = "http://localhost:$PORT"

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────
function Write-Info  { param($m) Write-Host "[omp-desktop] $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "[omp-desktop] ✓ $m" -ForegroundColor Green }
function Write-Warn  { param($m) Write-Host "[omp-desktop] ⚠ $m" -ForegroundColor Yellow }
function Write-Err   { param($m) Write-Host "[omp-desktop] ✗ $m" -ForegroundColor Red }

function Ensure-Dir { param($p) if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null } }

function Test-PortBusy {
    param([int]$p)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $tcp.Connect("127.0.0.1", $p)
        return $true
    } catch { return $false }
    finally { $tcp.Dispose() }
}

function Wait-ForPort {
    param([int]$p, [int]$TimeoutSec = 30)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        if (Test-PortBusy $p) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Stop-ExistingInstance {
    # Kill any existing relay on our port
    $existing = Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue |
                Where-Object { $_.State -eq "Listen" } |
                Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Warn "Port $PORT already in use (PID $existing). Stopping existing instance..."
        Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
    }
}

# ──────────────────────────────────────────────────────────────────────────────
# Pre-checks
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Starting Oh-My-Pi Desktop..."

if (-not (Test-Path $INSTALL_DIR)) {
    Write-Err "Install directory not found: $INSTALL_DIR"
    Write-Err "Run the installer first: scripts\desktop-webui-install.ps1"
    exit 1
}

if (-not $Dev -and -not (Test-Path $DIST_DIR)) {
    Write-Warn "dist/ not found. Triggering build..."
    Push-Location $WEB_DIR
    try {
        bun run build 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Build failed" }
    } finally { Pop-Location }
}

Ensure-Dir $LOG_DIR

# ──────────────────────────────────────────────────────────────────────────────
# Start bridge/relay server
# ──────────────────────────────────────────────────────────────────────────────
Stop-ExistingInstance

Write-Info "Starting bridge server on port $PORT..."

$relayScript = if ($Dev) {
    Join-Path $WEB_DIR "scripts\mock-host.ts"
} else {
    Join-Path $WEB_DIR "scripts\local-relay.ts"
}

if (-not (Test-Path $relayScript)) {
    Write-Err "Relay script not found: $relayScript"
    exit 1
}

$bunArgs = @("run", $relayScript, "--port", $PORT)
if ($Dev) { $bunArgs += "--dev" }

$relayProcess = Start-Process -FilePath "bun" `
    -ArgumentList $bunArgs `
    -WorkingDirectory $WEB_DIR `
    -RedirectStandardOutput $RELAY_LOG `
    -RedirectStandardError  ($RELAY_LOG + ".err") `
    -WindowStyle Hidden `
    -PassThru

if (-not $relayProcess) {
    Write-Err "Failed to start relay server"
    exit 1
}

# Save PID to lock file so we can kill it on next launch
$relayProcess.Id | Set-Content $LOCK_FILE -Encoding UTF8
Write-Ok "Relay server started (PID: $($relayProcess.Id))"

# ──────────────────────────────────────────────────────────────────────────────
# Wait for server ready
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Waiting for server on port $PORT..."
$ready = Wait-ForPort -p ([int]$PORT) -TimeoutSec 30

if (-not $ready) {
    Write-Err "Server did not start on port $PORT within 30s"
    Write-Err "Check logs: $RELAY_LOG"
    Stop-Process -Id $relayProcess.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Ok "Server ready at $APP_URL"

# ──────────────────────────────────────────────────────────────────────────────
# In dev mode: serve via bun dev server instead of dist/
# ──────────────────────────────────────────────────────────────────────────────
$devProcess = $null
if ($Dev) {
    Write-Info "Dev mode: starting bun dev server..."
    $devLog = Join-Path $LOG_DIR "dev-server-$(Get-Date -Format 'yyyyMMdd').log"
    $devProcess = Start-Process -FilePath "bun" `
        -ArgumentList @("run", "dev") `
        -WorkingDirectory $WEB_DIR `
        -RedirectStandardOutput $devLog `
        -RedirectStandardError  ($devLog + ".err") `
        -WindowStyle Normal `
        -PassThru
    Start-Sleep 2
    $APP_URL = "http://localhost:5173"
    Write-Ok "Dev server at $APP_URL"
}

# ──────────────────────────────────────────────────────────────────────────────
# Open browser
# ──────────────────────────────────────────────────────────────────────────────
if (-not $NoBrowser) {
    Write-Info "Opening $APP_URL in default browser..."
    Start-Process $APP_URL
}

Write-Ok "Oh-My-Pi Desktop is running!"
Write-Host ""
Write-Host "  URL    : $APP_URL" -ForegroundColor White
Write-Host "  PID    : $($relayProcess.Id)" -ForegroundColor White
Write-Host "  Logs   : $RELAY_LOG" -ForegroundColor White
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""

# ──────────────────────────────────────────────────────────────────────────────
# Wait and cleanup on Ctrl+C
# ──────────────────────────────────────────────────────────────────────────────
try {
    $relayProcess.WaitForExit()
} finally {
    Write-Info "Shutting down..."
    Stop-Process -Id $relayProcess.Id -Force -ErrorAction SilentlyContinue
    if ($devProcess) { Stop-Process -Id $devProcess.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item $LOCK_FILE -ErrorAction SilentlyContinue
    Write-Ok "Stopped."
}
