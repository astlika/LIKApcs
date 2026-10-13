; LIKApcs-Client installer hooks (Tauri NSIS, see https://v2.tauri.app/distribute/windows-installer/).
;
; While the lock screen is shown the client disables Task Manager through the per-user policy
; DisableTaskMgr (src/kiosk.rs) and re-enables it on unlock/exit. Should the client ever be removed
; while locked, the uninstaller clears the policy so the PC is left exactly as it was.
;
; Boot (0.17.0): Windows postpones Run-key autostart apps by up to 10 s (StartupDelayInMSec), which
; left the desktop — taskbar and all — visible after power-on. The value is written here so the
; very first boot after installing locks at once, and removed on uninstall.
;
; The client is a Tauri 2 / WebView2 application: Windows 10 and 11 are supported. Older systems
; (7 / 8 / 8.1) cannot run WebView2-based apps — the installer says so instead of installing a
; client that could never start.

!macro NSIS_HOOK_PREINIT
  ; Windows 10 = NT 10.0. Anything older gets a clear message and no install.
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "LIKApcs-Client needs Windows 10 or Windows 11.$\r$\n$\r$\nThis PC runs an older Windows, which cannot run the WebView2 runtime the client is built on. The install stops here; nothing was changed on this PC."
    Quit
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Serialize" /v StartupDelayInMSec /t REG_DWORD /d 0 /f'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableTaskMgr /f'
  Pop $0
  nsExec::ExecToLog 'reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Serialize" /v StartupDelayInMSec /f'
  Pop $0
!macroend
