# LIKApcs-Client (Phase 4)

Windows application installed on every customer gaming PC. It is **not implemented yet** — this
directory reserves the workspace location and documents the contract the client must fulfil.

The server side of the contract already exists and is covered by integration tests
(`apps/likapcs-server/test/integration/stations-devices.test.ts`):

1. **Registration** – `POST /api/v1/client/register` with `{ machineId, hostname, osInfo, appVersion, registrationSecret }`.
   The device appears as _pending_ in the Admin app; an administrator assigns it to a station.
2. **Polling** – `GET /api/v1/client/registration/:id?secret=…` until the status becomes `approved`;
   the response then carries the device token **exactly once**. Store it with Windows DPAPI.
3. **Realtime** – connect to `ws://server:4700/ws/client`, send `client.hello`, answer
   `server.command` messages with `client.command_ack` (each `commandId` acknowledged once), send
   `client.heartbeat` on the configured interval.

See `docs/network-protocol.md` for the full message catalogue and the security requirements
(device approval, replay protection, grace periods, offline behaviour).
