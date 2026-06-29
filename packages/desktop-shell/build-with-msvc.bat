@echo off
REM Activate MSVC env then run tauri build. Used by Claude to build the
REM Windows installer from a non-Developer-Prompt shell.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
where cl.exe
where link.exe
cd /d "C:\Users\Mark-MJ\Documents\oh-my-pi"
bun --cwd=packages/desktop-shell run tauri build
