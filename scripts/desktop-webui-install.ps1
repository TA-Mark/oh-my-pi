# Oh-My-Pi Desktop WebUI — Windows Installer (npm-package mode)
#
# Installs the official `@oh-my-pi/pi-coding-agent` npm package globally via
# Bun. No git clone, no source build — production-style install.
#
# Designed to be spawned by packages/desktop-bridge `runInstall` with -Silent.
# Can also be run standalone:
#   powershell -ExecutionPolicy Bypass -File scripts/desktop-webui-install.ps1 -Silent

param(
    [string]$InstallDir    = "",
    [string]$Package       = "@oh-my-pi/pi-coding-agent",
    [string]$Version       = "latest",
    [string]$Port          = "8787",
    [switch]$NoShortcut,
    [switch]$NoAutoLaunch,
    [switch]$Silent
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

# Bridge passes OMP_DESKTOP_DIR / OMP_BRIDGE_PORT via env; honor them when
# the matching flag was not supplied on the command line.
if (-not $InstallDir -and $env:OMP_DESKTOP_DIR) { $InstallDir = $env:OMP_DESKTOP_DIR }
if ($env:OMP_BRIDGE_PORT) { $Port = $env:OMP_BRIDGE_PORT }

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────
$APP_NAME         = "Oh-My-Pi Desktop"
$APP_ID           = "omp-desktop"
$MIN_BUN_VERSION  = "1.3.14"
$MIN_DISK_GB      = 1

$DEFAULT_INSTALL  = Join-Path $env:LOCALAPPDATA "omp-desktop"
$INSTALL_DIR      = if ($InstallDir) { $InstallDir } else { $DEFAULT_INSTALL }
$LOG_DIR          = Join-Path $INSTALL_DIR "logs"
$REGISTRY_ROOT    = "HKCU:\Software\OhMyPi\Desktop"

# ──────────────────────────────────────────────────────────────────────────────
# Helpers — log markers are matched by the bridge step advancer:
#   "Preflight checks" → preflight
#   "Installing.*dependencies" or "bun install" → install
#   "Registering" → register
# ──────────────────────────────────────────────────────────────────────────────
function Write-Step  { param($msg) Write-Host "  -> $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "  [err] $msg" -ForegroundColor Red }

function Write-Banner {
    Write-Host ""
    Write-Host "  $APP_NAME - Installer (npm-package mode)" -ForegroundColor Blue
    Write-Host ""
}

function Get-DiskFreeGB {
    param([string]$Path)
    $drive = Split-Path -Qualifier $Path
    $disk  = Get-PSDrive -Name ($drive.TrimEnd(':')) -ErrorAction SilentlyContinue
    if ($disk) { return [math]::Round($disk.Free / 1GB, 2) }
    return 99
}

function Test-CommandExists {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-BunVersion {
    try {
        $v = (bun --version 2>$null).Trim().Split("-")[0]
        return [version]$v
    } catch { return $null }
}

function Install-Bun {
    Write-Step "Installing Bun..."
    irm bun.sh/install.ps1 | iex
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","User") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","Machine")
    $v = Get-BunVersion
    if (-not $v -or $v -lt [version]$MIN_BUN_VERSION) {
        throw "Bun install completed but version is still $v (need >= $MIN_BUN_VERSION)"
    }
    Write-Ok "Bun installed: $v"
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

function Get-BunGlobalBin {
    try {
        $raw = (& bun pm bin -g 2>$null).Trim()
        if ($raw) { return $raw }
    } catch { }
    return Join-Path $env:USERPROFILE ".bun\bin"
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 1/3: Preflight checks
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-PreflightChecks {
    Write-Host ""
    Write-Host "  [1/3] Preflight checks" -ForegroundColor White

    # Disk
    Write-Step "Checking disk space (need >= ${MIN_DISK_GB} GB at $INSTALL_DIR)..."
    $parent = if (Test-Path $INSTALL_DIR) { $INSTALL_DIR } else { Split-Path $INSTALL_DIR }
    $freeGB = Get-DiskFreeGB $parent
    if ($freeGB -lt $MIN_DISK_GB) {
        throw "Insufficient disk space: ${freeGB} GB free, need ${MIN_DISK_GB} GB at $parent"
    }
    Write-Ok "Disk: ${freeGB} GB free"

    # Write permissions
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

    # Bun
    Write-Step "Checking Bun >= $MIN_BUN_VERSION..."
    if (Test-CommandExists "bun") {
        $v = Get-BunVersion
        if ($v -ge [version]$MIN_BUN_VERSION) {
            Write-Ok "Bun: $v"
        } else {
            Write-Warn "Bun $v is below minimum. Upgrading..."
            Install-Bun
        }
    } else {
        Write-Warn "Bun not found. Installing..."
        Install-Bun
    }

    Write-Ok "All preflight checks passed."
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 2/3: Install npm package globally via Bun
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-InstallPackage {
    Write-Host ""
    Write-Host "  [2/3] Installing dependencies" -ForegroundColor White

    $spec = if ($Version -eq "latest") { $Package } else { "$Package@$Version" }
    Write-Step "Installing $spec (bun install -g)..."

    # Use Start-Process so we can capture exit code reliably even when bun
    # writes spinners; redirect both streams to the parent (bridge) console.
    & bun install -g $spec 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "bun install -g $spec failed (exit $LASTEXITCODE)"
    }

    $bunBin = Get-BunGlobalBin
    $ompPath = Join-Path $bunBin "omp.exe"
    if (-not (Test-Path $ompPath)) {
        # Bun may install without .exe extension on some shells; try plain.
        $alt = Join-Path $bunBin "omp"
        if (Test-Path $alt) { $ompPath = $alt }
    }
    if (-not (Test-Path $ompPath)) {
        Write-Warn "omp launcher not found in $bunBin after install. PATH may need a session restart."
    } else {
        Write-Ok "omp launcher: $ompPath"
    }
    return $ompPath
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 3/3: Register desktop wrapper
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-Register {
    param([string]$OmpPath)

    Write-Host ""
    Write-Host "  [3/3] Registering installation" -ForegroundColor White

    # Ensure logs dir
    New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
    Write-Ok "Log directory: $LOG_DIR"

    # Write app config
    $configPath = Join-Path $INSTALL_DIR "desktop-config.json"
    @{
        installDir  = $INSTALL_DIR
        package     = $Package
        version     = $Version
        port        = $Port
        ompPath     = $OmpPath
        installedAt = (Get-Date -Format "o")
        schema      = "npm-global-v1"
    } | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    Write-Ok "Config written -> $configPath"

    # Desktop + Start Menu shortcuts pointing at the installed Tauri app, not at omp.
    # The Tauri shell is what the user double-clicks; omp runs as a child of the bridge.
    if (-not $NoShortcut) {
        $tauriExe = Join-Path $env:LOCALAPPDATA "Programs\Oh-My-Pi Desktop\omp-desktop-shell.exe"
        if (Test-Path $tauriExe) {
            Write-Step "Creating Desktop shortcut..."
            $WshShell   = New-Object -ComObject WScript.Shell
            $shortcut   = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\$APP_NAME.lnk")
            $shortcut.TargetPath       = $tauriExe
            $shortcut.WorkingDirectory = Split-Path $tauriExe
            $shortcut.Description      = "$APP_NAME"
            $shortcut.Save()
            Write-Ok "Desktop shortcut created"
        } else {
            Write-Warn "Tauri shell not found at $tauriExe -- skipping shortcut (NSIS installer normally puts one there)."
        }
    }

    # App registry
    Write-Registry @{
        InstallDir  = $INSTALL_DIR
        Package     = $Package
        Version     = $Version
        Port        = $Port
        OmpPath     = $OmpPath
        InstalledAt = (Get-Date -Format "o")
        Schema      = "npm-global-v1"
    }
    Write-Ok "App registry written"
}

# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────
try {
    Write-Banner

    Invoke-PreflightChecks
    $ompPath = Invoke-InstallPackage
    Invoke-Register -OmpPath $ompPath

    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host "  $APP_NAME installed successfully!" -ForegroundColor Green
    Write-Host "    Config   : $INSTALL_DIR" -ForegroundColor White
    Write-Host "    omp CLI  : $ompPath" -ForegroundColor White
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host ""
    Write-Err "Installation failed: $_"
    Write-Host "  Check the in-app log panel or look under $LOG_DIR" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
