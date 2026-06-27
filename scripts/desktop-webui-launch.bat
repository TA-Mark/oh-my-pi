@echo off
:: Oh-My-Pi Desktop WebUI — Launcher (Batch wrapper)
:: Double-click this file to start Oh-My-Pi Desktop.
:: Internally calls the PowerShell launcher.

setlocal

set "SCRIPT_DIR=%~dp0"
set "PS_LAUNCHER=%SCRIPT_DIR%desktop-webui-launch.ps1"

:: If running from install root (launch.bat copied there), find the script
if not exist "%PS_LAUNCHER%" (
    set "PS_LAUNCHER=%SCRIPT_DIR%scripts\desktop-webui-launch.ps1"
)

if not exist "%PS_LAUNCHER%" (
    echo [omp-desktop] ERROR: launch.ps1 not found.
    echo [omp-desktop] Expected at: %PS_LAUNCHER%
    echo [omp-desktop] Please reinstall using desktop-webui-install.ps1
    pause
    exit /b 1
)

:: Check PowerShell is available
where powershell.exe >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [omp-desktop] ERROR: powershell.exe not found. Windows 7+ required.
    pause
    exit /b 1
)

:: Launch — hidden window, bypass execution policy (user-level install)
start "" powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "%PS_LAUNCHER%" %*

endlocal
