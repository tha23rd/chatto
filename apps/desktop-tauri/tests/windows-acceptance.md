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
| Display-capture picker label(s)   | UNRUN          |
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

| Area                | Exact check                                                                                                                                                                                                                              | Status | Evidence / non-sensitive notes |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------ |
| Package             | Run `verify-package.ps1 -SkipAuthenticode`; record size, hash, unsigned beta signature state, product name, version, and verified updater signature.                                                                                     | UNRUN  |                                |
| Install             | Install the beta package through the normal Windows warning flow without disabling Windows security controls.                                                                                                                            | UNRUN  |                                |
| Launch              | Launch from the Start menu with no development server; the packaged renderer appears and DevTools are unavailable.                                                                                                                       | UNRUN  |                                |
| Single instance     | Launch a second copy; no second window/process tree persists and the existing window is focused.                                                                                                                                         | UNRUN  |                                |
| First server        | Add an HTTPS self-hosted server from a fresh client profile and reach its login choice.                                                                                                                                                  | UNRUN  |                                |
| URL policy          | Confirm non-loopback plaintext HTTP is rejected and loopback HTTP remains usable for development.                                                                                                                                        | UNRUN  |                                |
| OAuth               | Complete server OAuth in the system browser and return through the ephemeral loopback callback.                                                                                                                                          | UNRUN  |                                |
| OAuth cleanup       | Cancel and time out separate OAuth attempts; confirm the listener closes and no token/query data appears in logs.                                                                                                                        | UNRUN  |                                |
| ConnectRPC          | Load authenticated server, room, member, and message data through the native HTTP transport.                                                                                                                                             | UNRUN  |                                |
| Realtime            | Send a message from a second client and observe it live; reconnect after a short network interruption.                                                                                                                                   | UNRUN  |                                |
| Restricted network  | Repeat login/data/realtime checks on a network where browser-origin CORS would not permit arbitrary access.                                                                                                                              | UNRUN  |                                |
| E2EE voice          | Join an encrypted LiveKit call with a second client, verify two-way audio, mute, deafen, device selection, and clean leave/rejoin.                                                                                                       | UNRUN  |                                |
| Camera              | Enable/disable camera and verify the remote receiver sees the encrypted track without reconnecting.                                                                                                                                      | UNRUN  |                                |
| Video pop-out       | Pop out a camera and a screen share in turn; verify one always-on-top native window is reused, video continues, call audio is not duplicated, and the window can be moved, resized, maximised, and closed.                                | UNRUN  |                                |
| Pop-out minimise    | Minimise the video pop-out from its Windows title bar, continue using the main window, then restore the pop-out and verify the live video resumes without reconnecting.                                                                  | UNRUN  |                                |
| Pop-out cleanup     | With a feed popped out, leave explicitly, end the call from another client, and stop the published track in separate runs; verify the owning pop-out closes every time.                                                                  | UNRUN  |                                |
| Share 720p30        | Share motion/content at 1280x720/30; record actual diagnostics and remote quality.                                                                                                                                                       | UNRUN  |                                |
| Share 720p60        | Share motion/content at 1280x720/60; record actual diagnostics and remote quality.                                                                                                                                                       | UNRUN  |                                |
| Share 1080p30       | Share motion/content at 1920x1080/30; record actual diagnostics and remote quality.                                                                                                                                                      | UNRUN  |                                |
| Share 1080p60       | Share motion/content at 1920x1080/60; record actual diagnostics and remote quality.                                                                                                                                                      | UNRUN  |                                |
| Share retune        | Change quality during an active share; confirm no second picker appears and diagnostics reflect the new ceiling.                                                                                                                         | UNRUN  |                                |
| Diagnostics export  | From the live share quality gear, copy diagnostics JSON; confirm it parses, includes packet loss/jitter fields, and contains no identifiers or URLs.                                                                                     | UNRUN  |                                |
| Entire-screen audio | Select an entire Windows display with share-audio enabled and verify remote system audio plus video. Record the Windows build, WebView2 runtime version, and exact picker audio-option label in the evidence. Record `BLOCKED` if WebView2 does not expose system audio. | UNRUN | |
| Selected-window application audio | On a Windows/WebView2 combination whose picker offers application audio, select a game or other application window and enable that control. Verify the remote client receives the selected window's video and owning process-tree audio, but hears neither unrelated application output nor Chatto call playback. Record the Windows build, WebView2 runtime version, and exact picker label in the evidence. Record `BLOCKED` rather than passing if WebView2 does not return Chromium's `Application Audio`. | UNRUN | |
| Selected-window fallback sanitisation | On a Windows/WebView2 combination whose picker offers all-system audio instead of application audio, select an application window and enable that control. Verify the remote client receives the selected window's video without screen-share audio, unrelated output, or Chatto call playback, and verify the presenter sees the no-audio warning while video continues. Record the Windows build, WebView2 runtime version, and exact picker label in the evidence. | UNRUN | |
| PTT muted           | Mute, unfocus/minimise Chatto, hold `Control+Shift+Space`, verify speech only while held, then verify mute restoration.                                                                                                                  | UNRUN  |                                |
| PTT unmuted         | While already unmuted, press/release PTT and verify the microphone remains unmuted.                                                                                                                                                      | UNRUN  |                                |
| PTT deafened        | While deafened, press/release PTT and verify neither deafen nor mute is overridden.                                                                                                                                                      | UNRUN  |                                |
| PTT cleanup         | Hold/release around call leave and immediately join another call; confirm no stale shortcut or enabled microphone.                                                                                                                       | UNRUN  |                                |
| Tray close          | Close the window; process/call continue, tray remains, and Show restores/focuses the window.                                                                                                                                             | UNRUN  |                                |
| Taskbar attention   | Create a pending notification; confirm a red dot overlays the taskbar icon, remains while any notification is pending, and clears after all are handled. Confirm an ordinary unread room without a pending notification does not set it. | UNRUN  |                                |
| Tray call controls  | Toggle mute and deafen from the tray; labels and renderer state remain in sync.                                                                                                                                                          | UNRUN  |                                |
| Multi-server calls  | Keep calls connected on two servers; verify PTT/tray control the latest call and return to the earlier call when the latest one ends.                                                                                                    | UNRUN  |                                |
| Tray quit           | Choose Quit; host and descendant WebView2 processes terminate and the shortcut unregisters.                                                                                                                                              | UNRUN  |                                |
| Navigation          | Open an approved HTTPS link in the system browser; confirm remote top-level navigation, non-pop-out windows, `file:`, and script URLs are denied, and the pop-out itself cannot navigate or create a nested window.                       | UNRUN  |                                |
| Uninstall           | Uninstall from Windows settings; installed application files/shortcuts are removed without changing user server data outside documented scope.                                                                                           | UNRUN  |                                |

## Automatic update checks

Use disposable test releases and manifests. Keep each case at `UNRUN` until it
has been exercised with a packaged Windows client; unit or workflow tests are
not substitutes.

| Case                   | Exact check                                                                                                                                                                                        | Status | Evidence / non-sensitive notes |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------ |
| Bridge install         | Install the final pre-updater release, manually install the unsigned beta bridge from GitHub Releases through the normal Windows warning, then confirm automatic update controls are available.    | UNRUN  |                                |
| Stable upgrade         | Install the preceding Tauri-signed Stable beta, publish a higher Stable test release, and confirm the client downloads, prompts, restarts, and reports the new version.                            | UNRUN  |                                |
| Nightly upgrade        | Install the preceding Tauri-signed Nightly beta, publish the next monotonic Nightly test release, and confirm the client downloads, prompts, restarts, and reports the new version.                | UNRUN  |                                |
| Beta publisher warning | Confirm Windows identifies the installer as unsigned/Unknown publisher, the warning can be handled without disabling security controls, and the package hash matches the immutable GitHub release. | UNRUN  |                                |
| Updater signature      | Confirm the update succeeds with the expected Tauri updater signature and is rejected after changing the signature without changing the installer.                                                 | UNRUN  |                                |
| Offline check          | Check while offline; confirm the current client remains usable, the failure is understandable, and a later online retry succeeds.                                                                  | UNRUN  |                                |
| Missing manifest       | Return HTTP 404 for the selected channel; confirm no installer runs, the failure is shown, and retry works after restoration.                                                                      | UNRUN  |                                |
| Malformed manifest     | Serve invalid channel JSON; confirm no installer runs and a later valid check succeeds.                                                                                                            | UNRUN  |                                |
| Interrupted download   | Interrupt connectivity during download; confirm no partial update is installed and a later check downloads and verifies it again.                                                                  | UNRUN  |                                |
| Later                  | Choose **Later**, keep using and relaunching the client, and confirm no restart or installation is forced.                                                                                         | UNRUN  |                                |
| Active call            | Finish a download during an active call; confirm the restart prompt stays hidden until the call ends and the call is not interrupted.                                                              | UNRUN  |                                |
| Active screen share    | Finish a download while sharing a screen; confirm the restart prompt stays hidden until the call ends and sharing is not interrupted.                                                              | UNRUN  |                                |
| Nightly confirmation   | Select Nightly in Preferences; confirm its reduced-testing warning appears and the channel changes only after explicit confirmation.                                                               | UNRUN  |                                |
| Settings state         | Confirm Preferences reports the selected channel, current/checking/downloading/ready or failed state, candidate version, last check, and useful failure state without exposing a URL.              | UNRUN  |                                |
| Return to Stable       | Install a Nightly newer than Stable, switch to Stable, and confirm no downgrade occurs; publish a higher Stable and confirm that update is then offered.                                           | UNRUN  |                                |
| Version and data       | After Stable and Nightly upgrades, confirm the reported version is exact and saved servers, sessions, preferences, and user data remain intact.                                                    | UNRUN  |                                |

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
| E2EE camera + video pop-out | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| 720p30 screen share         | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| 720p60 screen share         | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| 1080p30 screen share        | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |
| 1080p60 screen share        | UNRUN    | UNRUN          | UNRUN                | UNRUN                   | UNRUN          |          | UNRUN  |

## Screen-share diagnostics

Record a representative steady-state sample and the worst sample for each
quality tier. Unavailable WebRTC fields remain `null`.

| Tier    | Actual resolution/FPS | Bitrate | Codec | Avg encode ms | Limitation reason | Packets lost/retransmits | RTT/jitter | Frames sent/dropped | Status |
| ------- | --------------------- | ------- | ----- | ------------- | ----------------- | ------------------------ | ---------- | ------------------- | ------ |
| 720p30  | UNRUN                 | UNRUN   | UNRUN | UNRUN         | UNRUN             | UNRUN                    | UNRUN      | UNRUN               | UNRUN  |
| 720p60  | UNRUN                 | UNRUN   | UNRUN | UNRUN         | UNRUN             | UNRUN                    | UNRUN      | UNRUN               | UNRUN  |
| 1080p30 | UNRUN                 | UNRUN   | UNRUN | UNRUN         | UNRUN             | UNRUN                    | UNRUN      | UNRUN               | UNRUN  |
| 1080p60 | UNRUN                 | UNRUN   | UNRUN | UNRUN         | UNRUN             | UNRUN                    | UNRUN      | UNRUN               | UNRUN  |

## Decision gate

Tauri/WebView2 can advance only when authentication, native transports, E2EE
voice, global PTT, tray lifecycle, and install/uninstall pass, and when resource
measurements are recorded honestly. A WebView2 media failure—especially required
entire-screen system audio, selected-window application audio, fail-closed
fallback sanitisation, or unacceptable encoder/resource behavior—must be
recorded with reproducible evidence before considering the ADR-900 Electron
fallback. An unrun check is not a pass.
