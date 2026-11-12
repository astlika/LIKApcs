# likalivepcs (Android)

The owner's live view of a LIKApcs shop, on the phone. It shows **every sale** the moment it
happens (who sold, what, how much, the profit), **who sold how much** today, and **every change**
the server records — refunds, cancelled sessions, free minutes, expenses, cash in and out, stock,
prices, sign-ins — each as a notification, also while the app is closed and the screen is off.

It only reads. Nothing in the shop can be changed from this app, and the server is not changed
for it: it uses what LIKApcs Server 0.33 already offers (tested with 0.33.4).

Launcher name `likalivepcs v1`, package `com.likapcs.live`, Android 8.0 or newer. Laid out for
the realme Note 60 (720 × 1600, Android 14); it fits other phones too.

## Install (the owner)

1. Download `likalivepcs-<version>.apk` from the release named _likalivepcs v1 (Android)_ on the
   [releases page](https://github.com/astlika/LIKApcs/releases) and open it on the phone. Android
   asks once to allow installing from this source (the browser or the file manager).
2. Open **likalivepcs v1** and sign in:
   - **Server address** — the main LIKApcs computer, e.g. `192.168.1.10:4700`. The magnifier button
     finds it on the shop's Wi-Fi. Admin › Backups › _Server and network_ lists the addresses. To see
     the shop from anywhere, use the computer's Tailscale address (Tailscale on the phone too).
   - **Username, e-mail, password** — an owner or administrator account (it needs the permissions
     `live.view` and `audit.view`) that has an e-mail saved under Admin › Employees. All three must
     match, as in the LIKApcs phone app.
3. Allow the two things the app asks for: **notifications**, and **running in the background**
   (without it Android stops the app a while after the screen goes off).
4. On realme / OPPO / OnePlus phones also: Settings › Apps › likalivepcs › Battery usage — switch
   on _Allow background activity_ and _Allow auto launch_; in the recent apps, open the menu of the
   likalivepcs card and choose _Lock_. If notifications are late at night, switch off
   Settings › Battery › More settings › _Sleep standby optimisation_.

The sign-in lasts 30 days (the server's `LIKAPCS_REMEMBER_DAYS`); then a notification asks to
sign in again. Sound and importance of each kind of notification are set in Android's own
notification settings for the app (one channel per kind).

## What it shows

| Notification kind  | Examples                                                                      |
| ------------------ | ----------------------------------------------------------------------------- |
| Sales              | `Arta shiti 5.80 €` · `Coca-Cola 0.33l ×2, Çips ×1 · fitimi 4.91 €`           |
| Things to look at  | refunds, voids, cancelled sessions, free minutes, write-offs, failed sign-ins |
| The PCs            | sessions started / ended, requests and orders from the PCs, reservations      |
| Money              | expenses, cash put in / taken out, shifts, debt payments, purchases           |
| Stock and prices   | low stock, stock adjustments, product and price changes                       |
| Staff              | who signed in, accounts, customers                                            |
| System             | settings, backups, devices                                                    |
| Link to the server | no connection for more than 5 minutes; the sign-in has expired                |

A permanent notification shows the day so far: turnover, number of sales, and each staff
member's total. The app has three screens: **Live** (the day's figures, who sold how much, the
sales feed), **Activity** (the list of changes, newest first) and **Settings**. Albanian and English.

A paid action is announced once, as the sale it made. After a gap (no network, phone off) the app
catches up: each missed sale and change is announced once; when there are many, the newest five
are shown one by one and the rest as one line.

## How it works

```
LIKApcs Server ──  /ws/admin  (live.sale, session.changed, reports.changed, …)  ──►  Engine ──► notifications
               ◄─  GET /live/snapshot, /audit-logs, names of PCs / products / people  ──┘        screens
```

- `android/app/src/main/kotlin/com/likapcs/live/core/` — the **engine**: plain Kotlin, no Android
  imports. Its own WebSocket client (`WsClient`), the link and its catch-up logic (`Engine`), the
  wording of every message (`Describe`, `Texts`), and the calls the screens make (`Bridge`).
- `android/app/src/main/kotlin/com/likapcs/live/` — the **Android layer**: a foreground service
  (`LiveService`) that keeps the link open, an alarm and a network callback that check it, a boot
  receiver, the notification channels (`Notifier`), and the activity with the screens.
- `android/app/src/main/assets/www/` — the **screens**: one page of plain HTML, CSS and
  JavaScript in a WebView. They never talk to the server and never see the sign-in token.

The phone needs a direct route to the server (the shop's Wi-Fi, or Tailscale): there is no cloud
in between, so nothing leaves the shop's own network. When the route is gone the app keeps
trying and catches up afterwards.

## Build and check

Needs JDK 17 and the Android SDK (platform 35, build-tools 34+).

```bash
cd apps/likapcs-live/android
./gradlew :app:assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest      # wording, addresses, the WebSocket client, discovery
./gradlew :devhost:installDist        # the engine on a desktop JVM (for the checks below)
```

Against a seeded test server (`node e2e/seed.mjs && node e2e/users.mjs` from the repository root):

```bash
cd apps/likapcs-live/e2e
# The engine against the real server: every kind of message, gaps, lost and dead connections.
LIKALIVE_DEVHOST=../android/devhost/build/install/devhost/bin/devhost node engine-check.mjs
# The app itself on an attached emulator: sign-in on its screen, sales, Android's notifications,
# background, screen off, Doze, a killed process, a restart of the phone.
node phone-check.mjs ../android/app/build/outputs/apk/debug/app-debug.apk
```

`node shop.mjs <command>` plays the shop (a sale, a refund, a session, an expense, …) to watch the
app react. The dev host also serves the screens to a desktop browser:
`devhost 4780 /tmp/store.json ../android/app/src/main/assets/www`.

The workflow `.github/workflows/live-apk.yml` runs all of this on every push that touches the app.

## Release

1. Raise `versionCode` and `versionName` in `android/app/build.gradle`; update `RELEASE_NOTES.md`.
2. Tag the commit `likalivepcs-v<versionName>` and push the tag. The workflow builds, runs every
   check and publishes `likalivepcs-<versionName>.apk` as a GitHub release that is **not** marked
   "Latest" (that link is the Windows installers'). Tags of the form `v1.2.3` belong to the
   Windows release and must not be used here.

### Signing

Android installs an update only when it is signed like the installed app. The signing key is
stored nowhere: `android/signing/signing-key.mjs` derives it at build time from the repository
secret `TAURI_SIGNING_PRIVATE_KEY` (already required by the Windows release) and checks it against
`android/signing/release-certificate.crt`, the public certificate. If that secret is ever
replaced, the next Android version needs a new certificate, and the app has to be uninstalled once
on the phone before the new version installs (only the sign-in is lost; the app keeps no data of
its own). A build without the secret is signed with a throw-away debug key.
