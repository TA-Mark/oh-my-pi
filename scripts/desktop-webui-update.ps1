# Oh-My-Pi Desktop WebUI — Updater
# Usage: .\scripts\desktop-webui-update.ps1
#        .\scripts\desktop-webui-update.ps1 -Branch develop

param(
    [string]$Branch  = "",
    [switch]$Rebuild,    # force rebuild even if already up-to-date
    [switch]$Silent
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

# ──────────────────────────────────────────────────────────────────────────────
# Resolve install from registry
# ──────────────────────────────────────────────────────────────────────────────
function Get-Reg { param($k)
    try { return (Get-ItemProperty "HKCU:\Software\OhMyPi\Desktop" -Name $k -ErrorAction Stop).$k }
    catch { return $null }
}
function Set-Reg { param($k, $v)
    Set-ItemProperty "HKCU:\Software\OhMyPi\Desktop" -Name $k -Value $v -Force
}

$INSTALL_DIR = Get-Reg "InstallDir"
if (-not $INSTALL_DIR -or -not (Test-Path $INSTALL_DIR)) {
    Write-Host "✗ Oh-My-Pi Desktop not installed. Run desktop-webui-install.ps1 first." -ForegroundColor Red
    exit 1
}

$CURRENT_BRANCH = if ($Branch) { $Branch } else { (Get-Reg "Branch") ?? "main" }
$WEB_DIR        = Join-Path $INSTALL_DIR "packages\collab-web"
$LOG_DIR        = Join-Path $INSTALL_DIR "logs"
$UPDATE_LOG     = Join-Path $LOG_DIR "update-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

function Write-Info { param($m) Write-Host "  → $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  ⚠ $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "  ✗ $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  Oh-My-Pi Desktop — Updater" -ForegroundColor Blue
Write-Host "  Install: $INSTALL_DIR" -ForegroundColor Gray
Write-Host "  Branch : $CURRENT_BRANCH" -ForegroundColor Gray
Write-Host ""

# ──────────────────────────────────────────────────────────────────────────────
# 1. Git pull
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Fetching latest from origin/$CURRENT_BRANCH..."
Push-Location $INSTALL_DIR
try {
    $before = git rev-parse HEAD 2>&1
    git fetch origin 2>&1 | Out-Null
    git checkout $CURRENT_BRANCH 2>&1 | Out-Null
    git pull origin $CURRENT_BRANCH 2>&1 | Out-Null
    $after = git rev-parse HEAD 2>&1

    if ($before -eq $after -and -not $Rebuild) {
        Write-Ok "Already up-to-date ($($before.Substring(0,8))). Nothing to do."
        Write-Host ""
        exit 0
    }

    if ($before -ne $after) {
        Write-Ok "Updated $($before.Substring(0,8)) → $($after.Substring(0,8))"
    } else {
        Write-Warn "No git changes but -Rebuild forced."
    }
} finally { Pop-Location }

# ──────────────────────────────────────────────────────────────────────────────
# 2. bun install
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Installing dependencies..."
Push-Location $INSTALL_DIR
try {
    bun install 2>&1
    if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
    Write-Ok "Dependencies updated"
} finally { Pop-Location }

# ──────────────────────────────────────────────────────────────────────────────
# 3. Rebuild WebUI
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Rebuilding WebUI..."
Push-Location $WEB_DIR
try {
    if (Test-Path "dist") { Remove-Item "dist" -Recurse -Force }
    bun build ./index.html --outdir=dist --minify `
        --entry-naming=[hash].[ext] `
        --chunk-naming=[hash].[ext] `
        --asset-naming=[hash].[ext] 2>&1
    if ($LASTEXITCODE -ne 0) { throw "bun build failed" }

    $htmlFile = Get-ChildItem "dist" -Filter "*.html" | Select-Object -First 1
    if ($htmlFile -and $htmlFile.Name -ne "index.html") {
        Rename-Item $htmlFile.FullName "index.html"
    }
    if (Test-Path "public") { Copy-Item "public\*" "dist\" -Recurse -Force }
    Write-Ok "WebUI rebuilt successfully"
} finally { Pop-Location }

# ──────────────────────────────────────────────────────────────────────────────
# 4. Update registry version/timestamp
# ──────────────────────────────────────────────────────────────────────────────
$newCommit = (git -C $INSTALL_DIR rev-parse --short HEAD 2>&1)
Set-Reg "Branch"     $CURRENT_BRANCH
Set-Reg "LastUpdate" (Get-Date -Format "o")
Set-Reg "Commit"     $newCommit

# Update Add/Remove Programs version
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\omp-desktop"
if (Test-Path $uninstallKey) {
    Set-ItemProperty $uninstallKey "DisplayVersion" $newCommit -Force
}

Write-Ok "Registry updated (commit: $newCommit)"

Write-Host ""
Write-Host "  ✓ Update complete! Restart the app to apply." -ForegroundColor Green
Write-Host ""
