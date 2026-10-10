; LIKApcs installer hooks (NSIS). Included by the Tauri-generated installer script
; (tauri.windows.conf.json → bundle.windows.nsis.installerHooks).
;
; The main-PC package ships the LIKApcs Server as a background process. Its files live in
; $INSTDIR\runtime and must not be in use while they are replaced, so every install/update stops the
; server first and starts it again afterwards (migrations run automatically on start-up).
; Business data is in %LOCALAPPDATA%\LIKApcs-Data and is never touched here.
;
; Gaming PCs reach the server on TCP 4700 and find it through UDP 4701; Windows Firewall blocks both
; by default. When the installer runs elevated (right-click → Run as administrator) the inbound rules
; are created here. A plain per-user install cannot (netsh needs elevation) — the Admin app then shows
; a banner on Gaming Stations and adds the rules after one UAC prompt (server_manager::allow_firewall).
; Rule names must match server_manager.rs (firewall_status looks the TCP rule up by display name).

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
  ; Firewall rules (only succeed when elevated; failures are logged and otherwise ignored).
  nsExec::ExecToLog 'netsh advfirewall firewall show rule name="LIKApcs Server API (TCP 4700)"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Allowing LIKApcs through Windows Firewall..."
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="LIKApcs Server API (TCP 4700)" dir=in action=allow protocol=TCP localport=4700 profile=any'
    Pop $0
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="LIKApcs Discovery (UDP 4701)" dir=in action=allow protocol=UDP localport=4701 profile=any'
    Pop $0
  ${EndIf}
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
  ; Firewall rules added by this installer or by the Admin app (no-ops when absent / not elevated).
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="LIKApcs Server API (TCP 4700)"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="LIKApcs Discovery (UDP 4701)"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="LIKApcs Server"'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Data directory (%LOCALAPPDATA%\LIKApcs-Data) is intentionally kept.
!macroend
