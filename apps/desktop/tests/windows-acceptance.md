# Windows desktop POC acceptance record

Copy this file or its tables into the PR evidence. Keep every manual item at
`UNRUN` until a human performs it on native Windows. A successful build does not
imply that media, OAuth, or resource checks passed.

## Environment

| Field                             | Recorded value |
| --------------------------------- | -------------- |
| Test date/time (UTC)              | UNRUN          |
| Git commit                        | UNRUN          |
| Windows edition/build             | UNRUN          |
| WebView2 runtime version          | UNRUN          |
| CPU / logical processors          | UNRUN          |
| RAM                               | UNRUN          |
| GPU and driver                    | UNRUN          |
| Display count/resolutions/scaling | UNRUN          |
| Installer filename and SHA-256    | UNRUN          |
| Chatto server version/commit      | UNRUN          |
| LiveKit server version/topology   | UNRUN          |

Allowed status values are `PASS`, `FAIL`, `BLOCKED`, and `UNRUN`. Evidence must
not contain tokens, callback URLs/query strings, usernames, room names, server
private URLs, window titles, or message/media payloads.

## Required functional checks

| Area                | Exact check                                                                                                                                           | Status | Evidence / non-sensitive notes |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------ |
| Package             | Run `verify-package.ps1`; record size, hash, signature state, product name, and version.                                                              | UNRUN  |                                |
| Install             | Install the unsigned POC in a disposable/trusted test environment without disabling Windows security controls.                                        | UNRUN  |                                |
| Launch              | Launch from the Start menu with no development server; the packaged renderer appears and DevTools are unavailable.                                    | UNRUN  |                                |
| Single instance     | Launch a second copy; no second window/process tree persists and the existing window is focused.                                                      | UNRUN  |                                |
| First server        | Add an HTTPS self-hosted server from a fresh client profile and reach its login choice.                                                               | UNRUN  |                                |
| URL policy          | Confirm non-loopback plaintext HTTP is rejected and loopback HTTP remains usable for development.                                                     | UNRUN  |                                |
| OAuth               | Complete server OAuth in the system browser and return through the ephemeral loopback callback.                                                       | UNRUN  |                                |
| OAuth cleanup       | Cancel and time out separate OAuth attempts; confirm the listener closes and no token/query data appears in logs.                                     | UNRUN  |                                |
| ConnectRPC          | Load authenticated server, room, member, and message data through the native HTTP transport.                                                          | UNRUN  |                                |
| Realtime            | Send a message from a second client and observe it live; reconnect after a short network interruption.                                                | UNRUN  |                                |
| Restricted network  | Repeat login/data/realtime checks on a network where browser-origin CORS would not permit arbitrary access.                                           | UNRUN  |                                |
| E2EE voice          | Join an encrypted LiveKit call with a second client, verify two-way audio, mute, deafen, device selection, and clean leave/rejoin.                    | UNRUN  |                                |
| Camera              | Enable/disable camera and verify the remote receiver sees the encrypted track without reconnecting.                                                   | UNRUN  |                                |
| Share 720p30        | Share motion/content at 1280x720/30; record actual diagnostics and remote quality.                                                                    | UNRUN  |                                |
| Share 720p60        | Share motion/content at 1280x720/60; record actual diagnostics and remote quality.                                                                    | UNRUN  |                                |
| Share 1080p30       | Share motion/content at 1920x1080/30; record actual diagnostics and remote quality.                                                                   | UNRUN  |                                |
| Share 1080p60       | Share motion/content at 1920x1080/60; record actual diagnostics and remote quality.                                                                   | UNRUN  |                                |
| Share retune        | Change quality during an active share; confirm no second picker appears and diagnostics reflect the new ceiling.                                      | UNRUN  |                                |
| Entire-screen audio | Select an entire Windows display with share-audio enabled and verify remote system audio plus video. Record `BLOCKED` if WebView2 does not expose it. | UNRUN  |                                |
| PTT muted           | Mute, unfocus/minimise Chatto, hold `Control+Shift+Space`, verify speech only while held, then verify mute restoration.                               | UNRUN  |                                |
| PTT unmuted         | While already unmuted, press/release PTT and verify the microphone remains unmuted.                                                                   | UNRUN  |                                |
| PTT deafened        | While deafened, press/release PTT and verify neither deafen nor mute is overridden.                                                                   | UNRUN  |                                |
| PTT cleanup         | Hold/release around call leave and immediately join another call; confirm no stale shortcut or enabled microphone.                                    | UNRUN  |                                |
| Tray close          | Close the window; process/call continue, tray remains, and Show restores/focuses the window.                                                          | UNRUN  |                                |
| Tray call controls  | Toggle mute and deafen from the tray; labels and renderer state remain in sync.                                                                       | UNRUN  |                                |
| Tray quit           | Choose Quit; host and descendant WebView2 processes terminate and the shortcut unregisters.                                                           | UNRUN  |                                |
| Navigation          | Open an approved HTTPS link in the system browser; confirm remote top-level navigation, popups, `file:`, and script URLs are denied.                  | UNRUN  |                                |
| Uninstall           | Uninstall from Windows settings; installed application files/shortcuts are removed without changing user server data outside documented scope.        | UNRUN  |                                |

## Resource measurements

For each scenario, run `measure-resources.ps1` against the host PID for at least
60 seconds after a 30-second settle period. Preserve the generated JSON/CSV as
PR artifacts, not repository files. Report host plus descendant WebView2 totals
and note when GPU counters are unavailable rather than substituting zero.

| Scenario                    | Duration | Avg/peak CPU % | Avg/peak working set | Avg/peak private memory | Avg/peak GPU % | Evidence | Status |
| --------------------------- | -------- | -------------- | -------------------- | ----------------------- | -------------- | -------- | ------ |
| Idle, window visible        | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| Idle, window hidden to tray | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| E2EE two-person voice       | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| E2EE camera call            | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| 720p30 screen share         | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| 720p60 screen share         | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| 1080p30 screen share        | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| 1080p60 screen share        | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |

## Screen-share diagnostics

Record a representative steady-state sample and the worst sample for each
quality tier. Unavailable WebRTC fields remain `null`.

| Tier    | Actual resolution/FPS | Bitrate | Codec | Avg encode ms | Limitation reason | Packets/retransmits | RTT   | Frames sent/dropped | Status |
| ------- | --------------------- | ------- | ----- | ------------- | ----------------- | ------------------- | ----- | ------------------- | ------ |
| 720p30  | UNRUN                 | UNRUN   | UNRUN | UNRUN         | UNRUN             | UNRUN               | UNRUN | UNRUN               | UNRUN  |
| 720p60  | UNRUN                 | UNRUN   | UNRUN | UNRUN         | UNRUN             | UNRUN               | UNRUN | UNRUN               | UNRUN  |
| 1080p30 | UNRUN                 | UNRUN   | UNRUN | UNRUN         | UNRUN             | UNRUN               | UNRUN | UNRUN               | UNRUN  |
| 1080p60 | UNRUN                 | UNRUN   | UNRUN | UNRUN         | UNRUN             | UNRUN               | UNRUN | UNRUN               | UNRUN  |

## Decision gate

Tauri/WebView2 can advance only when authentication, native transports, E2EE
voice, global PTT, tray lifecycle, and install/uninstall pass, and when resource
measurements are recorded honestly. A WebView2 media failure—especially required
entire-screen system audio or unacceptable encoder/resource behavior—must be
recorded with reproducible evidence before considering the ADR-052 Electron
fallback. An unrun check is not a pass.
