# Chatto native desktop client

The native client packages the existing SvelteKit frontend in a hardened
Electron shell. Servers remain remote data/API providers; the application
never loads a server-hosted UI into its privileged renderer.

## Development

From the repository root:

```sh
mise build-desktop
mise test-desktop
mise test-desktop-smoke
mise dev-desktop
```

`build-desktop` first produces the static frontend under
`apps/frontend/build`, builds the shared bridge contract, and then compiles the
main process and preload. `dev-desktop` launches that bundled output.

The smoke test launches the real bundled renderer in Electron and checks the
custom origin, bridge boundary, deep-link hand-off, service-worker state, CSP,
and hardened web preferences.

## Native capabilities

- The tray mirrors unread state and offers localized open, mute, deafen, and
  quit actions.
- Native notifications support click navigation and inline replies where the
  operating system exposes them.
- `F8` is the initial global push-to-talk binding. It uses a low-level
  press/release hook, so it continues to work while Chatto is unfocused. On
  macOS, the first registration asks for Accessibility permission.
- On Linux the hook requires an X11 session and the `libXt` runtime. The DEB
  declares that dependency; other package formats report an unavailable hook
  instead of failing the client when the host cannot provide it.
- Launch-on-startup is available on Windows and macOS. The setting is hidden on
  Linux until the supported desktop-environment behaviour can be made
  consistent.
- The app is single-instance and queues launch links until the renderer has
  installed its event subscriptions.

## Calls and screen sharing

The native source picker authorizes one selected screen or application window
for one display-media request. Audio sharing uses system-wide loopback capture
on Windows, so it is not isolated to the selected application; the picker says
so before capture starts. macOS and Linux screen shares are currently
video-only.

Call audio stays in Chromium and LiveKit. Echo cancellation, automatic gain
control, and the existing enhanced noise suppression remain in that pipeline.
LiveKit media-device events refresh the device lists and move an active input,
output, or camera track to an available fallback when a selected device is
removed. The initial client therefore does not ship a second native audio
engine. A detached mini-call window was optional in the implementation plan
and remains deferred.

## Trust boundary

- The only privileged renderer origin is `chatto-app://app`.
- `contextIsolation`, renderer sandboxing, and `webSecurity` stay enabled.
- `window.chattoNative` is an allowlisted bridge with no generic IPC or Node.js
  primitive.
- Remote API and WebSocket origin handling is exact-origin scoped. Origins are
  either already registered in the frontend's server registry or temporarily
  allowed for only the public discovery RPC or OAuth token endpoint after the
  corresponding explicit action.
- OAuth authorization opens in the system browser and returns to an ephemeral
  loopback callback. Remote authorization pages never enter the app window.
- The custom `chatto://` deep-link scheme accepts only the grammar below.

## Deep links

Join or connect to a server:

```text
chatto://join?server=https%3A%2F%2Fchat.example.com
```

Open a message:

```text
chatto://message?server=https%3A%2F%2Fchat.example.com&room=ROOM_ID&event=EVENT_ID&thread=THREAD_ID
```

`server` is reduced to an HTTP(S) origin. Identifiers are bounded and limited
to URL-safe characters. Unknown actions and malformed values are ignored.

## Packaging and updates

Electron Builder produces NSIS and MSI artifacts on Windows, DMG/ZIP artifacts
on macOS, and AppImage/DEB artifacts on Linux. NSIS, ZIP, and AppImage outputs
carry update metadata consumed by `electron-updater`. Platform signing and
notarisation use Electron Builder's standard CI environment variables; local
unsigned builds remain possible.

macOS packages declare the microphone and camera usage strings and retain the
hardened-runtime entitlements needed by Chromium media capture.
The package version is kept in lockstep with the main Chatto release by
release-please.

The packaged frontend, main process, preload, bridge contract, and native
dependencies update as one signed application. Chromium's existing WebRTC
audio processing remains the call audio pipeline; the shell does not add a
second native audio processor.
