# LIKApcs — GitHub repository & CI setup

The repository is prepared locally with a clean history. This guide creates the **private** GitHub
repository `LIKApcs`, pushes the code, protects `main`, and configures the secrets the workflows use.
Nothing in the repository contains credentials; everything sensitive lives in GitHub Actions secrets
or local `.env` files.

## 1. Create the private repository

**Web UI:** GitHub → New repository → Name `LIKApcs` → **Private** → _do not_ add README/.gitignore/licence
(the repo already has them) → Create.

**or GitHub CLI:**

```bash
gh auth login
gh repo create LIKApcs --private --source=. --remote=origin --push
```

**Manual push** (if you created it in the web UI):

```bash
cd LIKApcs
git remote add origin git@github.com:<your-account>/LIKApcs.git
git push -u origin main
```

## 2. Branch protection (Settings → Branches → Add rule for `main`)

- ✅ Require a pull request before merging (1 approval; owners can bypass for solo work)
- ✅ Require status checks to pass: `Lint & typecheck`, `Tests & migration validation`, `Build (server bundle + admin web)`
- ✅ Require branches to be up to date before merging
- ✅ Do not allow force pushes / deletions
- Optional: require signed commits.

## 3. What the workflows do

### `ci.yml` — on every push/PR to `main`

| Job                           | Steps                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint & typecheck              | `pnpm lint`, `pnpm typecheck`, `pnpm format:check`                                                                                            |
| Tests & migration validation  | PostgreSQL 17 service → migrate from empty → status → **migrate again (must be a no-op)** → `pnpm test` (shared + server integration + admin) |
| Build                         | server bundle (`dist/`) + admin web bundle, uploaded as artifacts (7 days)                                                                    |
| Windows native build (manual) | `workflow_dispatch` only: `tauri build` on `windows-latest`, uploads the **unsigned** NSIS installer for smoke tests                          |

### `release.yml` — on tag `vX.Y.Z` (or manual with an existing tag)

1. **Verify**: the tag equals the `version` in root, `apps/likapcs-admin` and `apps/likapcs-server`
   `package.json`, and `CHANGELOG.md` has a `## [X.Y.Z]` section. Otherwise the release fails.
2. **Server bundle**: `likapcs-server-X.Y.Z.zip` (dist, migrations, `.env.example`, production
   `node_modules`).
3. **Admin installer**: `LIKApcs-Setup.exe` built on `windows-latest` with Tauri; code-signed if the
   certificate secrets exist; update-signature `.sig` produced if the Tauri signing key exists.
4. **Publish**: `SHA256SUMS.txt`, changelog section as release notes, **draft** GitHub release with
   all files attached. You publish it manually after installing it on a test PC.

> **Status (Phase 1):** both workflow files are in place and `ci.yml` steps are the exact commands
> that were run locally. Neither workflow has executed on GitHub yet — the first push will show
> whether the hosted runners agree. No installer or release exists until `release.yml` has run
> successfully on a tag and you have published the draft.

## 4. Secrets (Settings → Secrets and variables → Actions)

| Secret                               | Needed for                                                                         | How to create                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Signed auto-updates (Phase 7)                                                      | `pnpm --filter @likapcs/admin tauri signer generate -w ~/.tauri/likapcs.key` → paste the private key; the **public** key goes into `tauri.conf.json` in Phase 7 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | same                                                                               | the password you chose when generating the key                                                                                                                  |
| `WINDOWS_CERTIFICATE`                | Authenticode code signing (optional but recommended to avoid SmartScreen warnings) | base64 of your `.pfx`: `base64 -w0 cert.pfx`                                                                                                                    |
| `WINDOWS_CERTIFICATE_PASSWORD`       | same                                                                               |                                                                                                                                                                 |

Keep the Tauri private key backed up offline. **If it is lost, already-installed Admin apps can never
accept another update** and must be reinstalled manually — that is the point of signed updates.

## 5. Private repo + auto-updates (Phase 7 note)

GitHub release assets of a **private** repository are not downloadable anonymously. In Phase 7 the
server will act as the update proxy: it fetches the release manifest/installers with a fine-grained
PAT (read-only, Contents) stored in the server's `.env`, verifies the signature, and serves them on
the LAN to Admin and Client PCs. Client PCs never hold GitHub credentials.

## 6. Release procedure (from Phase 2 onwards)

```bash
# 1. bump versions in root + apps/*/package.json (keep them equal), update CHANGELOG.md
pnpm -r exec -- npm version 0.2.0 --no-git-tag-version   # or edit by hand
# 2. commit, tag, push
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main --tags
# 3. wait for the Release workflow, install the draft's LIKApcs-Setup.exe on a test PC, then publish the draft
```

## 7. Recommended repository settings

- **Settings → Actions → General**: allow GitHub actions and reusable workflows from verified
  creators; workflow permissions "Read and write" (needed to create draft releases).
- **Settings → Code security**: enable Dependabot alerts and secret scanning (available on private
  repos with GitHub Advanced Security or on free plans for alerts).
- Add `CODEOWNERS` if more than one person contributes.
