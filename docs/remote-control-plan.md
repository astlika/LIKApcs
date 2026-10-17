# Plan: remote view and control of gaming PCs (LAN)

Status: phases 1 and 2 are built in 0.20.1 (view, control, session end). Not tested on a real PC yet. Not built: the notice setting (client.remote_notice), the recording setting (client.remote_recording), an end-to-end test over a real connection, and phase 3 (H.264).

- Scope: all phases, including games (H.264 video).
- Access: LAN only (the server and the gaming PCs are in the café network).
- The Windows-key block during Steam games (0.19.10 candidate, commit `376c553`) is part of this
  project: the same input layer decides what is physical and what is remote.

## Goal

From the admin app, staff open any gaming PC like a remote-support tool (TeamViewer style, but
built into LIKApcs and simpler): see the screen live, and when allowed, use the mouse and keyboard.
Every session is visible to the customer when the owner wants it, and every session is audited.

## Decisions

| Topic                     | Decision                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who can use it            | New permissions `remote.view` and `remote.control`. Owner, admin and manager by default. Cashiers: none.                                                                                        |
| Always on                 | The client is always reachable on the LAN while the PC is on. A session is opened on demand; nothing is recorded unless the owner turns recording on (off by default).                          |
| Customer notice           | Owner setting `client.remote_notice` (default on): a visible banner on the PC while a session is open ("Staff are viewing this screen"). Off means no banner.                                   |
| Input while staff control | The physical keyboard and mouse of the customer are blocked for the session. Keys from the remote session are marked as injected by Windows (`LLKHF_INJECTED`) and are let through by the hook. |
| Win key                   | Stays blocked during Steam games for the customer. Remote Win presses are allowed only inside a control session.                                                                                |
| Lock screen               | View of the lock screen is allowed for staff (it is the same screen). Control of the lock screen is not allowed: Windows does not let a normal program send input to the secure desktop.        |
| Elevated windows (UAC)    | Not controllable by a normal client. Documented limitation.                                                                                                                                     |
| Transport                 | The client keeps its outbound connection to the server (it already has one). Video and input go through that connection; the PC never opens a port. TLS on the LAN.                             |
| Audit                     | Every view and control session: who, which PC, start and end, reason, and a count of control events (not the keystrokes).                                                                       |

## Architecture

1. **Capture (client, Rust).** Windows Graphics Capture (falls back to Desktop Duplication).
   Captures the whole desktop including exclusive-fullscreen games where Windows allows it.
2. **Encoding.**
   - Phase 1: JPEG, 960 px wide, 2–3 frames/s, for thumbnails and the first view.
   - Phase 3: H.264 with the hardware encoder (Media Foundation: NVENC / Quick Sync / AMF), 720p–1080p,
     30–60 fps, low-latency settings. JPEG remains the fallback.
3. **Relay (server).** Frames and input events travel over the existing client socket, relayed to
   the admin app. The server does not store frames. A session has a short-lived token issued by the
   server.
4. **Viewer (admin app).** Grid of thumbnails for all PCs (phase 1); focus view for one PC; in
   phase 2 the focus view forwards mouse and keyboard; in phase 3 it decodes H.264 in the webview.
5. **Input injection (client).** `SendInput` for mouse and keyboard, only inside an active,
   permitted session. The customer's physical input is blocked by the same kiosk layer that
   blocks the Windows keys.
6. **Settings and UI.** Admin → Settings → Client screen: `client.remote_notice`,
   `client.remote_recording` (off), `client.remote_max_fps`. Permissions in the roles screen.

## Phases and acceptance

**Phase 1: live view (no control).**

- A grid of all PCs with a thumbnail every 2–3 s, updated only while the grid is open.
- Focus view of one PC at up to 3 fps.
- Session audit entries; permission `remote.view` enforced on the server.
- Acceptance: a PC in a Steam game shows its screen; the view stops when the staff member closes it;
  the server CPU stays under 10% with 20 thumbnails open.

**Phase 2: control.**

- Focus view forwards mouse and keyboard when `remote.control` is granted and the staff member
  presses "Take control". The customer's physical input is blocked during control.
- Customer banner shown while the session is open (if `client.remote_notice` is on).
- Acceptance: typing in a browser on the PC works from the admin app; the customer's keyboard
  does nothing during control; the Win key from the staff member opens the Start menu on the PC
  only during control; the session ends by itself after the staff member leaves or after
  a timeout (default 2 min idle).

**Phase 3: games.**

- H.264 video through the hardware encoder; target 30 fps at 720p on a typical café PC.
- Input latency measured and reported; target under 80 ms on LAN.
- Acceptance: a Steam game is playable from the admin app for 15 min without a freeze;
  the Win-key rule still holds for the customer.

## Risks

- **Games with anti-cheat** may refuse injected input. Test each game the café uses.
- **Exclusive fullscreen** may give a black frame for capture. Windows Graphics Capture usually
  works; test it.
- **GPU load.** The hardware encoder uses GPU time while a game runs. Measure the FPS drop on one PC
  before turning phase 3 on by default.
- **Privacy.** Customers must be told when the setting is on. Recording stays off by default.
- **Windows-only code** cannot be compiled in the sandbox. CI runs `cargo check` on Windows; real
  behaviour needs a test PC.

## What is needed to start

1. A Windows test PC with Steam and one game, on the café LAN.
2. Confirmation of the phase order above (phase 1 first).
3. A GitHub token for pushing the pending commit `376c553` (Win-key block) and this plan.
