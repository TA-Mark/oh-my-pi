# Oh-My-Pi Desktop WebUI — Uninstaller
# Usage: .\scripts\desktop-webui-uninstall.ps1
# Also called from Settings → Apps → Oh-My-Pi Desktop → Uninstall

param(
    [switch]$KeepData,    # keep logs and config, remove only binaries
    [switch]$Silent       # no confirmation prompt
)

$ErrorActionPreference = "SilentlyContinue"

$APP_NAME     = "Oh-My-Pi Desktop"
$APP_ID       = "omp-desktop"
$REGISTRY_KEY = "HKCU:\Software\OhMyPi\Desktop"
$UNINSTALL_KEY = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$APP_ID"

function Write-Info { param($m) Write-Host "  → $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  ⚠ $m" -ForegroundColor Yellow }

# ──────────────────────────────────────────────────────────────────────────────
# Resolve install dir
# ──────────────────────────────────────────────────────────────────────────────
$INSTALL_DIR = $null
try {
    $INSTALL_DIR = (Get-ItemProperty $REGISTRY_KEY -Name "InstallDir" -ErrorAction Stop).InstallDir
} catch {}

if (-not $INSTALL_DIR) {
    $INSTALL_DIR = Join-Path $env:LOCALAPPDATA "omp-desktop"
}

Write-Host ""
Write-Host "  $APP_NAME — Uninstaller" -ForegroundColor Blue
Write-Host "  Install dir: $INSTALL_DIR" -ForegroundColor Gray
Write-Host ""

if (-not $Silent) {
    $confirm = Read-Host "  This will remove $APP_NAME. Continue? [y/N]"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "  Aborted." -ForegroundColor Yellow
        exit 0
    }
}

# ──────────────────────────────────────────────────────────────────────────────
# 1. Stop running instance
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Stopping running instances..."
$lockFile = Join-Path $INSTALL_DIR "logs\.launcher.lock"
if (Test-Path $lockFile) {
    $pid = Get-Content $lockFile -ErrorAction SilentlyContinue
    if ($pid) {
        Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue
        Write-Ok "Stopped process PID $pid"
    }
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}

# Also kill any bun processes from install dir
Get-Process -Name "bun" -ErrorAction SilentlyContinue | Where-Object {
    $_.MainModule.FileName -like "*$INSTALL_DIR*"
} | Stop-Process -Force -ErrorAction SilentlyContinue

# ──────────────────────────────────────────────────────────────────────────────
# 2. Remove shortcuts
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Removing shortcuts..."
$desktopShortcut = "$env:USERPROFILE\Desktop\$APP_NAME.lnk"
if (Test-Path $desktopShortcut) {
    Remove-Item $desktopShortcut -Force
    Write-Ok "Desktop shortcut removed"
}

$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Oh-My-Pi"
if (Test-Path $startMenuDir) {
    Remove-Item $startMenuDir -Recurse -Force
    Write-Ok "Start Menu shortcuts removed"
}

# ──────────────────────────────────────────────────────────────────────────────
# 3. Remove from PATH
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Cleaning PATH..."
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -like "*$INSTALL_DIR*") {
    $newPath = ($userPath -split ";" | Where-Object { $_ -ne $INSTALL_DIR }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Ok "Removed from PATH"
}

# ──────────────────────────────────────────────────────────────────────────────
# 4. Remove registry entries
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Removing registry entries..."
if (Test-Path $REGISTRY_KEY) {
    Remove-Item $REGISTRY_KEY -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "App registry removed"
}
if (Test-Path $UNINSTALL_KEY) {
    Remove-Item $UNINSTALL_KEY -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "Add/Remove Programs entry removed"
}

# ──────────────────────────────────────────────────────────────────────────────
# 5. Remove install directory
# ──────────────────────────────────────────────────────────────────────────────
if (Test-Path $INSTALL_DIR) {
    if ($KeepData) {
        Write-Info "Keeping data (logs/config). Removing only dist and node_modules..."
        @("packages\collab-web\dist", "packages\collab-web\node_modules", "node_modules") | ForEach-Object {
            $p = Join-Path $INSTALL_DIR $_
            if (Test-Path $p) {
                Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
                Write-Ok "Removed $_"
            }
        }
    } else {
        Write-Info "Removing install directory $INSTALL_DIR..."
        # Retry up to 3 times (files may be briefly locked)
        $retries = 3
        while ($retries -gt 0) {
            try {
                Remove-Item $INSTALL_DIR -Recurse -Force -ErrorAction Stop
                Write-Ok "Install directory removed"
                break
            } catch {
                $retries--
                if ($retries -gt 0) { Start-Sleep 1 }
                else { Write-Warn "Could not fully remove $INSTALL_DIR — delete it manually." }
            }
        }
    }
}

Write-Host ""
Write-Host "  ✓ $APP_NAME has been uninstalled." -ForegroundColor Green
Write-Host ""
