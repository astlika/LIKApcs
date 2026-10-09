# LIKApcs Admin

Desktop application (React + TypeScript + Tauri 2) used by owners, managers and cashiers.
It never touches the database directly: every operation goes through the LIKApcs Server HTTP API
and the `/ws/admin` realtime channel.

## Development

```bash
pnpm --filter @likapcs/admin dev        # Vite dev server on http://localhost:1420 (proxies /api and /ws to :4700)
pnpm --filter @likapcs/admin typecheck
pnpm --filter @likapcs/admin build      # production web bundle in dist/
pnpm --filter @likapcs/admin tauri dev  # native window (requires Rust toolchain + WebView2 on Windows)
pnpm --filter @likapcs/admin tauri build  # LIKApcs-Setup.exe (NSIS) — Windows build machine or CI
```

Set `LIKAPCS_SERVER_URL` to point the dev proxy at a server that is not on `127.0.0.1:4700`.
In the packaged app the server address is entered once on the login screen ("Server address")
and stored locally.

## Structure

```
src/
  i18n/          typed dictionaries (en, sq) and the I18nProvider — every visible string lives here
  lib/           api client, websocket client, storage, formatting helpers
  state/         auth, toasts, app settings (React context)
  components/    ui primitives + application shell (sidebar, topbar, command palette)
  pages/         one file per route
src-tauri/       Rust shell, Tauri config, capabilities, icons
```
