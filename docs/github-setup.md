# LIKApcs — GitHub repository, releases & in-app updates

The code lives in the **public** GitHub repository `LIKApcs` (owner: `__GITHUB_OWNER__`). Public was
chosen deliberately: GitHub release assets of a public repository can be downloaded anonymously, which
lets the installed Admin application update itself straight from GitHub Releases with no proxy, no
token and no extra infrastructure. Nothing in the repository contains credentials — everything
sensitive lives in GitHub Actions secrets or local `.env` files, and the repository is scanned for
secrets before every push.

## 1. Repository creation (done once)

```bash
gh auth login                                    # or GH_TOKEN=<classic PAT with repo + workflow scopes>
gh repo create LIKApcs --public --source=. --remote=origin --push
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.likapcs-secrets/likapcs-updater.key
```

## 2. How a release is produced

A release is a git tag `vX.Y.Z` on `main`. `.github/workflows/release.yml` then runs:

| Job                           | What it does                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Verify**                    | tag == `version` in root, admin and server `package.json` and `src-tauri/Cargo.toml`; `CHANGELOG.md` has a `## [X.Y.Z]` section. Otherwise the run fails before building anything.                                              |
| **Server bundle** (ubuntu)    | `likapcs-server-X.Y.Z.zip`: compiled `dist/`, `database/migrations/`, `deploy/` (Windows service installer), production `node_modules`, `.env.example`, README.                                                                 |
| **Admin installer** (windows) | `pnpm tauri build --ci` → `LIKApcs_X.Y.Z_x64-setup.exe` (NSIS, per-user install) **plus** `LIKApcs_X.Y.Z_x64-setup.exe.sig` — the minisign signature made with `TAURI_SIGNING_PRIVATE_KEY`. Also copied as `LIKApcs-Setup.exe`. |
| **Publish** (ubuntu)          | generates `latest.json` (version, notes from the changelog, signature, download URL) and `SHA256SUMS.txt`, then creates the **published** GitHub release with all files attached.                                               |

The release is published immediately (not a draft) because the updater resolves
`https://github.com/<owner>/LIKApcs/releases/latest/download/latest.json`, and GitHub only serves
`/latest/` for published, non-prerelease releases.

### Release procedure

```bash
# 1. bump the version everywhere (root, apps/*/package.json, src-tauri/Cargo.toml)
pnpm release:bump 0.2.0
# 2. move the [Unreleased] notes in CHANGELOG.md under "## [0.2.0] - YYYY-MM-DD"
# 3. commit, tag, push
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main --tags
# 4. watch the Release workflow; installed Admin apps will see the update within a minute of publishing
gh run watch
```

If a release must be withdrawn, delete it (or mark it as pre-release) — the updater will then point
at the previous published release again.

## 3. How the in-app update works (Admin app)

1. On start-up (8 s after launch) and whenever the user clicks **Settings → About → Check for updates**,
   the Tauri updater plugin downloads `latest.json` from the release feed configured in
   `src-tauri/tauri.conf.json` (`plugins.updater.endpoints`).
2. If `version` in the manifest is greater than the running version, the topbar shows an
   **"Update available"** badge and the About panel shows the release notes and a
   **Download and install** button.
3. Clicking it downloads the installer (progress bar), **verifies the minisign signature** against
   the public key compiled into the app (`plugins.updater.pubkey`) and runs the NSIS installer in
   passive mode. Because the app is installed per-user, no UAC prompt is needed. The app restarts on
   the new version.
4. Downloads that fail the signature check are rejected before anything is executed. HTTPS alone is
   not trusted.

Browser/dev builds cannot self-update; they show a link to GitHub Releases instead.

**Scope today:** one-click update covers the **Admin application only**. The Server is updated by
unzipping the new bundle and running `npm run migrate` (see `apps/likapcs-server/deploy/README.md`);
the Phase 7 update dashboard will orchestrate server and client updates from the Admin app. The
Client application does not exist yet (Phase 4).

## 4. Secrets (Settings → Secrets and variables → Actions)

| Secret                               | Needed for                                                              | Notes                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | **Required.** Signing the installer so installed apps accept the update | generated with `pnpm --filter @likapcs/admin exec tauri signer generate -w <file>`; the public half is in `tauri.conf.json` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | only if the key was generated with a password                           | the current key has no password; the workflow passes an empty value                                                         |

Authenticode code signing of the installer (a paid certificate) is **not configured yet**, so Windows
SmartScreen shows "Windows protected your PC → More info → Run anyway" the first time
`LIKApcs-Setup.exe` is run. In-app updates are unaffected (they are verified by the minisign
signature). When a certificate is available, add `bundle.windows.certificateThumbprint` or a
`signCommand` to `tauri.conf.json` and import the certificate in the Windows job.

> **Back up the signing private key offline (password manager + offline copy).** If it is lost,
> every installed Admin app will refuse all future updates and must be reinstalled by hand with a
> new key. If it leaks, rotate it: generate a new pair, put the new public key in `tauri.conf.json`,
> ship one release signed with the **old** key (so existing installs accept it), then switch the
> secret to the new key.

## 5. Branch protection (Settings → Branches → Add rule for `main`)

- Require status checks to pass: `Lint & typecheck`, `Tests & migration validation`,
  `Build (server bundle + admin web)`
- Do not allow force pushes / deletions
- Pull requests with 1 approval once more than one person contributes

## 6. CI (`ci.yml`) — every push / PR to `main`

| Job                           | Steps                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Lint & typecheck              | `pnpm lint`, `pnpm typecheck`, `pnpm format:check`                                                                                |
| Tests & migration validation  | PostgreSQL 17 service → migrate from empty → status → **migrate again (must be a no-op)** → `pnpm test` (shared + server + admin) |
| Build                         | server bundle (`dist/`) + admin web bundle, uploaded as artifacts (7 days)                                                        |
| Windows native build (manual) | `workflow_dispatch` only: `tauri build` on `windows-latest` with the signing secret, uploads the installer for smoke tests        |

## 7. Recommended repository settings

- **Settings → Actions → General → Workflow permissions**: "Read and write" (release creation).
- **Settings → Code security**: Dependabot alerts + secret scanning (free on public repositories).
- Public repository ⇒ keep business data, customer records, real `.env` files and backups out of
  it. `.gitignore` already excludes them; the pre-push secret scan in `scripts/` is the second line.
