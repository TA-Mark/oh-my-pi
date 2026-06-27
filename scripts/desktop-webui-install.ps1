# Oh-My-Pi Desktop WebUI — Windows Installer
# Usage: irm https://raw.githubusercontent.com/myorg/oh-my-pi-desktop/main/scripts/desktop-webui-install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm .../desktop-webui-install.ps1))) -InstallDir "C:\MyApps\omp-desktop"
#   & ([scriptblock]::Create((irm .../desktop-webui-install.ps1))) -Branch "develop"
#   & ([scriptblock]::Create((irm .../desktop-webui-install.ps1))) -NoShortcut
#   & ([scriptblock]::Create((irm .../desktop-webui-install.ps1))) -NoAutoLaunch

param(
    [string]$InstallDir    = "",
    [string]$Repo          = "myorg/oh-my-pi-desktop",
    [string]$Branch        = "main",
    [string]$Port          = "8765",
    [switch]$NoShortcut,
    [switch]$NoAutoLaunch,
    [switch]$Silent
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────
$APP_NAME         = "Oh-My-Pi Desktop"
$APP_ID           = "omp-desktop"
$MIN_BUN_VERSION  = "1.3.14"
$MIN_DISK_GB      = 2

$DEFAULT_INSTALL  = Join-Path $env:LOCALAPPDATA "omp-desktop"
$INSTALL_DIR      = if ($InstallDir) { $InstallDir } else { $DEFAULT_INSTALL }
$WEB_DIR          = Join-Path $INSTALL_DIR "packages\collab-web"
$DIST_DIR         = Join-Path $WEB_DIR "dist"
$LOG_DIR          = Join-Path $INSTALL_DIR "logs"
$REGISTRY_ROOT    = "HKCU:\Software\OhMyPi\Desktop"

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────
function Write-Step  { param($msg) Write-Host "  → $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "  ✗ $msg" -ForegroundColor Red }

function Write-Banner {
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Blue
    Write-Host "  ║   $APP_NAME — Installer v1.0       ║" -ForegroundColor Blue
    Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Blue
    Write-Host ""
}

function Get-DiskFreeGB {
    param([string]$Path)
    $drive = Split-Path -Qualifier $Path
    $disk  = Get-PSDrive -Name ($drive.TrimEnd(':')) -ErrorAction SilentlyContinue
    if ($disk) { return [math]::Round($disk.Free / 1GB, 2) }
    return 99  # assume ok if we can't detect
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

function Assert-BunMinVersion {
    $v = Get-BunVersion
    if (-not $v -or $v -lt [version]$MIN_BUN_VERSION) {
        $current = if ($v) { $v } else { "not found" }
        throw "Bun >= $MIN_BUN_VERSION required. Current: $current. Install at https://bun.sh"
    }
}

function Install-Bun {
    Write-Step "Installing Bun..."
    irm bun.sh/install.ps1 | iex
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","User") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","Machine")
    Assert-BunMinVersion
    Write-Ok "Bun installed: $(Get-BunVersion)"
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

function Read-Registry {
    param([string]$Key)
    try { return (Get-ItemProperty -Path $REGISTRY_ROOT -Name $Key -ErrorAction Stop).$Key }
    catch { return $null }
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: Preflight checks
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-PreflightChecks {
    Write-Host ""
    Write-Host "  [1/5] Preflight checks" -ForegroundColor White

    # Git
    Write-Step "Checking git..."
    if (-not (Test-CommandExists "git")) {
        throw "git is required. Install Git for Windows: https://git-scm.com/download/win"
    }
    $gitVer = git --version 2>&1
    Write-Ok "git: $gitVer"

    # Network — try GitHub
    Write-Step "Checking network (github.com)..."
    try {
        $null = Invoke-WebRequest -Uri "https://github.com" -TimeoutSec 10 -UseBasicParsing
        Write-Ok "Network: reachable"
    } catch {
        throw "Cannot reach github.com. Check your network or proxy settings."
    }

    # Disk space
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
        throw "Cannot write to $INSTALL_DIR — try running as Administrator or pick a different path."
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
# Step 2: Clone / update repo
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-CloneOrUpdate {
    Write-Host ""
    Write-Host "  [2/5] Fetching source (branch: $Branch)" -ForegroundColor White

    $repoUrl = "https://github.com/$Repo.git"

    if (Test-Path (Join-Path $INSTALL_DIR ".git")) {
        Write-Step "Existing install detected — updating..."
        Push-Location $INSTALL_DIR
        try {
            git fetch origin 2>&1 | Out-Null
            git checkout $Branch 2>&1 | Out-Null
            git pull origin $Branch 2>&1 | Out-Null
            Write-Ok "Updated to latest $Branch"
        } finally { Pop-Location }
    } else {
        Write-Step "Cloning $repoUrl..."
        if (Test-Path $INSTALL_DIR) {
            $items = Get-ChildItem $INSTALL_DIR -ErrorAction SilentlyContinue
            if ($items) {
                throw "$INSTALL_DIR is not empty and not a git repo. Choose a different -InstallDir or clear it first."
            }
        }
        git clone --branch $Branch --depth 1 $repoUrl $INSTALL_DIR 2>&1
        if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit $LASTEXITCODE)" }
        Write-Ok "Cloned to $INSTALL_DIR"
    }
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: Install dependencies & build WebUI
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-BuildWebUI {
    Write-Host ""
    Write-Host "  [3/5] Building WebUI (React + Bun)" -ForegroundColor White

    Write-Step "Installing monorepo dependencies..."
    Push-Location $INSTALL_DIR
    try {
        bun install --frozen-lockfile 2>&1
        if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
        Write-Ok "Dependencies installed"

        Write-Step "Building collab-web production bundle..."
        Push-Location $WEB_DIR
        try {
            # Windows-compatible build (avoid rm -rf, use PowerShell)
            if (Test-Path "dist") { Remove-Item "dist" -Recurse -Force }
            bun build ./index.html --outdir=dist --minify `
                --entry-naming=[hash].[ext] `
                --chunk-naming=[hash].[ext] `
                --asset-naming=[hash].[ext] 2>&1
            if ($LASTEXITCODE -ne 0) { throw "bun build failed" }

            # Rename entry point
            $htmlFile = Get-ChildItem "dist" -Filter "*.html" | Select-Object -First 1
            if ($htmlFile -and $htmlFile.Name -ne "index.html") {
                Rename-Item $htmlFile.FullName "index.html"
            }

            # Copy public assets
            if (Test-Path "public") {
                Copy-Item "public\*" "dist\" -Recurse -Force
            }

            Write-Ok "WebUI built → $DIST_DIR"
        } finally { Pop-Location }
    } finally { Pop-Location }
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 4: Create launcher scripts & shortcuts
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-CreateLauncherScripts {
    Write-Host ""
    Write-Host "  [4/5] Creating launchers & shortcuts" -ForegroundColor White

    # Copy launcher scripts from repo to install dir
    $launchSrc = Join-Path $INSTALL_DIR "scripts\desktop-webui-launch.ps1"
    $launchDst = Join-Path $INSTALL_DIR "launch.ps1"
    if (Test-Path $launchSrc) {
        Copy-Item $launchSrc $launchDst -Force
    }

    $batSrc = Join-Path $INSTALL_DIR "scripts\desktop-webui-launch.bat"
    $batDst = Join-Path $INSTALL_DIR "launch.bat"
    if (Test-Path $batSrc) {
        Copy-Item $batSrc $batDst -Force
    }

    # Write config file
    $configPath = Join-Path $INSTALL_DIR "desktop-config.json"
    @{
        installDir  = $INSTALL_DIR
        branch      = $Branch
        port        = $Port
        repo        = $Repo
        installedAt = (Get-Date -Format "o")
        version     = "1.0.0"
    } | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    Write-Ok "Config written → $configPath"

    # Desktop shortcut
    if (-not $NoShortcut) {
        Write-Step "Creating Desktop shortcut..."
        $WshShell   = New-Object -ComObject WScript.Shell
        $shortcut   = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\$APP_NAME.lnk")
        $shortcut.TargetPath       = "powershell.exe"
        $shortcut.Arguments        = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launchDst`""
        $shortcut.WorkingDirectory = $INSTALL_DIR
        $shortcut.Description      = "$APP_NAME — Click to start"
        $shortcut.IconLocation     = "$env:SystemRoot\System32\shell32.dll,14"
        $shortcut.Save()
        Write-Ok "Desktop shortcut created"

        # Start Menu shortcut
        $startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Oh-My-Pi"
        New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
        $smShortcut = $WshShell.CreateShortcut("$startMenuDir\$APP_NAME.lnk")
        $smShortcut.TargetPath       = "powershell.exe"
        $smShortcut.Arguments        = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launchDst`""
        $smShortcut.WorkingDirectory = $INSTALL_DIR
        $smShortcut.Description      = "$APP_NAME"
        $smShortcut.IconLocation     = "$env:SystemRoot\System32\shell32.dll,14"
        $smShortcut.Save()
        Write-Ok "Start Menu shortcut created"
    }

    # Add to User PATH
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$INSTALL_DIR*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$INSTALL_DIR", "User")
        Write-Ok "Added $INSTALL_DIR to User PATH"
    }
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 5: Register in Windows & finalise
# ──────────────────────────────────────────────────────────────────────────────
function Invoke-Register {
    Write-Host ""
    Write-Host "  [5/5] Registering installation" -ForegroundColor White

    # Registry: Add/Remove Programs entry
    $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$APP_ID"
    if (-not (Test-Path $uninstallKey)) { New-Item -Path $uninstallKey -Force | Out-Null }

    $uninstallScript = Join-Path $INSTALL_DIR "scripts\desktop-webui-uninstall.ps1"
    $uninstallCmd    = "powershell.exe -ExecutionPolicy Bypass -File `"$uninstallScript`""

    Set-ItemProperty -Path $uninstallKey -Name "DisplayName"       -Value $APP_NAME
    Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion"    -Value "1.0.0"
    Set-ItemProperty -Path $uninstallKey -Name "Publisher"         -Value "Oh-My-Pi"
    Set-ItemProperty -Path $uninstallKey -Name "InstallLocation"   -Value $INSTALL_DIR
    Set-ItemProperty -Path $uninstallKey -Name "UninstallString"   -Value $uninstallCmd
    Set-ItemProperty -Path $uninstallKey -Name "URLInfoAbout"      -Value "https://omp.sh"
    Set-ItemProperty -Path $uninstallKey -Name "NoModify"         -Value 1 -Type DWord
    Set-ItemProperty -Path $uninstallKey -Name "EstimatedSize"    -Value 150000 -Type DWord
    Write-Ok "Registered in Add/Remove Programs"

    # App registry
    Write-Registry @{
        InstallDir  = $INSTALL_DIR
        Branch      = $Branch
        Port        = $Port
        InstalledAt = (Get-Date -Format "o")
        Version     = "1.0.0"
    }
    Write-Ok "App registry written"

    # Ensure logs dir
    New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
    Write-Ok "Log directory: $LOG_DIR"
}

# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────
try {
    Write-Banner

    # Check if already installed
    $existingInstall = Read-Registry "InstallDir"
    if ($existingInstall -and (Test-Path $existingInstall) -and -not $Silent) {
        Write-Warn "Existing install detected at $existingInstall"
        $choice = Read-Host "  Reinstall / update? [Y/n]"
        if ($choice -eq "n" -or $choice -eq "N") {
            Write-Host "  Aborted." -ForegroundColor Yellow
            exit 0
        }
    }

    Invoke-PreflightChecks
    Invoke-CloneOrUpdate
    Invoke-BuildWebUI
    Invoke-CreateLauncherScripts
    Invoke-Register

    Write-Host ""
    Write-Host "  ══════════════════════════════════════════" -ForegroundColor Green
    Write-Host "  ✓ $APP_NAME installed successfully!" -ForegroundColor Green
    Write-Host "    Location : $INSTALL_DIR" -ForegroundColor White
    Write-Host "    Launch   : Double-click Desktop shortcut" -ForegroundColor White
    Write-Host "               OR run: .\launch.bat" -ForegroundColor White
    Write-Host "    Uninstall: Settings → Apps → $APP_NAME" -ForegroundColor White
    Write-Host "  ══════════════════════════════════════════" -ForegroundColor Green
    Write-Host ""

    if (-not $NoAutoLaunch -and -not $Silent) {
        $launch = Read-Host "  Launch now? [Y/n]"
        if ($launch -ne "n" -and $launch -ne "N") {
            $launchScript = Join-Path $INSTALL_DIR "launch.ps1"
            if (Test-Path $launchScript) {
                Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launchScript`""
            }
        }
    }
} catch {
    Write-Host ""
    Write-Err "Installation failed: $_"
    Write-Host "  Check logs at $LOG_DIR or open an issue at https://github.com/$Repo/issues" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
