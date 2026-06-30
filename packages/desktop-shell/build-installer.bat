@echo off
REM Tạm thời cho build installer trên máy AnhLT.
REM Activate MSVC 18 BuildTools, sau đó chạy `tauri build`.

call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 (
    echo [build-installer] vcvars64.bat failed
    exit /b %errorlevel%
)

where cl.exe
where link.exe

cd /d "C:\Users\AnhLT\Documents\oh-my-pi"
bun --cwd=packages/desktop-shell run build
exit /b %errorlevel%
