; LIKApcs installer hooks (NSIS). Included by the Tauri-generated installer script.
;
; The main-PC package ships the LIKApcs Server as a background process. Its files live in
; $INSTDIR\runtime and must not be in use while they are replaced, so every install/update stops the
; server first and starts it again afterwards (migrations run automatically on start-up).
; Business data is in %LOCALAPPDATA%\LIKApcs-Data and is never touched here.

!macro NSIS_HOOK_PREINSTALL
  ${If} ${FileExists} "$INSTDIR\runtime\likapcs-server.exe"
    DetailPrint "Stopping LIKApcs server..."
    nsExec::ExecToLog '"$INSTDIR\runtime\likapcs-server.exe" "$INSTDIR\runtime\server\dist\cli.js" stop'
    Pop $0
    ; Belt and braces: anything still holding the runtime files is terminated.
    nsExec::ExecToLog 'taskkill /F /IM likapcs-server.exe /T'
    Pop $0
    Sleep 1500
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\runtime\likapcs-server.exe"
    DetailPrint "Starting LIKApcs server..."
    ; `cli.js start` spawns the server detached (no console window, survives the installer) and
    ; returns once it answers on the loopback port — migrations have run by then.
    nsExec::ExecToLog '"$INSTDIR\runtime\likapcs-server.exe" "$INSTDIR\runtime\server\dist\cli.js" start'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$INSTDIR\runtime\likapcs-server.exe"
    DetailPrint "Stopping LIKApcs server..."
    nsExec::ExecToLog '"$INSTDIR\runtime\likapcs-server.exe" "$INSTDIR\runtime\server\dist\cli.js" stop'
    Pop $0
    nsExec::ExecToLog 'taskkill /F /IM likapcs-server.exe /T'
    Pop $0
    Sleep 1500
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Data directory (%LOCALAPPDATA%\LIKApcs-Data) is intentionally kept.
!macroend
