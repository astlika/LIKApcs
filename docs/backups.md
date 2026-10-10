# Backups & restore

LIKApcs backs up the whole PostgreSQL database with its own Node-native engine, because the
embedded Windows PostgreSQL runtime that ships with the main-PC installer has no `pg_dump`. The
same engine also restores — including on a server that uses an external PostgreSQL.

## Where backups live

| Install                 | Default folder                            | Override                       |
| ----------------------- | ----------------------------------------- | ------------------------------ |
| Main PC (embedded DB)   | `%LOCALAPPDATA%\LIKApcs-Data\backups`     | `LIKAPCS_BACKUP_DIR` in `.env` |
| Server with external DB | `<data dir>/backups` (`LIKAPCS_DATA_DIR`) | `LIKAPCS_BACKUP_DIR`           |
| Linux / development     | `~/.local/share/likapcs/backups`          | `LIKAPCS_BACKUP_DIR`           |

The folder is **never inside the installation directory**, so uninstalling or re-installing LIKApcs
does not touch it. Point `LIKAPCS_BACKUP_DIR` at a second disk, a NAS share or a USB drive to keep
copies off the main PC — and use **Download** in the Admin app to take a copy anywhere else.

## Archive format

`likapcs-<kind>-<YYYYMMDD-HHMMSS>.likapcs-backup.tar.gz` — a normal gzip'd tar (opens with 7-Zip):

```
manifest.json          format "likapcs-backup", formatVersion, createdAt, serverVersion,
                       schemaVersion, businessName, kind, tables[{name, rows, bytes}]
tables/<table>.csv     COPY … TO STDOUT (FORMAT csv, HEADER true) for every table in `public`
```

All tables are read inside **one `REPEATABLE READ` snapshot**, so the archive is a consistent point
in time even while the shop is open. Every archive is recorded in `backup_history` with its SHA-256,
size, schema version, duration and who started it.

Kinds: `manual` (button / API / uploaded copy), `scheduled` (daily job), `pre_restore` (safety copy
taken automatically before every restore), `pre_migration` (reserved for the update flow).

## Daily schedule and retention

Settings → System: `backup.enabled` (default on), `backup.time` (default `04:00`, business time
zone), `backup.keep_count` (default 30). The server checks every 30 s and runs the backup once the
local clock passes the configured time — at most once per local day, also across restarts (it
consults `backup_history`). Retention deletes only the oldest **scheduled** archives beyond
`keep_count`; manual uploads and safety copies are never deleted automatically.

## Restore

Admin → Backups → **Restore** (permission `backups.manage`; Owner and Administrator by default).
The dialog requires the administrator's **own password again** and an explicit acknowledgement.
The server then:

1. verifies the archive checksum and that `manifest.schemaVersion` equals the running schema
   (`409 SCHEMA_MISMATCH` otherwise — install the matching LIKApcs version first);
2. writes a `pre_restore` safety copy of the current data;
3. in **one transaction**: truncates every table, copies the archive back parents-before-children
   (foreign-key order from `pg_constraint`), resets all sequences, keeps the current
   `backup_history` rows (they describe the files on disk now) and re-creates the acting
   administrator's session when that user exists in the restored data;
4. drops server caches, broadcasts `system.restored` to every Admin app (they reload all views) and
   disconnects client PCs, which reconnect and re-handshake against the restored device table.

If anything fails, the transaction rolls back and nothing changes. Everything recorded after the
backup was taken is gone after a successful restore — that is the point — but the safety copy from
step 2 can itself be restored to undo the restore.

## Moving to a new PC

1. Install LIKApcs on the new PC and finish the first-run setup (any owner account).
2. Copy the latest archive over and use **Upload archive** in Admin → Backups (or drop it into the
   backup folder and restart the server — files are only known once uploaded or created, so prefer
   the upload button).
3. **Restore** it. The restored employee accounts replace the temporary owner; sign in with the
   credentials from the old PC.
4. Client PCs point at the new server address (Client settings) and are approved again if their
   device tokens changed.

## API

See `docs/network-protocol.md` → _Backups_. Everything is under `/api/v1/backups` and needs
`backups.manage`; uploads are raw `application/octet-stream` bodies.
