# LIKApcs Server — release bundle

This folder is what `likapcs-server-<version>.zip` from GitHub Releases contains:

```
dist/                 compiled server (node dist/index.js) and CLI (node dist/cli.js)
database/migrations/  versioned SQL migrations (applied with `node dist/cli.js migrate`)
deploy/               installation helpers (this folder)
node_modules/         production dependencies (already installed)
package.json          start / migrate / create-admin scripts
.env.example          configuration template → copy to .env
```

## Requirements on the server PC (Windows 10/11 or Windows Server)

1. **Node.js 20 LTS** – <https://nodejs.org> (the installer adds `node` to PATH).
2. **PostgreSQL 15–17** – <https://www.postgresql.org/download/windows/>. Remember the `postgres`
   password you choose during installation.

## Install (first time)

1. Unzip the bundle to `C:\LIKApcs\server` (any folder without spaces works).
2. Create the database role and database. Open **SQL Shell (psql)** from the Start menu, log in as
   `postgres` and run (choose your own strong password):
   ```sql
   CREATE ROLE likapcs LOGIN PASSWORD 'choose-a-strong-password';
   CREATE DATABASE likapcs OWNER likapcs;
   ```
3. Copy `.env.example` to `.env` and edit it:
   - `LIKAPCS_DATABASE_URL=postgres://likapcs:choose-a-strong-password@127.0.0.1:5432/likapcs`
   - `LIKAPCS_HOST=0.0.0.0` so the Admin app and the gaming PCs on the LAN can reach the server
   - `LIKAPCS_BACKUP_DIR` pointing **outside** the install folder, e.g. `D:\LIKApcs-backups`
   - a `LIKAPCS_MIGRATIONS_DIR` is not needed: the bundle keeps `database\migrations` next to `dist\`
4. Open a terminal in the folder and run:
   ```powershell
   npm run migrate        # creates all tables
   npm run create-admin   # creates the first Owner account (asks for username + password)
   npm start              # starts the server on port 4700
   ```
5. Install the Admin application (`LIKApcs-Setup.exe`), enter the server address
   (`http://<server-ip>:4700`) on the login screen and sign in.

## Run as a Windows service (recommended)

`deploy\install-windows.ps1` registers the server as an auto-starting Windows service using
[WinSW](https://github.com/winsw/winsw) and opens TCP 4700 in Windows Firewall for the local network.
Run it from an **elevated** PowerShell in the install folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\install-windows.ps1
```

Logs are written to `logs\` next to `dist\`. Use `.\deploy\install-windows.ps1 -Uninstall` to remove
the service. This script has been reviewed but not yet exercised on a production machine — supervise
the first run.

## Update to a new server version

1. Stop the service (`Stop-Service LIKApcsServer`) or the `npm start` window.
2. Unzip the new bundle **over** the install folder (keep your `.env`).
3. `npm run migrate` – applies only the migrations that are new.
4. Start the service again (`Start-Service LIKApcsServer`).

Always take a backup before updating (`node dist/cli.js backup` is planned for Phase 7; until then
use `pg_dump`). The Admin app refuses to connect to a server with an incompatible protocol version,
so update the server first, then let the Admin apps update themselves.
