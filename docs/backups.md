# Backups & restore

LIKApcs backs up the whole PostgreSQL database with its own Node-native engine, because the
embedded Windows PostgreSQL runtime that ships with the main-PC installer has no `pg_dump`. The
same engine also restores — including on a server that uses an external PostgreSQL.

A backup holds **everything the program needs to be the same shop on another PC**: every table and
every uploaded file (product pictures, wallpapers, ad videos, voice files). Since 0.38.0 it is one
file that can be saved anywhere and loaded from the first screen of a new installation.

## Where backups live

| Install                 | Default folder                            | Override                       |
| ----------------------- | ----------------------------------------- | ------------------------------ |
| Main PC (embedded DB)   | `%LOCALAPPDATA%\LIKApcs-Data\backups`     | `LIKAPCS_BACKUP_DIR` in `.env` |
| Server with external DB | `<data dir>/backups` (`LIKAPCS_DATA_DIR`) | `LIKAPCS_BACKUP_DIR`           |
| Linux / development     | `~/.local/share/likapcs/backups`          | `LIKAPCS_BACKUP_DIR`           |

The folder is **never inside the installation directory**, so uninstalling or re-installing LIKApcs
does not touch it. Every archive stays in this folder; **Backup file** additionally writes a copy
where the owner chooses (a USB stick, another disk).

## Archive format

`likapcs-<kind>-<YYYYMMDD-HHMMSS>.likapcs-backup.tar.gz` — a normal gzip'd tar (opens with 7-Zip):

```
manifest.json          always the first entry. format "likapcs-backup", formatVersion, createdAt,
                       serverVersion, schemaVersion, businessName, kind, installationId,
                       tables[{name, rows, bytes, sha256}], uploads{files, bytes},
                       files[{path, bytes, sha256}]
report.txt             the same list in words, for the owner (Albanian)
tables/<table>.csv     COPY … TO STDOUT (FORMAT csv, HEADER true) for every table in `public`
uploads/…              every file of the uploads folder (`LIKAPCS_UPLOAD_DIR`), by its own path
```

All tables are read inside **one `REPEATABLE READ` snapshot**, so the archive is a consistent point
in time even while the shop is open (a running session does not block a backup). Uploaded files are
copied one by one with their checksum; a half-written upload (`.part`) is left out.

**Every archive is read back before it counts as written** (0.38.0): each table and each file in
the finished archive is compared with the manifest — size and SHA-256. An archive that misses
something is deleted and the backup fails, instead of the gap being found at a restore. Archives
made before 0.38.0 carry no per-table and per-file checksums; they restore as before, checked by
size and count only (`RestoreResult.verified = false`).

With a password the same archive is encrypted and gets the extension `.enc`: 8 bytes `LKPBENC1`,
the salt, the IV, the AES-256-GCM ciphertext and its tag; the key comes from the password with
scrypt. Two passwords exist:

- the **backup password of this PC** (Backups page): every archive made here is encrypted with it;
  its key is kept in `backup-keys.json` beside the data, so this PC opens its own archives without
  asking. On another PC the password has to be typed;
- a **password for one file** (0.38.0, `POST /backups/file {password}`): only that file uses it.

Every archive is recorded in `backup_history` with its SHA-256, size, schema version, duration and
who started it.

Kinds: `manual` (button / API / uploaded copy), `scheduled` (daily job), `pre_restore` (safety copy
taken automatically before every restore), `pre_reset` (before a factory reset), `pre_import`
(before a data import) and `pre_migration` (reserved for the update flow).

## Backup file (0.38.0)

Admin → Backups → **Backup file**. The dialog says what the file will hold, takes an optional
password (typed twice) and then:

1. where the web view can show a "save as" window (`window.showSaveFilePicker`, a secure context),
   the owner first chooses the place and the name
   (`LIKApcs-backup-YYYYMMDD-HHMM.likapcs-backup.tar.gz[.enc]`);
2. the server makes the archive as a **job** (`POST /backups/file` → `202 {jobId}`) and reports a
   percentage;
3. the Admin copies the finished archive to the chosen place, then reads that copy back from the
   disk and compares its SHA-256 with the server's. A copy that differs is removed and reported.

Without a "save as" window (the Admin opened in a browser over plain http by IP address), or when
the copy fails, the dialog offers **Download**: a link with a ticket
(`POST /backups/:id/download-ticket`, 10 minutes, that archive only) that the browser saves like any
download. The dialog always shows the folder and file name of the copy on the main PC.

## Daily schedule and retention

Settings → System: `backup.enabled` (default on), `backup.time` (default `04:00`, business time
zone), `backup.keep_count` (default 30). The server checks every 30 s and runs the backup once the
local clock passes the configured time — at most once per local day, also across restarts (it
consults `backup_history`). Retention deletes only the oldest **scheduled** archives beyond
`keep_count`; manual uploads and safety copies are never deleted automatically.

## Restore

A restore can be started from three places; all of them run the same job and show its percentage:

| Where                               | Who                                                             | API                                                     |
| ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| First-run screen of an installation | nobody is signed in; works **only while no user exists**        | `POST /system/restore/upload`, `POST /system/restore`   |
| Login screen                        | the owner's user name and password are typed in the dialog      | `POST /backups/upload`, `POST /backups/:id/restore-job` |
| Admin → Backups                     | a signed-in user with `backups.manage` types their own password | the same                                                |

The server then:

1. verifies the archive checksum; refuses an archive made by a **newer** version
   (`409 ARCHIVE_NEWER` — update this PC first) and one there is no room to unpack
   (`507 NOT_ENOUGH_SPACE`);
2. decrypts (`400 ARCHIVE_PASSWORD_REQUIRED`, `403 ARCHIVE_PASSWORD_WRONG`) and unpacks it into a
   scratch folder inside the backup folder, then checks every table and every file against the
   manifest. Anything missing or changed stops here with `409 ARCHIVE_INCOMPLETE` — **nothing has
   been changed yet**;
3. an archive from an **older** version is brought up to this one: a scratch database
   (`likapcs_restore_<hex>`) gets the schema of the archive's version, the archive's rows, and then
   the migrations the archive has not seen — one transaction per migration, exactly as an update
   would have run them. The upgraded tables are what is restored (`409 ARCHIVE_UPGRADE_FAILED`
   otherwise; the scratch database is dropped either way);
4. writes a `pre_restore` safety copy of the current data;
5. in **one transaction**: truncates every table, copies the rows back (the number of rows of every
   table must equal the manifest), checks every reference between them, resets all sequences,
   keeps the current `backup_history` rows (they describe the files on disk now) and re-creates the
   acting administrator's session when that user exists in the restored data. `schema_migrations`
   and `station_heartbeats` are not brought back;
6. replaces the uploads folder with the archive's files and counts them
   (`500 RESTORE_FILES_INCOMPLETE`);
7. when the archive comes from **another installation**, takes over its `installationId` (written
   to `config.json`): the gaming PCs were paired with that identity, find this server by discovery
   and connect with the device rows that were just restored — no new approval;
8. drops server caches, broadcasts `system.restored` to every Admin app (they reload all views) and
   disconnects client PCs, which reconnect and re-handshake against the restored device table.

If anything fails before or inside the transaction, nothing changes. Everything recorded after the
backup was taken is gone after a successful restore — that is the point — but the safety copy from
step 4 can itself be restored to undo the restore.

### Progress

`GET /backups/jobs/:id` returns `percent` (0–100, never backwards, 100 only on success), the
`phase` and, where items are counted, `current` / `total`. It needs **no sign-in** — the job id is
the key — and never touches the database: during the restore transaction every signed-in request
waits (the session check reads tables the restore holds), the progress does not.

The share of the bar each step gets follows the sizes involved (megabytes of tables, megabytes of
files, the size of the safety copy), so a shop with gigabytes of videos and a shop with years of
sales both see the bar move evenly. Two steps cannot say how far they are — the check of every
reference after the rows are loaded, and a migration over the data — and move by the clock,
estimated from how long the rows took to load.

## Moving to a new PC

1. Old PC: Admin → Backups → **Backup file**, saved to a USB stick.
2. New PC: install LIKApcs. On its first screen choose **Rikthe nga kopja (backup)**, pick the
   file and type its password if it has one. No account is needed: the installation is empty.
3. Sign in with the accounts of the old PC.
4. Switch LIKApcs off on the old PC. Both would answer with the same identity, and a gaming PC
   would connect to whichever it finds first.

Gaming PCs that find the server by discovery reconnect by themselves. A PC whose server address was
typed by hand needs the new address, unless the new main PC got the old one's IP address.

The older **USB transfer** (0.27.5, Backups → «Eksporto në USB», first-run screen → «Ose importo
një transferim nga USB») still works: it is protected by a 4-digit code and **revokes** every gaming
PC, which must be approved again.

## API

See `docs/network-protocol.md` → _Backups_. Uploads are raw `application/octet-stream` bodies of up
to 64 GB; the password of an encrypted archive travels in the header `x-archive-password-utf8`
(percent-encoded UTF-8) or, for older callers, `x-archive-password`.

## What is not in a backup

- `config.json` — this installation's own secrets (the embedded database's password, the control
  token). The installation id is carried in the manifest instead.
- `backup-keys.json` — the key of this PC's backup password. An encrypted archive opens on another
  PC with the password itself.
- `updates/` (the cached client installer), `logs/`, and PostgreSQL's own data directory.
- `station_heartbeats` rows (load samples nothing reads) and `schema_migrations` (belongs to the
  running schema).
