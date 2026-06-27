; Oh-My-Pi Desktop WebUI — NSIS Installer Script
; Build: makensis installer\desktop-webui.nsi
; Requires: NSIS 3.x (https://nsis.sourceforge.io)
;           dist\ folder already built by bun run build

;──────────────────────────────────────────────────────────────────────────────
; Includes & plugins
;──────────────────────────────────────────────────────────────────────────────
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

;──────────────────────────────────────────────────────────────────────────────
; App metadata
;──────────────────────────────────────────────────────────────────────────────
!define APP_NAME        "Oh-My-Pi Desktop"
!define APP_ID          "omp-desktop"
!define APP_VERSION     "1.0.0"
!define APP_PUBLISHER   "Oh-My-Pi"
!define APP_URL         "https://omp.sh"
!define APP_EXE         "launch.bat"
!define UNINST_KEY      "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!define REG_KEY         "Software\OhMyPi\Desktop"

; Default install dir (user-level, no admin required)
!define DEFAULT_INSTDIR "$LOCALAPPDATA\omp-desktop"

;──────────────────────────────────────────────────────────────────────────────
; General
;──────────────────────────────────────────────────────────────────────────────
Name          "${APP_NAME}"
OutFile       "oh-my-pi-desktop-setup-${APP_VERSION}.exe"
InstallDir    "${DEFAULT_INSTDIR}"
InstallDirRegKey HKCU "${REG_KEY}" "InstallDir"
RequestExecutionLevel user          ; no UAC prompt — user-level install
SetCompressor /SOLID lzma
Unicode True

;──────────────────────────────────────────────────────────────────────────────
; MUI settings
;──────────────────────────────────────────────────────────────────────────────
!define MUI_ABORTWARNING
!define MUI_ICON   "..\assets\icon.ico"
!define MUI_UNICON "..\assets\icon.ico"

!define MUI_WELCOMEPAGE_TITLE   "Welcome to ${APP_NAME} Setup"
!define MUI_WELCOMEPAGE_TEXT    "This will install ${APP_NAME} v${APP_VERSION} on your computer.$\r$\n$\r$\nThe installer will:$\r$\n  • Copy the WebUI files$\r$\n  • Create Desktop and Start Menu shortcuts$\r$\n  • Register the app in Windows$\r$\n$\r$\nClick Next to continue."

!define MUI_FINISHPAGE_RUN         "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT    "Launch ${APP_NAME} now"
!define MUI_FINISHPAGE_SHOWREADME  "$INSTDIR\README.md"
!define MUI_FINISHPAGE_LINK        "Visit ${APP_URL}"
!define MUI_FINISHPAGE_LINK_LOCATION "${APP_URL}"

; Pages — Installer
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE     "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; Pages — Uninstaller
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; Languages
!insertmacro MUI_LANGUAGE "English"

;──────────────────────────────────────────────────────────────────────────────
; Version info (shown in file properties)
;──────────────────────────────────────────────────────────────────────────────
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "CompanyName"     "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright"  "© 2025 ${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} Installer"
VIAddVersionKey "FileVersion"     "${APP_VERSION}"
VIAddVersionKey "ProductVersion"  "${APP_VERSION}"

;──────────────────────────────────────────────────────────────────────────────
; Pre-install checks
;──────────────────────────────────────────────────────────────────────────────
Function .onInit
    ; Require Windows 10+
    ${IfNot} ${AtLeastWin10}
        MessageBox MB_OK|MB_ICONSTOP "Windows 10 or later is required."
        Abort
    ${EndIf}

    ; Check for existing installation
    ReadRegStr $0 HKCU "${REG_KEY}" "InstallDir"
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\*.*"
        MessageBox MB_YESNO|MB_ICONQUESTION \
            "${APP_NAME} is already installed at $0.$\r$\nReinstall / upgrade?" \
            IDYES continue_install
        Abort
        continue_install:
    ${EndIf}
FunctionEnd

;──────────────────────────────────────────────────────────────────────────────
; Installer sections
;──────────────────────────────────────────────────────────────────────────────
Section "Main Application" SecMain
    SectionIn RO  ; required

    SetOutPath "$INSTDIR"

    ; ── Core launcher scripts ────────────────────────────────────────────────
    File "..\scripts\desktop-webui-launch.bat"
    File "..\scripts\desktop-webui-launch.ps1"
    File "..\scripts\desktop-webui-update.ps1"
    File "..\scripts\desktop-webui-uninstall.ps1"
    File "..\README.md"
    File "..\LICENSE"

    ; Rename bat to launch.bat at root
    CopyFiles "$INSTDIR\desktop-webui-launch.bat" "$INSTDIR\launch.bat"
    CopyFiles "$INSTDIR\desktop-webui-launch.ps1" "$INSTDIR\launch.ps1"

    ; ── WebUI dist bundle ────────────────────────────────────────────────────
    SetOutPath "$INSTDIR\packages\collab-web\dist"
    File /r "..\packages\collab-web\dist\*.*"

    ; ── Scripts folder (relay, mock-host) ────────────────────────────────────
    SetOutPath "$INSTDIR\packages\collab-web\scripts"
    File "..\packages\collab-web\scripts\local-relay.ts"
    File "..\packages\collab-web\scripts\mock-host.ts"

    ; ── Write desktop-config.json ────────────────────────────────────────────
    SetOutPath "$INSTDIR"
    FileOpen  $9 "$INSTDIR\desktop-config.json" w
    FileWrite $9 `{"installDir":"$INSTDIR","version":"${APP_VERSION}","port":"8765"}`
    FileClose $9

    ; ── Create logs dir ──────────────────────────────────────────────────────
    CreateDirectory "$INSTDIR\logs"

    ; ── Registry: app info ───────────────────────────────────────────────────
    WriteRegStr   HKCU "${REG_KEY}" "InstallDir"  "$INSTDIR"
    WriteRegStr   HKCU "${REG_KEY}" "Version"     "${APP_VERSION}"
    WriteRegStr   HKCU "${REG_KEY}" "Port"        "8765"
    WriteRegStr   HKCU "${REG_KEY}" "Branch"      "main"

    ; ── Registry: Add/Remove Programs ────────────────────────────────────────
    WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"       "${APP_NAME}"
    WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"    "${APP_VERSION}"
    WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"         "${APP_PUBLISHER}"
    WriteRegStr   HKCU "${UNINST_KEY}" "URLInfoAbout"      "${APP_URL}"
    WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation"   "$INSTDIR"
    WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString"   '"$INSTDIR\Uninstall.exe"'
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify"          1
    WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize"     153600

    ; ── Uninstaller ──────────────────────────────────────────────────────────
    WriteUninstaller "$INSTDIR\Uninstall.exe"

    ; ── Shortcuts ────────────────────────────────────────────────────────────
    CreateDirectory "$SMPROGRAMS\${APP_NAME}"
    CreateShortcut  "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" \
                    "$INSTDIR\launch.bat" "" \
                    "$INSTDIR\launch.bat" 0 SW_SHOWMINIMIZED
    CreateShortcut  "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" \
                    "$INSTDIR\Uninstall.exe"
    CreateShortcut  "$DESKTOP\${APP_NAME}.lnk" \
                    "$INSTDIR\launch.bat" "" \
                    "$INSTDIR\launch.bat" 0 SW_SHOWMINIMIZED

    ; ── Estimate & write size ─────────────────────────────────────────────────
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

SectionEnd

;──────────────────────────────────────────────────────────────────────────────
; Uninstaller
;──────────────────────────────────────────────────────────────────────────────
Section "Uninstall"

    ; Remove shortcuts
    Delete "$DESKTOP\${APP_NAME}.lnk"
    RMDir  /r "$SMPROGRAMS\${APP_NAME}"

    ; Remove registry
    DeleteRegKey HKCU "${REG_KEY}"
    DeleteRegKey HKCU "${UNINST_KEY}"

    ; Remove files
    RMDir /r "$INSTDIR\packages\collab-web\dist"
    RMDir /r "$INSTDIR\packages\collab-web\scripts"
    RMDir /r "$INSTDIR\packages\collab-web"
    RMDir /r "$INSTDIR\packages"
    RMDir /r "$INSTDIR\scripts"
    Delete    "$INSTDIR\launch.bat"
    Delete    "$INSTDIR\launch.ps1"
    Delete    "$INSTDIR\desktop-config.json"
    Delete    "$INSTDIR\README.md"
    Delete    "$INSTDIR\LICENSE"
    Delete    "$INSTDIR\Uninstall.exe"

    ; Remove logs (optional — ask user)
    MessageBox MB_YESNO "Remove log files in $INSTDIR\logs?" IDNO skip_logs
        RMDir /r "$INSTDIR\logs"
    skip_logs:

    RMDir "$INSTDIR"   ; only removes if empty

SectionEnd
