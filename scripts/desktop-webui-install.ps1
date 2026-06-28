# Oh-My-Pi Desktop WebUI - Windows Installer (upstream-binary mode)
#
# Defers to the official upstream installer at https://omp.sh/install.ps1
# (canonical source: scripts/install.ps1 in this repo, published via omp.sh).
# Adds a thin wrapper that:
#   - emits "Preflight checks" / "Installing dependencies" / "Registering"
#     log lines so the bridge step advancer drives the UI progress bar,
#   - writes a desktop-config.json and a HKCU registry entry so the launcher
#     phase can find the omp.exe that was just installed.
#
# Spawned by packages/desktop-bridge `runInstall` with -Silent. Standalone:
#   powershell -ExecutionPolicy Bypass -File scripts/desktop-webui-install.ps1 -Silent

param(
    [string]$InstallDir   = "",
    [string]$Port         = "8787",
    [string]$Mode         = "binary",   # binary | source
    [string]$Ref          = "",         # forwarded as upstream -Ref when set
    [switch]$NoShortcut,
    [switch]$Silent
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

if (-not $InstallDir -and $env:OMP_DESKTOP_DIR) { $InstallDir = $env:OMP_DESKTOP_DIR }
if ($env:OMP_BRIDGE_PORT) { $Port = $env:OMP_BRIDGE_PORT }

$APP_NAME        = "Oh-My-Pi Desktop"
$DEFAULT_INSTALL = Join-Path $env:LOCALAPPDATA "omp-desktop"
$INSTALL_DIR     = if ($InstallDir) { $InstallDir } else { $DEFAULT_INSTALL }
$LOG_DIR         = Join-Path $INSTALL_DIR "logs"
$REGISTRY_ROOT   = "HKCU:\Software\OhMyPi\Desktop"

# omp upstream installer defaults the binary path here (see install.ps1):
$OMP_BIN_DIR     = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
$UPSTREAM_PS1    = "https://omp.sh/install.ps1"

function Write-Step  { param($msg) Write-Host "  -> $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "  [err] $msg" -ForegroundColor Red }

function Get-DiskFreeGB {
    param([string]$Path)
    $drive = Split-Path -Qualifier $Path
    $disk  = Get-PSDrive -Name ($drive.TrimEnd(':')) -ErrorAction SilentlyContinue
    if ($disk) { return [math]::Round($disk.Free / 1GB, 2) }
    return 99
}

function Write-Registry {
    param([hashtable]$Values)
    if (-not (Test-Path $REGISTRY_ROOT)) {
        New-Item -Path $REGISTRY_ROOT -Force | Out-Null
    }
    foreach ($kv in $Values.GetEnumerator()) {
        Set-ItemProperty -Path $REGISTRY_ROOT -Name $kv.Key -Value $kv.Value -Force
    }
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 1/3: Preflight
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-PreflightChecks {
    Write-Host ""
    Write-Host "  [1/3] Preflight checks" -ForegroundColor White

    Write-Step "Checking write permissions at $INSTALL_DIR..."
    $testFile = Join-Path $INSTALL_DIR ".__write_test"
    try {
        New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
        [IO.File]::WriteAllText($testFile, "ok")
        Remove-Item $testFile -ErrorAction SilentlyContinue
        Write-Ok "Permissions: writable"
    } catch {
        throw "Cannot write to $INSTALL_DIR -- try running as Administrator or pick a different path."
    }

    Write-Step "Checking disk space..."
    $parent = if (Test-Path $INSTALL_DIR) { $INSTALL_DIR } else { Split-Path $INSTALL_DIR }
    $freeGB = Get-DiskFreeGB $parent
    Write-Ok "Disk: ${freeGB} GB free at $parent"

    Write-Step "Checking network (github.com)..."
    try {
        $null = Invoke-WebRequest -Uri "https://github.com" -UseBasicParsing -TimeoutSec 10
        Write-Ok "Network: reachable"
    } catch {
        throw "Cannot reach github.com. Check your network or proxy."
    }
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 2/3: Install via upstream PS1
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-UpstreamInstaller {
    Write-Host ""
    Write-Host "  [2/3] Installing dependencies (bun install -g via upstream)" -ForegroundColor White

    # Download the upstream installer to a temp file so we can pass parameters
    # to it. `irm | iex` is the documented form but it does not accept params.
    $tmpPs1 = Join-Path $env:TEMP ("omp-upstream-install-" + [System.Guid]::NewGuid().ToString("N") + ".ps1")
    Write-Step "Fetching upstream installer: $UPSTREAM_PS1"
    Invoke-WebRequest -Uri $UPSTREAM_PS1 -OutFile $tmpPs1 -UseBasicParsing

    try {
        $upstreamArgs = @()
        switch ($Mode.ToLowerInvariant()) {
            "binary" { $upstreamArgs += "-Binary" }
            "source" { $upstreamArgs += "-Source" }
            default  { } # let upstream choose (bun if available else binary)
        }
        if ($Ref) {
            $upstreamArgs += "-Ref"
            $upstreamArgs += $Ref
        }

        Write-Step "Running upstream installer: $($upstreamArgs -join ' ')"
        # Stream upstream's own stdout/stderr through so log lines like
        # "Downloading omp-windows-x64.exe..." and "Installed omp to ..."
        # surface in the bridge job logs.
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmpPs1 @upstreamArgs 2>&1 |
            ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) {
            throw "Upstream installer exited with code $LASTEXITCODE"
        }
    } finally {
        Remove-Item -Force $tmpPs1 -ErrorAction SilentlyContinue
    }

    # Resolve the installed omp binary path. Upstream installs to either
    # $env:LOCALAPPDATA\omp\omp.exe (binary mode) or the bun global bin
    # ($env:USERPROFILE\.bun\bin\omp.exe).
    $candidates = @(
        (Join-Path $OMP_BIN_DIR "omp.exe"),
        (Join-Path $env:USERPROFILE ".bun\bin\omp.exe"),
        (Join-Path $env:USERPROFILE ".bun\bin\omp")
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 3/3: Register desktop wrapper
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-Register {
    param([string]$OmpPath)

    Write-Host ""
    Write-Host "  [3/3] Registering installation" -ForegroundColor White

    New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
    Write-Ok "Log directory: $LOG_DIR"

    $configPath = Join-Path $INSTALL_DIR "desktop-config.json"
    @{
        installDir  = $INSTALL_DIR
        ompBinDir   = $OMP_BIN_DIR
        ompPath     = $OmpPath
        mode        = $Mode
        ref         = $Ref
        port        = $Port
        installedAt = (Get-Date -Format "o")
        schema      = "upstream-v1"
    } | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    Write-Ok "Config written -> $configPath"

    if (-not $NoShortcut) {
        $tauriExe = Join-Path $env:LOCALAPPDATA "Programs\Oh-My-Pi Desktop\omp-desktop-shell.exe"
        if (Test-Path $tauriExe) {
            $WshShell  = New-Object -ComObject WScript.Shell
            $shortcut  = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\$APP_NAME.lnk")
            $shortcut.TargetPath       = $tauriExe
            $shortcut.WorkingDirectory = Split-Path $tauriExe
            $shortcut.Description      = $APP_NAME
            $shortcut.Save()
            Write-Ok "Desktop shortcut -> $tauriExe"
        } else {
            Write-Warn "Tauri shell not at $tauriExe; skipping shortcut (NSIS installer normally puts one there)."
        }
    }

    Write-Registry @{
        InstallDir  = $INSTALL_DIR
        OmpBinDir   = $OMP_BIN_DIR
        OmpPath     = if ($OmpPath) { $OmpPath } else { "" }
        Mode        = $Mode
        Ref         = $Ref
        Port        = $Port
        InstalledAt = (Get-Date -Format "o")
        Schema      = "upstream-v1"
    }
    Write-Ok "App registry written"
}

# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────
try {
    Write-Host ""
    Write-Host "  $APP_NAME - Installer (upstream mode: $Mode)" -ForegroundColor Blue
    Write-Host ""

    Invoke-PreflightChecks
    $ompPath = Invoke-UpstreamInstaller
    Invoke-Register -OmpPath $ompPath

    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host "  $APP_NAME installed successfully!" -ForegroundColor Green
    if ($ompPath) {
        Write-Host "    omp CLI : $ompPath" -ForegroundColor White
    } else {
        Write-Host "    omp CLI : (could not auto-detect; check $OMP_BIN_DIR or restart shell)" -ForegroundColor Yellow
    }
    Write-Host "    Config  : $INSTALL_DIR" -ForegroundColor White
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host ""
    Write-Err "Installation failed: $_"
    Write-Host "  Check the in-app log panel or look under $LOG_DIR" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
