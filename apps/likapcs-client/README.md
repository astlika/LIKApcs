# LIKApcs-Client

The agent installed on every customer gaming PC (Windows; Linux/macOS only for development).

| Part          | Where                       | What it does                                                                                                                                                                                    |
| ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol core | `src/lib/protocol.ts`       | Pure, tested logic: command guard (sequence, expiry, replay, clock skew), state reducer (`locked` / `session` / `free`), session countdown, reconnect back-off. No I/O.                         |
| Agent         | `src/lib/agent.ts`          | Discovery → pairing (server pinned by `installationId`) → registration & approval polling → device token → WebSocket, heartbeats, command execution and acknowledgement, local expiry, updates. |
| Native bridge | `src/lib/native.ts`         | Tauri commands with browser fallbacks (dev mode): identity, secret store, discovery, window mode, power, self-update.                                                                           |
| UI            | `src/App.tsx`, `styles.css` | Full-screen lock screen (station code, status, welcome message), session overlay with `HH:MM:SS`, technician panel (`Ctrl+Alt+S`), EN/SQ.                                                       |
| Desktop shell | `src-tauri/`                | Kiosk window + focus guard, Credential Manager secrets, `MachineGuid` identity, UDP discovery, `shutdown /r                                                                                     | /s`, autostart, single instance, signed updater (`latest-client.json`). |

## Security model

- The client never holds business data or credentials beyond its own device token, which it
  receives **once** after an administrator approved the PC in the Admin app.
- Commands arrive only over the authenticated WebSocket, carry a sequence number and an expiry, are
  acknowledged exactly once and are limited to the fixed catalogue (`lock`, `unlock`, `message.show`,
  `session.*`, `power.restart`, `power.shutdown`, `update.apply`). There is no shell/exec command.
- The screen unlocks only for an explicit `unlock` or a `session.start` from the server; the agent
  locks itself when a prepaid session runs out even if the network is down. Billing is never decided
  on the PC.
- Updates are downloaded from GitHub Releases and verified with the ed25519 public key compiled into
  the app before installation.

## Development

```bash
pnpm --filter @likapcs/client dev         # browser mode on http://localhost:1421 against a server on :4700
pnpm --filter @likapcs/client test        # protocol unit tests
pnpm --filter @likapcs/client tauri dev   # native window (needs Rust)
```

`apps/likapcs-server/test/integration/client-agent.test.ts` drives this agent end-to-end against the
real server (registration, approval, commands, replay protection, local expiry, revocation).

Kiosk hardening of Windows itself (replacing the shell, blocking Ctrl+Alt+Del / Task Manager) is
outside the application and documented in `docs/development-setup.md`; the client keeps its window
in front but does not pretend to be a security boundary against a local administrator.
