# Oh-My-Pi Desktop Bridge — Launcher (PowerShell)
# Starts the bridge server on port 8787 that backs the WebUI installer / launcher / chat pages.
# Intended to be run alongside (or instead of) desktop-webui-launch.ps1.

param(
    [string]$InstallDir = "",
    [string]$Port       = "8787",
    [string]$RelayPort  = "8765",
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

# ──────────────────────────────────────────────────────────────────────────────
# Resolve install dir
# ──────────────────────────────────────────────────────────────────────────────
function Get-InstallDirFromRegistry {
    try {
        return (Get-ItemProperty -Path "HKCU:\Software\OhMyPi\Desktop" -Name "InstallDir" -ErrorAction Stop).InstallDir
    } catch { return $null }
}

$SCRIPT_DIR  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$INSTALL_DIR = if ($InstallDir) { $InstallDir }
               elseif ($env:OMP_DESKTOP_DIR) { $env:OMP_DESKTOP_DIR }
               else {
                   $reg = Get-InstallDirFromRegistry
                   if ($reg) { $reg } else { Split-Path $SCRIPT_DIR }
               }

$BRIDGE_DIR  = Join-Path $INSTALL_DIR "packages\desktop-bridge"
$BRIDGE_ENTRY= Join-Path $BRIDGE_DIR  "src\server.ts"
$LOG_DIR     = Join-Path $INSTALL_DIR "logs"
$BRIDGE_LOG  = Join-Path $LOG_DIR     "bridge-$(Get-Date -Format 'yyyyMMdd').log"

function Write-Info { param($m) Write-Host "[bridge] $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "[bridge] ✓ $m" -ForegroundColor Green }
function Write-Err  { param($m) Write-Host "[bridge] ✗ $m" -ForegroundColor Red }

if (-not (Test-Path $BRIDGE_ENTRY)) {
    Write-Err "Bridge entry not found: $BRIDGE_ENTRY"
    exit 1
}
if (-not (Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
}

# Kill existing bridge on our port
$existing = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
            Where-Object { $_.State -eq "Listen" } |
            Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue
if ($existing) {
    Write-Info "Port $Port in use (PID $existing). Stopping existing bridge..."
    Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
}

Write-Info "Starting bridge on port $Port (relay port: $RelayPort)..."
$env:OMP_DESKTOP_DIR = $INSTALL_DIR
$env:OMP_BRIDGE_PORT = $Port
$env:OMP_RELAY_PORT  = $RelayPort

$bunArgs = @("run", $BRIDGE_ENTRY, "--port", $Port)
$proc = Start-Process -FilePath "bun" `
    -ArgumentList $bunArgs `
    -WorkingDirectory $BRIDGE_DIR `
    -RedirectStandardOutput $BRIDGE_LOG `
    -RedirectStandardError  ($BRIDGE_LOG + ".err") `
    -WindowStyle Hidden `
    -PassThru

if (-not $proc) {
    Write-Err "Failed to start bridge"
    exit 1
}
Write-Ok "Bridge started (PID: $($proc.Id))"
Write-Host "  Logs: $BRIDGE_LOG" -ForegroundColor Gray

if (-not $NoBrowser) {
    Write-Info "Opening WebUI..."
    Start-Process "http://localhost:$RelayPort"
}

Write-Host ""
Write-Host "  URL  : http://localhost:$Port/api/v1" -ForegroundColor White
Write-Host "  PID  : $($proc.Id)" -ForegroundColor White
Write-Host "  Logs : $BRIDGE_LOG" -ForegroundColor White
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""

try {
    $proc.WaitForExit()
} finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
