# LIKApcs — Local network protocol

Everything runs over one TCP port on the server (default **4700**, `LIKAPCS_PORT`):

| Channel     | Path                 | Used by | Auth                                 |
| ----------- | -------------------- | ------- | ------------------------------------ |
| HTTP API v1 | `/api/v1/...`        | Admin   | `Authorization: Bearer <token>`      |
| HTTP API v1 | `/api/v1/client/...` | Client  | registration secret (rate-limited)   |
| WebSocket   | `/ws/admin`          | Admin   | `admin.hello` with the user token    |
| WebSocket   | `/ws/client`         | Client  | `client.hello` with the device token |

Transport is plain HTTP/WS on the LAN by default; set `LIKAPCS_TLS_CERT_FILE/KEY_FILE` for HTTPS/WSS
on untrusted networks. Tokens are never logged. Message bodies are JSON; all times are ISO-8601 UTC;
all money is integer cents.

The authoritative definitions live in `packages/shared/src/dto.ts` (HTTP) and
`packages/shared/src/protocol.ts` (WebSocket). Both apps import them, so a protocol change is a
compile error in every component that has not been updated.

## 1. Conventions

- **Success**: JSON body; `201` on create; `204` on actions without a body.
- **Lists**: `{ "items": [...], "page": 1, "pageSize": 25, "total": 123 }`.
- **Errors**: `{ "error": { "code": "validation_error", "message": "…", "details": [...] } }`.
  Codes used: `validation_error` (400, `details` = `[ { path, message } ]`), `unauthorized` (401),
  `forbidden` (403), `not_found` (404), `conflict` (409), `account_locked` (423, `details.lockedUntil`),
  `rate_limited` (429), `internal_error` (500).
- **Versioning**: path prefix `/api/v1`. `GET /system/health` returns server, schema and protocol
  versions; a client checks `isCompatibleWithServer()` (same major, its minor ≤ server minor).

## 2. HTTP API v1 (Phase 1 surface)

### System

| Method | Path                                 | Auth / permission                       | Notes                                                                                  |
| ------ | ------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/system/health`                     | public                                  | `{status, version, schemaVersion, database, time}`                                     |
| GET    | `/system/setup-status`               | public                                  | `{needsSetup, businessName, defaultLanguage}`                                          |
| POST   | `/system/setup`                      | public, **only while zero users exist** | `{businessName, language, owner:{fullName, username, password}}` → `201 LoginResponse` |
| GET    | `/system/info`                       | authenticated                           | versions, uptime, DB latency, connection counts                                        |
| GET    | `/dashboard/summary?date=YYYY-MM-DD` | `dashboard.view`                        | `DashboardSummary` (see architecture › financial definitions)                          |

### Auth

| Method | Path                    | Notes                                                                                       |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------- |
| POST   | `/auth/login`           | `{username, password}` → `{token, expiresAt, user}`; rate-limited; lockout after N failures |
| POST   | `/auth/logout`          | revokes the current token                                                                   |
| GET    | `/auth/me`              | current user + effective permissions                                                        |
| POST   | `/auth/change-password` | `{currentPassword, newPassword}`; clears `mustChangePassword`; revokes other sessions       |

### Users & roles (`users.view` / `users.manage`)

`GET /users?page&pageSize&search&includeInactive`, `GET /users/:id`, `POST /users`, `PATCH /users/:id`
(fullName, email, phone, roles, isActive), `POST /users/:id/reset-password`
(`{newPassword, mustChangePassword}`), `GET /roles` (code, name, rank, permissions[]).
Rank rule: an actor may only manage users with strictly lower privilege; owners may manage owners.

### Settings (`settings.view` / `settings.manage`)

`GET /settings/public` (public keys only, no auth), `GET /settings` (full map),
`PATCH /settings` (partial map; every key validated by the shared schema; audited with old → new).

### Stations & devices (`stations.view` / `stations.manage` / `devices.manage`)

| Method | Path                            | Notes                                                                               |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/stations`                     | all stations with live `status`, `device`, `activeSession`                          |
| GET    | `/stations/:id`                 |                                                                                     |
| GET    | `/stations/:id/connection-logs` | last 100 connect/disconnect events                                                  |
| POST   | `/stations`                     | `{number, name, zone?, notes?, isEnabled}`                                          |
| PATCH  | `/stations/:id`                 | partial                                                                             |
| DELETE | `/stations/:id`                 | `409` if the station has session history or an approved device — disable it instead |
| GET    | `/devices?status=pending`       | registrations                                                                       |
| POST   | `/devices/:id/approve`          | `{stationId}` — one approved device per station                                     |
| POST   | `/devices/:id/reject`           |                                                                                     |
| POST   | `/devices/:id/revoke`           | token invalidated, live socket closed with `4005 DEVICE_REVOKED`                    |
| POST   | `/devices/:id/reissue-token`    | for a reinstalled client that lost its token; the client re-polls with its secret   |

### Client registration (no bearer token; rate-limited per IP)

| Method | Path                                | Notes                                                                                                                                            |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/client/register`                  | `{machineId, hostname, osInfo?, appVersion, registrationSecret}` → `202 {registrationId, status:'pending'}` (`200` if already approved)          |
| GET    | `/client/registration/:id?secret=…` | `{status}`; when approved, **the first successful poll** also returns `deviceToken` and `station`. Subsequent polls never return the token again |

### Audit (`audit.view`)

`GET /audit-logs?page&pageSize&action&actorUserId&entityType&from&to&search`,
`GET /audit-logs/actions` (distinct action names for the filter).

## 3. WebSocket — Admin (`/ws/admin`)

```
Admin → Server   { "type": "admin.hello", "token": "<bearer token>", "protocolVersion": 1 }
Server → Admin   { "type": "server.welcome", "protocolVersion": 1, "serverVersion": "0.1.0", "serverTime": "…" }
Server → Admin   { "type": "server.event", "event": "station.changed" | "device.registered" | "device.changed"
                   | "session.changed" | "notification", "payload": {...}, "ts": "…" }
Admin → Server   { "type": "admin.ping" }      →   { "type": "server.pong", "serverTime": "…" }
```

The first frame must be `admin.hello` within 10 s. Invalid token → `4001`. The Admin app treats
events as _cache invalidation_: it refetches the affected lists rather than trusting the payload
blindly, so a missed event can never leave the UI permanently wrong.

## 4. WebSocket — Client (`/ws/client`)

### Handshake

```
Client → Server  { "type": "client.hello", "token": "<device token>", "appVersion": "0.1.0",
                   "protocolVersion": 1, "machineId": "<same id used at registration>" }
Server → Client  { "type": "server.welcome", "protocolVersion": 1, "serverVersion": "…", "serverTime": "…",
                   "station": { "id", "number", "code", "name" },
                   "heartbeatIntervalSeconds": 10, "offlineAfterSeconds": 30,
                   "language": "sq", "welcomeMessage": "…", "businessName": "…",
                   "session": null | { "id", "status", "startedAt", "endsAt", "pausedAt", "remainingSeconds" } }
```

Failure codes (`server.error` is sent first, then the socket closes):

| Close code | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| 4001       | unauthorized (bad token / machine-id mismatch / revoked)         |
| 4002       | protocol error (malformed frame, hello timeout, duplicate hello) |
| 4003       | incompatible protocol or app version                             |
| 4004       | replaced by a new connection from the same device                |
| 4005       | device revoked by an administrator                               |
| 4010       | server shutting down                                             |

`session: null` means the PC **must be locked**. The client never decides on its own that time is up
for billing purposes — it only displays the authoritative `endsAt` and locks when told (or when it
has lost the server beyond the grace period, as a safety measure).

### Steady state

```
Client → Server  { "type": "client.heartbeat", "ts": "…", "sessionId": null, "locked": true,
                   "metrics": { "cpuPercent": 12, "memoryUsedMb": 2048, "uptimeSeconds": 120 } }
Server → Client  { "type": "server.heartbeat_ack", "serverTime": "…" }

Server → Client  { "type": "server.command", "commandId": "<uuid>", "seq": 7,
                   "command": "session.start" | "session.pause" | "session.resume" | "session.extend"
                            | "session.end" | "lock" | "unlock" | "message.show"
                            | "power.restart" | "power.shutdown" | "update.apply",
                   "payload": {...}, "issuedAt": "…", "expiresAt": "…" }
Client → Server  { "type": "client.ack", "commandId": "<uuid>", "ok": true }
                 { "type": "client.ack", "commandId": "<uuid>", "ok": false, "error": "…" }

Client → Server  { "type": "client.event", "event": "locked" | "unlocked" | "session_expired_locally"
                            | "update_status" | "error", "payload": {...} }
```

Command rules (enforced by the server, to be mirrored by the client):

1. Commands are only sent to **approved, currently connected** devices.
2. `seq` increases monotonically per connection; a client must ignore a command whose `seq` is not
   greater than the last one it processed, and any command past `expiresAt`.
3. Every command is acknowledged **exactly once**; the server ignores duplicate or unknown acks and
   times out un-acked commands (the issuing API call then fails loudly instead of pretending).
4. There is no generic "run this program" command. Power actions require the `stations.power`
   permission and are audited.

### Presence

A device is _online_ while its socket is open. Missing heartbeats for `offlineAfterSeconds` → the
server closes the socket (`timeout` in the connection log) and the station turns _offline_. A new
connection from the same device replaces the old one (`4004`), so a flapping Wi-Fi link never leaves
two live sockets.

## 5. Registration flow (end-to-end)

```
Client PC                         Server                              Admin
   │ POST /client/register ───────▶│ create station_devices (pending)    │
   │ ◀── 202 {registrationId} ─────│ broadcast device.registered ───────▶│ "Devices awaiting approval"
   │ GET /registration/:id?secret ▶│ {status:'pending'}                  │
   │        … every 5 s …          │                                     │ approve → station PC 02
   │ GET /registration/:id?secret ▶│ {status:'approved', deviceToken, station}   (token_collected_at set)
   │ store token with DPAPI        │                                     │
   │ WS client.hello(token) ──────▶│ welcome; station.changed ──────────▶│ card turns "Available"
```

Verified in Phase 1 with the server integration tests (`stations-devices.test.ts`) and an end-to-end
browser run against the Admin UI (register → live pending panel → approve → token once → WS online →
disconnect → offline).
