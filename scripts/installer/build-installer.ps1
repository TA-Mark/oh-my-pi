# Oh-My-Pi Desktop WebUI — NSIS Installer Builder
# Builds the Windows .exe installer using makensis (NSIS 3.x)
#
# Requirements:
#   - NSIS 3.x installed (https://nsis.sourceforge.io)
#   - bun installed (https://bun.sh)
#   - collab-web built (bun run build in packages/collab-web)
#
# Usage:
#   .\scripts\installer\build-installer.ps1
#   .\scripts\installer\build-installer.ps1 -Version "1.2.3" -OutDir ".\dist"

param(
    [string]$Version  = "1.0.0",
    [string]$OutDir   = ".\dist\installer",
    [string]$AppName  = "oh-my-pi Desktop",
    [string]$Publisher= "oh-my-pi",
    [string]$NsisExe  = "",          # auto-detected if empty
    [switch]$SkipBuild                # skip bun build step
)

$ErrorActionPreference = "Stop"
$ROOT    = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$WEB_DIR = Join-Path $ROOT "packages\collab-web"
$NSI_FILE= Join-Path $PSScriptRoot "oh-my-pi-desktop.nsi"

# ── Auto-detect makensis ─────────────────────────────────────────────────────
if (-not $NsisExe) {
    $candidates = @(
        "C:\Program Files (x86)\NSIS\makensis.exe",
        "C:\Program Files\NSIS\makensis.exe",
        (Get-Command makensis -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
    ) | Where-Object { $_ -and (Test-Path $_) }
    $NsisExe = $candidates | Select-Object -First 1
}

if (-not $NsisExe) {
    Write-Warning "makensis not found. Install NSIS from https://nsis.sourceforge.io"
    Write-Warning "Skipping .exe build — generating stub installer script only."
    $NsisExe = $null
}

# ── Build web assets ─────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Host "Building collab-web production bundle..." -ForegroundColor Cyan
    $bunExe = "$env:USERPROFILE\.bun\bin\bun.exe"
    if (-not (Test-Path $bunExe)) { $bunExe = "bun" }
    & $bunExe run --cwd $WEB_DIR build
    if ($LASTEXITCODE -ne 0) { throw "bun build failed" }
    Write-Host "  Build complete." -ForegroundColor Green
}

# ── Create output dir ─────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutFile = Join-Path $OutDir "oh-my-pi-desktop-$Version-setup.exe"

# ── Run makensis ──────────────────────────────────────────────────────────────
if ($NsisExe) {
    Write-Host "Running makensis..." -ForegroundColor Cyan
    & $NsisExe `
        /DAPP_NAME="$AppName" `
        /DAPP_VERSION="$Version" `
        /DPUBLISHER="$Publisher" `
        /DOUT_FILE="$OutFile" `
        /DWEB_DIR="$WEB_DIR\dist" `
        /DROOT_DIR="$ROOT" `
        $NSI_FILE

    if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }

    if (Test-Path $OutFile) {
        $sizeMB = [math]::Round((Get-Item $OutFile).Length / 1MB, 2)
        Write-Host "  Installer built: $OutFile ($sizeMB MB)" -ForegroundColor Green
    } else {
        throw "makensis succeeded but .exe not found at: $OutFile"
    }
} else {
    Write-Host "  [STUB] Would produce: $OutFile" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Output: $OutDir" -ForegroundColor Green
