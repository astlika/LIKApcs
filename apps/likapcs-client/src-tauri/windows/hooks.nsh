; LIKApcs-Client installer hooks (Tauri NSIS, see https://v2.tauri.app/distribute/windows-installer/).
;
; While the lock screen is shown the client disables Task Manager through the per-user policy
; DisableTaskMgr (src/kiosk.rs) and re-enables it on unlock/exit. Should the client ever be removed
; while locked, the uninstaller clears the policy so the PC is left exactly as it was.

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableTaskMgr /f'
  Pop $0
!macroend
