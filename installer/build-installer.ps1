# Oh-My-Pi Desktop WebUI — Build Windows Installer
# Builds the React/Bun dist and then runs NSIS to produce the .exe
#
# Usage:
#   .\installer\build-installer.ps1
#   .\installer\build-installer.ps1 -Version "1.2.0"
#   .\installer\build-installer.ps1 -SkipBuild   (use existing dist/)
#   .\installer\build-installer.ps1 -Sign        (requires signtool + cert)

param(
    [string]$Version   = "1.0.0",
    [string]$OutDir    = ".\release",
    [switch]$SkipBuild,
    [switch]$Sign,
    [string]$CertThumb = "",       # code-signing cert thumbprint
    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$ROOT     = Split-Path -Parent $PSScriptRoot
$WEB_DIR  = Join-Path $ROOT "packages\collab-web"
$NSI_FILE = Join-Path $PSScriptRoot "desktop-webui.nsi"
$EXE_NAME = "oh-my-pi-desktop-setup-$Version.exe"

function Write-Step { param($m) Write-Host "  → $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Err  { param($m) Write-Host "  ✗ $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  Oh-My-Pi Desktop — Installer Builder" -ForegroundColor Blue
Write-Host "  Version : $Version" -ForegroundColor Gray
Write-Host "  OutDir  : $OutDir" -ForegroundColor Gray
Write-Host ""

# ──────────────────────────────────────────────────────────────────────────────
# 1. Check tools
# ──────────────────────────────────────────────────────────────────────────────
Write-Step "Checking required tools..."

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Err "bun not found. Install at https://bun.sh"
}

$nsisPath = @(
    "C:\Program Files (x86)\NSIS\makensis.exe",
    "C:\Program Files\NSIS\makensis.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $nsisPath) {
    Write-Err "NSIS not found. Install from https://nsis.sourceforge.io — then retry."
}
Write-Ok "Tools: bun=$(bun --version), NSIS=$nsisPath"

# ──────────────────────────────────────────────────────────────────────────────
# 2. Build WebUI
# ──────────────────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Step "Installing dependencies (bun install)..."
    Push-Location $ROOT
    try {
        bun install --frozen-lockfile 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Err "bun install failed" }
    } finally { Pop-Location }

    Write-Step "Building React/Bun production bundle..."
    Push-Location $WEB_DIR
    try {
        if (Test-Path "dist") { Remove-Item "dist" -Recurse -Force }
        bun build ./index.html --outdir=dist --minify `
            --entry-naming=[hash].[ext] `
            --chunk-naming=[hash].[ext] `
            --asset-naming=[hash].[ext] 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Err "bun build failed" }

        $htmlFile = Get-ChildItem "dist" -Filter "*.html" | Select-Object -First 1
        if ($htmlFile -and $htmlFile.Name -ne "index.html") {
            Rename-Item $htmlFile.FullName "index.html"
        }
        if (Test-Path "public") { Copy-Item "public\*" "dist\" -Recurse -Force }
        Write-Ok "WebUI built → $WEB_DIR\dist"
    } finally { Pop-Location }
} else {
    Write-Step "Skipping build (using existing dist/)..."
    if (-not (Test-Path "$WEB_DIR\dist\index.html")) {
        Write-Err "dist\index.html not found. Remove -SkipBuild to build first."
    }
    Write-Ok "Existing dist found"
}

# ──────────────────────────────────────────────────────────────────────────────
# 3. Patch version in NSI (replace APP_VERSION)
# ──────────────────────────────────────────────────────────────────────────────
Write-Step "Patching version $Version into $NSI_FILE..."
$nsiContent = Get-Content $NSI_FILE -Raw
$nsiPatched = $nsiContent -replace '(!define APP_VERSION\s+")[^"]*(")', "`$1$Version`$2"
$patchedNsi = Join-Path $env:TEMP "desktop-webui-$Version.nsi"
$nsiPatched | Set-Content $patchedNsi -Encoding UTF8
Write-Ok "Patched NSI → $patchedNsi"

# ──────────────────────────────────────────────────────────────────────────────
# 4. Run NSIS
# ──────────────────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Step "Running makensis..."
$nsisArgs = @(
    "/DAPP_VERSION=$Version",
    "/DOUT_DIR=$OutDir",
    "/V3",
    $patchedNsi
)
& $nsisPath @nsisArgs
if ($LASTEXITCODE -ne 0) { Write-Err "NSIS build failed (exit $LASTEXITCODE)" }

# Move output to OutDir
$generatedExe = Join-Path $PSScriptRoot $EXE_NAME
$targetExe    = Join-Path $OutDir $EXE_NAME
if (Test-Path $generatedExe) {
    Move-Item $generatedExe $targetExe -Force
}

Write-Ok "Installer built → $targetExe"

# ──────────────────────────────────────────────────────────────────────────────
# 5. Code signing (optional)
# ──────────────────────────────────────────────────────────────────────────────
if ($Sign) {
    Write-Step "Signing installer with cert thumbprint $CertThumb..."

    $signtool = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin\x64\signtool.exe",
        "${env:ProgramFiles}\Windows Kits\10\bin\x64\signtool.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $signtool) {
        Write-Host "  ⚠ signtool not found — skipping signing." -ForegroundColor Yellow
    } else {
        & $signtool sign `
            /sha1 $CertThumb `
            /tr   $TimestampUrl `
            /td   sha256 `
            /fd   sha256 `
            /v    $targetExe

        if ($LASTEXITCODE -ne 0) { Write-Err "Signing failed" }
        Write-Ok "Signed: $targetExe"

        # Verify
        & $signtool verify /pa $targetExe
        Write-Ok "Signature verified"
    }
}

# ──────────────────────────────────────────────────────────────────────────────
# 6. Generate checksums
# ──────────────────────────────────────────────────────────────────────────────
Write-Step "Generating SHA-256 checksum..."
$hash = (Get-FileHash $targetExe -Algorithm SHA256).Hash
$checksumFile = Join-Path $OutDir "$EXE_NAME.sha256"
"$hash  $EXE_NAME" | Set-Content $checksumFile -Encoding UTF8
Write-Ok "Checksum → $checksumFile"
Write-Host "  SHA256: $hash" -ForegroundColor Gray

Write-Host ""
Write-Host "  ══════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✓ Build complete!" -ForegroundColor Green
Write-Host "    Installer : $targetExe" -ForegroundColor White
Write-Host "    Checksum  : $checksumFile" -ForegroundColor White
Write-Host "  ══════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
