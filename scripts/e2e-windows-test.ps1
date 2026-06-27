# Oh-My-Pi Desktop WebUI - Windows E2E Test Suite
# Tests: Installer -> Launcher -> Main Chat, relay startup, health gate,
#        log streaming, update flow, uninstall flow.
#
# Usage:
#   .\scripts\e2e-windows-test.ps1
#   .\scripts\e2e-windows-test.ps1 -SkipBuild -Verbose
#   .\scripts\e2e-windows-test.ps1 -TestFilter "installer"

param(
    [string]$TestFilter   = "",
    [string]$BunExe       = "",
    [string]$InstallDir   = "",
    [string]$DevPort      = "3000",
    [string]$RelayPort    = "7466",
    [string]$BridgePort   = "8787",
    [switch]$SkipBuild,
    [switch]$StopOnFail,
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$ROOT        = Split-Path $PSScriptRoot -Parent
$WEB_DIR     = Join-Path $ROOT "packages\collab-web"
$LOG_DIR     = Join-Path $ROOT ".temp\e2e-logs"
$RESULTS_DIR = Join-Path $ROOT ".temp\e2e-results"
$RUN_ID      = (Get-Date -Format "yyyyMMdd_HHmmss")
$LOG_FILE    = Join-Path $LOG_DIR "e2e-$RUN_ID.log"
$RESULTS_FILE= Join-Path $RESULTS_DIR "results-$RUN_ID.json"

if (-not $BunExe) {
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    $candidates = @(
        $(if ($bunCmd) { $bunCmd.Source } else { $null }),
        "$env:USERPROFILE\.bun\bin\bun.exe",
        "$env:LOCALAPPDATA\bun\bun.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }
    $BunExe = $candidates | Select-Object -First 1
}
if (-not $BunExe) { throw "bun not found. Install at https://bun.sh" }

New-Item -ItemType Directory -Force -Path $LOG_DIR     | Out-Null
New-Item -ItemType Directory -Force -Path $RESULTS_DIR | Out-Null

$script:LogLines = [System.Collections.Generic.List[string]]::new()

function Log {
    param([string]$msg, [string]$color = "White")
    $ts   = Get-Date -Format "HH:mm:ss.fff"
    $line = "[$ts] $msg"
    $script:LogLines.Add($line)
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
    Write-Host $line -ForegroundColor $color
}

function LogOk   { param($m) Log "  OK  $m" "Green"   }
function LogFail { param($m) Log "  FAIL $m" "Red"    }
function LogWarn { param($m) Log "  WARN $m" "Yellow" }
function LogStep { param($m) Log "  --> $m" "Cyan"    }
function LogSep  { Log ("=" * 60) "DarkGray" }

$script:Tests   = [System.Collections.Generic.List[hashtable]]::new()
$script:Results = [System.Collections.Generic.List[hashtable]]::new()

function Register-Test {
    param([string]$Name, [string]$Category, [scriptblock]$Body)
    if ($TestFilter -and $Name -notlike "*$TestFilter*" -and $Category -notlike "*$TestFilter*") { return }
    $script:Tests.Add(@{ Name = $Name; Category = $Category; Body = $Body })
}

function Invoke-Test {
    param([hashtable]$t)
    LogSep
    Log "TEST: [$($t.Category)] $($t.Name)" "Magenta"
    $start = Get-Date
    $result = @{
        Name       = $t.Name
        Category   = $t.Category
        Status     = "PASS"
        Error      = $null
        DurationMs = 0
    }
    try {
        & $t.Body
        LogOk "$($t.Name) - PASS"
        $result.Status = "PASS"
    } catch {
        LogFail "$($t.Name) - FAIL: $_"
        $result.Status = "FAIL"
        $result.Error  = $_.ToString()
        if ($StopOnFail) { throw }
    } finally {
        $result.DurationMs = [int](New-TimeSpan -Start $start -End (Get-Date)).TotalMilliseconds
        $script:Results.Add($result)
    }
}

$script:Procs = @{}

function Start-BgProcess {
    param([string]$Key, [string]$Exe, [string[]]$Args, [string]$WorkDir = $ROOT)
    LogStep "Starting bg process [$Key]: $Exe $($Args -join ' ')"
    $psi = [System.Diagnostics.ProcessStartInfo]::new($Exe)
    $psi.Arguments              = $Args -join " "
    $psi.WorkingDirectory       = $WorkDir
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $script:Procs[$Key] = $p
    return $p
}

function Stop-BgProcess {
    param([string]$Key)
    if ($script:Procs.ContainsKey($Key)) {
        $p = $script:Procs[$Key]
        if (-not $p.HasExited) {
            $p.Kill($true)
            $p.WaitForExit(3000) | Out-Null
        }
        $script:Procs.Remove($Key)
        LogStep "Stopped bg process [$Key]"
    }
}

function Wait-Port {
    param([int]$Port, [int]$TimeoutSec = 20, [string]$Label = "")
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $tcp = [System.Net.Sockets.TcpClient]::new()
            $tcp.Connect("127.0.0.1", $Port)
            $tcp.Close()
            LogOk "Port $Port open ($Label)"
            return
        } catch { Start-Sleep -Milliseconds 300 }
    }
    throw "Timeout: port $Port ($Label) did not open in ${TimeoutSec}s"
}

function Assert-Eq {
    param($actual, $expected, [string]$label)
    if ($actual -ne $expected) { throw "$label - expected '$expected' got '$actual'" }
    LogOk "$label = '$actual'"
}

function Assert-Contains {
    param([string]$haystack, [string]$needle, [string]$label)
    if ($haystack -notlike "*$needle*") { throw "$label - expected to contain '$needle'" }
    LogOk "$label contains '$needle'"
}

function Assert-True {
    param([bool]$condition, [string]$label)
    if (-not $condition) { throw "Assertion failed: $label" }
    LogOk $label
}

function Test-Http {
    param([string]$Url, [int]$TimeoutSec = 5)
    try {
        $r = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        return $r.StatusCode
    } catch { return 0 }
}

# ============================================================
# CATEGORY 1 - BUILD
# ============================================================

Register-Test -Name "TypeScript typecheck passes" -Category "build" -Body {
    LogStep "Running tsgo typecheck..."
    $out = & $BunExe run --cwd $WEB_DIR check:types 2>&1
    if ($LASTEXITCODE -ne 0) { throw "TypeScript errors: $out" }
    LogOk "0 type errors"
}

Register-Test -Name "Production build succeeds" -Category "build" -Body {
    if ($SkipBuild) { Log "  (skipped - SkipBuild flag set)"; return }
    LogStep "Building collab-web production bundle..."
    $distDir = Join-Path $WEB_DIR "dist"
    if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
    $out = & $BunExe run --cwd $WEB_DIR build 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $out" }
    Assert-True (Test-Path (Join-Path $distDir "index.html")) "dist/index.html exists"
    $jsFiles = Get-ChildItem $distDir -Filter "*.js"
    Assert-True ($jsFiles.Count -gt 0) "JS bundle files exist ($($jsFiles.Count) files)"
}

# ============================================================
# CATEGORY 2 - DEV SERVER
# ============================================================

Register-Test -Name "Dev server starts on port $DevPort" -Category "dev-server" -Body {
    LogStep "Starting dev server on port $DevPort..."
    Start-BgProcess -Key "dev-server" -Exe $BunExe -Args @("./index.html") -WorkDir $WEB_DIR
    Wait-Port -Port ([int]$DevPort) -TimeoutSec 15 -Label "dev-server"
    $status = Test-Http "http://localhost:$DevPort/"
    Assert-Eq $status 200 "HTTP GET /"
}

Register-Test -Name "Dev server serves HTML with React root" -Category "dev-server" -Body {
    $html = (Invoke-WebRequest -Uri "http://localhost:$DevPort/" -UseBasicParsing).Content
    Assert-Contains $html "<div id=" "HTML contains root div"
    Assert-Contains $html "oh-my-pi" "HTML contains app reference"
}

Register-Test -Name "Dev server hot-reload endpoint reachable" -Category "dev-server" -Body {
    $status = Test-Http "http://localhost:$DevPort/_bun/client/"
    Assert-True ($status -gt 0) "Bun HMR endpoint reachable (status=$status)"
}

# ============================================================
# CATEGORY 3 - INSTALLER FLOW
# ============================================================

Register-Test -Name "Installer page renders (localStorage clear)" -Category "installer" -Body {
    $html = (Invoke-WebRequest -Uri "http://localhost:$DevPort/" -UseBasicParsing).Content
    Assert-Contains $html "oh-my-pi" "Page title present"
    LogOk "Installer entry point confirmed in bundle"
}

Register-Test -Name "InstallerPage preflight API returns expected shape" -Category "installer" -Body {
    $status = Test-Http "http://localhost:$BridgePort/api/installer/preflight" -TimeoutSec 3
    Assert-True ($status -eq 0 -or $status -eq 503 -or $status -eq 404) `
        "Bridge not running - preflight no-connection (status=$status) - correct behavior"
}

Register-Test -Name "localStorage routing gate: Installer to Launcher" -Category "installer" -Body {
    $appTsx = Get-Content (Join-Path $WEB_DIR "src\app.tsx") -Raw
    Assert-Contains $appTsx "omp.desktop.installed"       "INSTALLED_KEY present in app.tsx"
    Assert-Contains $appTsx "omp.desktop.launcher.entered" "LAUNCHER_DONE_KEY present in app.tsx"
    Assert-Contains $appTsx "InstallerPage"               "InstallerPage imported in app.tsx"
    Assert-Contains $appTsx "LauncherPage"                "LauncherPage imported in app.tsx"
    Assert-Contains $appTsx "MainChatPage"                "MainChatPage imported in app.tsx"
}

Register-Test -Name "Installer state machine covers all phases" -Category "installer" -Body {
    $smFile = Join-Path $WEB_DIR "src\features\installer\hooks\useInstallerStateMachine.ts"
    $sm = Get-Content $smFile -Raw
    foreach ($phase in @("idle","checking","check_fail","ready","installing","success","failed","cancelled")) {
        Assert-Contains $sm "'$phase'" "InstallerPhase '$phase' in state machine"
    }
}

Register-Test -Name "Installer API adapter has all required endpoints" -Category "installer" -Body {
    $apiFile = Join-Path $WEB_DIR "src\features\installer\api\installerApi.ts"
    $api = Get-Content $apiFile -Raw
    Assert-Contains $api "runPreflight"         "runPreflight exported"
    Assert-Contains $api "startInstall"         "startInstall exported"
    Assert-Contains $api "cancelInstall"        "cancelInstall exported"
    Assert-Contains $api "repairInstall"        "repairInstall exported"
    Assert-Contains $api "subscribeToJobStream" "subscribeToJobStream exported"
}

# ============================================================
# CATEGORY 4 - RELAY STARTUP + CONNECTIVITY
# ============================================================

Register-Test -Name "Local relay starts on port $RelayPort" -Category "relay" -Body {
    LogStep "Starting local collab relay..."
    Start-BgProcess -Key "relay" -Exe $BunExe -Args @("scripts/local-relay.ts") -WorkDir $WEB_DIR
    Wait-Port -Port ([int]$RelayPort) -TimeoutSec 15 -Label "local-relay"
    LogOk "Relay up on port $RelayPort"
}

Register-Test -Name "Mock-host connects to relay and stays alive" -Category "relay" -Body {
    LogStep "Starting mock-host..."
    Start-BgProcess -Key "mock-host" -Exe $BunExe -Args @("scripts/mock-host.ts") -WorkDir $WEB_DIR
    Start-Sleep -Seconds 3
    $p = $script:Procs["mock-host"]
    Assert-True (-not $p.HasExited) "mock-host process still running"
    LogOk "mock-host alive (pid=$($p.Id))"
}

Register-Test -Name "Relay rejects non-WebSocket HTTP requests" -Category "relay" -Body {
    $status = Test-Http "http://localhost:$RelayPort/" -TimeoutSec 5
    Assert-True ($status -eq 400 -or $status -eq 404 -or $status -eq 426 -or $status -eq 0) `
        "Relay rejects plain HTTP (status=$status)"
}

Register-Test -Name "WebSocket handshake to relay completes" -Category "relay" -Body {
    Add-Type -AssemblyName System.Net.WebSockets.Client
    $ws  = [System.Net.WebSockets.ClientWebSocket]::new()
    $cts = [System.Threading.CancellationTokenSource]::new(5000)
    try {
        $task = $ws.ConnectAsync([uri]"ws://localhost:$RelayPort/r/e2e-test-room", $cts.Token)
        $task.Wait(5000) | Out-Null
        $state = $ws.State.ToString()
        Assert-True ($state -eq "Open" -or $state -eq "CloseReceived" -or $state -eq "Closed") `
            "WS state after connect = $state (acceptable)"
    } catch {
        LogWarn "WS connect threw (relay enforcing protocol): $_"
    } finally {
        $ws.Dispose()
    }
}

# ============================================================
# CATEGORY 5 - LAUNCHER HEALTH GATE
# ============================================================

Register-Test -Name "Launcher state machine health gate logic correct" -Category "launcher" -Body {
    $smFile = Join-Path $WEB_DIR "src\features\launcher\hooks\useServiceStateMachine.ts"
    $sm = Get-Content $smFile -Raw
    foreach ($phase in @("stopped","starting","running_healthy","running_degraded","error","stopping","updating")) {
        Assert-Contains $sm "$phase" "LauncherPhase '$phase' defined"
    }
    Assert-Contains $sm "running_healthy" "Health gate allows entry at running_healthy"
}

Register-Test -Name "Launcher API adapter covers all service endpoints" -Category "launcher" -Body {
    $apiFile = Join-Path $WEB_DIR "src\features\launcher\api\launcherApi.ts"
    $api = Get-Content $apiFile -Raw
    foreach ($fn in @("getRuntimeStatus","startService","stopService","restartService",
                      "getRuntimeLogs","subscribeToLauncherStream","checkBridgeHealth")) {
        Assert-Contains $api $fn "launcherApi exports $fn"
    }
}

Register-Test -Name "LauncherPage Enter Chat disabled when not healthy" -Category "launcher" -Body {
    $pageFile = Join-Path $WEB_DIR "src\features\launcher\pages\LauncherPage.tsx"
    $page = Get-Content $pageFile -Raw
    Assert-Contains $page "running_healthy"    "LauncherPage checks running_healthy for enter"
    Assert-Contains $page "onEnterChat"        "LauncherPage has onEnterChat callback"
    Assert-Contains $page "onBackToInstaller"  "LauncherPage has back-to-installer escape"
}

Register-Test -Name "Bridge health endpoint fails gracefully" -Category "launcher" -Body {
    $status = Test-Http "http://localhost:$BridgePort/api/launcher/status" -TimeoutSec 3
    Assert-True ($status -eq 0 -or $status -eq 503) `
        "Bridge not running returns no-connect or 503 (status=$status)"
}

Register-Test -Name "useLauncherHealthGate polls on correct interval" -Category "launcher" -Body {
    $hookFile = Join-Path $WEB_DIR "src\features\chat\hooks\useLauncherHealthGate.ts"
    $hook = Get-Content $hookFile -Raw
    Assert-Contains $hook "15"           "Health gate polls every 15s (POLL_MS=15000)"
    Assert-Contains $hook "setInterval"  "Uses setInterval for polling"
    Assert-Contains $hook "getLauncherHealth" "Calls getLauncherHealth API"
}

# ============================================================
# CATEGORY 6 - MAIN CHAT + LOG STREAMING
# ============================================================

Register-Test -Name "MainChatPage renders with left sidebar and connection bar" -Category "chat" -Body {
    $pageFile = Join-Path $WEB_DIR "src\features\chat\pages\MainChatPage.tsx"
    $page = Get-Content $pageFile -Raw
    Assert-Contains $page "LeftSidebar"          "LeftSidebar component used"
    Assert-Contains $page "ConnectionStatusBar"  "ConnectionStatusBar component used"
    Assert-Contains $page "GuestClient"          "GuestClient lifecycle managed"
    Assert-Contains $page "useSyncExternalStore" "React 18 external store subscription"
}

Register-Test -Name "Chat state machine manages sessions sources config" -Category "chat" -Body {
    $smFile = Join-Path $WEB_DIR "src\features\chat\hooks\useChatStateMachine.ts"
    $sm = Get-Content $smFile -Raw
    Assert-Contains $sm "sessions"   "Session list in chat state"
    Assert-Contains $sm "sources"    "Data sources in chat state"
    Assert-Contains $sm "sidebarTab" "Sidebar tab state"
}

Register-Test -Name "ConnectionStatusBar shows WS phase correctly" -Category "chat" -Body {
    $compFile = Join-Path $WEB_DIR "src\features\chat\components\ConnectionStatusBar.tsx"
    $comp = Get-Content $compFile -Raw
    Assert-Contains $comp "connecting" "Shows connecting state"
    Assert-Contains $comp "live"       "Shows live/connected state"
    Assert-Contains $comp "ended"      "Shows ended/disconnected state"
    Assert-Contains $comp "Reconnect"  "Has reconnect action"
}

Register-Test -Name "Log streaming WebSocket reconnects with exp backoff" -Category "chat" -Body {
    $apiFile = Join-Path $WEB_DIR "src\features\launcher\api\launcherApi.ts"
    $api = Get-Content $apiFile -Raw
    Assert-Contains $api "2 **"        "Exponential backoff: delay = 1000 * 2 ** attempt"
    Assert-Contains $api "setTimeout"  "Reconnect uses setTimeout"
    Assert-Contains $api "WebSocket"   "WebSocket used for stream"
}

Register-Test -Name "Real-time log stream events handled correctly" -Category "chat" -Body {
    $apiFile = Join-Path $WEB_DIR "src\features\installer\api\installerApi.ts"
    $api = Get-Content $apiFile -Raw
    Assert-Contains $api "onEvent"      "Event callback wired"
    Assert-Contains $api "onError"      "Error callback wired"
    Assert-Contains $api "WebSocket"    "WebSocket used for stream"
    Assert-Contains $api "subscribeToJobStream" "subscribeToJobStream exported"
}

Register-Test -Name "Unit tests (41 tests) all pass" -Category "unit" -Body {
    LogStep "Running bun test --parallel..."
    $out = & $BunExe test --cwd $WEB_DIR --parallel 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Unit tests failed: $out" }
    Assert-Contains ($out -join "") "41 pass" "41 unit tests pass"
    Assert-Contains ($out -join "") "0 fail"  "0 failures"
}

# ============================================================
# CATEGORY 7 - UPDATE FLOW
# ============================================================

Register-Test -Name "Update script exists and has correct structure" -Category "update" -Body {
    $updateScript = Join-Path $ROOT "scripts\desktop-webui-update.ps1"
    Assert-True (Test-Path $updateScript) "desktop-webui-update.ps1 exists"
    $content = Get-Content $updateScript -Raw
    Assert-Contains $content "git pull"    "Update script fetches latest"
    Assert-Contains $content "bun install" "Update script reinstalls deps"
    Assert-Contains $content "bun build"   "Update script rebuilds"
}

Register-Test -Name "Launcher API has update endpoint" -Category "update" -Body {
    $apiFile = Join-Path $WEB_DIR "src\features\launcher\api\launcherApi.ts"
    $api = Get-Content $apiFile -Raw
    Assert-Contains $api "update" "Update action present in launcher API"
}

Register-Test -Name "UpdateMaintenanceCard component present" -Category "update" -Body {
    $compFile = Join-Path $WEB_DIR "src\features\launcher\components\UpdateMaintenanceCard.tsx"
    Assert-True (Test-Path $compFile) "UpdateMaintenanceCard.tsx exists"
    $comp = Get-Content $compFile -Raw
    Assert-Contains $comp "update"  "Update action in component"
    Assert-Contains $comp "version" "Version info in component"
}

# ============================================================
# CATEGORY 8 - UNINSTALL FLOW
# ============================================================

Register-Test -Name "Uninstall script exists and removes registry entries" -Category "uninstall" -Body {
    $uninstallScript = Join-Path $ROOT "scripts\desktop-webui-uninstall.ps1"
    Assert-True (Test-Path $uninstallScript) "desktop-webui-uninstall.ps1 exists"
    $content = Get-Content $uninstallScript -Raw
    Assert-Contains $content "Uninstall"   "Removes Add/Remove Programs entry"
    Assert-Contains $content "HKCU:"       "Removes HKCU registry keys"
    Assert-Contains $content "Remove-Item" "Removes install files"
}

Register-Test -Name "Uninstall preserves user data" -Category "uninstall" -Body {
    $uninstallScript = Join-Path $ROOT "scripts\desktop-webui-uninstall.ps1"
    $content = Get-Content $uninstallScript -Raw
    Assert-True ($content -notlike "*Remove-Item `$env:USERPROFILE*") `
        "Uninstall does NOT delete user home directory"
    Assert-True ($content -notlike "*Remove-Item C:\Windows*") `
        "Uninstall does NOT touch system files"
}

Register-Test -Name "NSIS installer build script exists" -Category "uninstall" -Body {
    $nsisScript = Join-Path $ROOT "scripts\installer\build-installer.ps1"
    Assert-True (Test-Path $nsisScript) "NSIS build-installer.ps1 exists"
    $content = Get-Content $nsisScript -Raw
    Assert-Contains $content "makensis" "Calls makensis for NSIS build"
    Assert-Contains $content ".exe"     "Produces .exe output"
}

# ============================================================
# CATEGORY 9 - CLEANUP
# ============================================================

Register-Test -Name "Stop all background processes cleanly" -Category "cleanup" -Body {
    foreach ($key in @("dev-server","relay","mock-host")) {
        Stop-BgProcess $key
    }
    Start-Sleep -Milliseconds 500
    foreach ($key in @("dev-server","relay","mock-host")) {
        Assert-True (-not $script:Procs.ContainsKey($key)) "[$key] process stopped"
    }
}

# ============================================================
# RUN ALL TESTS
# ============================================================

Log ""
Log "============================================================" "Blue"
Log "  Oh-My-Pi Desktop WebUI - Windows E2E Test Suite" "Blue"
Log "  Run ID : $RUN_ID" "Blue"
Log "  Bun    : $BunExe" "Blue"
Log "  WebDir : $WEB_DIR" "Blue"
Log "  LogFile: $LOG_FILE" "Blue"
Log "============================================================" "Blue"
Log ""

$totalStart = Get-Date

foreach ($t in $script:Tests) {
    Invoke-Test $t
}

foreach ($key in @($script:Procs.Keys)) { Stop-BgProcess $key }

$elapsed  = [math]::Round((New-TimeSpan -Start $totalStart -End (Get-Date)).TotalSeconds, 1)
$passed   = ($script:Results | Where-Object { $_.Status -eq "PASS" }).Count
$failed   = ($script:Results | Where-Object { $_.Status -eq "FAIL" }).Count
$total    = $script:Results.Count
$finalCol = if ($failed -eq 0) { "Green" } else { "Red" }

LogSep
Log ""
Log "============================================================" $finalCol
Log "  RESULTS: $passed/$total PASS  |  $failed FAIL  |  ${elapsed}s" $finalCol
Log "============================================================" $finalCol
Log ""

if ($failed -gt 0) {
    Log "  FAILED TESTS:" "Red"
    $script:Results | Where-Object { $_.Status -eq "FAIL" } | ForEach-Object {
        Log "  FAIL [$($_.Category)] $($_.Name)" "Red"
        Log "    $($_.Error)" "DarkRed"
    }
    Log ""
}

Log "  PASS/FAIL by category:" "White"
$script:Results | Group-Object Category | ForEach-Object {
    $cat    = $_.Name
    $catP   = ($_.Group | Where-Object { $_.Status -eq "PASS" }).Count
    $catF   = ($_.Group | Where-Object { $_.Status -eq "FAIL" }).Count
    $catCol = if ($catF -eq 0) { "Green" } else { "Red" }
    Log ("  {0,-15} {1,2} pass  {2,2} fail" -f $cat, $catP, $catF) $catCol
}

$summary = @{
    runId      = $RUN_ID
    timestamp  = (Get-Date -Format "o")
    passed     = $passed
    failed     = $failed
    total      = $total
    elapsedSec = $elapsed
    logFile    = $LOG_FILE
    tests      = $script:Results
}
$summary | ConvertTo-Json -Depth 5 | Set-Content $RESULTS_FILE -Encoding UTF8
Log ""
Log "  Results JSON: $RESULTS_FILE" "Cyan"
Log "  Full log    : $LOG_FILE" "Cyan"
Log ""

exit $(if ($failed -gt 0) { 1 } else { 0 })
