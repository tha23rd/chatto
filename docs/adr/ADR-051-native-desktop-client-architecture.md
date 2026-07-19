# ADR-051: Native Desktop Client Architecture

## Status

Accepted

**Date:** 2026-07-18

## Context

Chatto ships as an installable PWA today (FDR-027), so a native desktop client
must justify itself by what a browser tab cannot do. Two capabilities motivate
it:

1. **Native OS integration** — global push-to-talk that works while unfocused,
   system tray with quick mute/deafen, launch-on-startup, taskbar unread badge
   and mention flash, native notifications, single-instance focus, deep links,
   native spellcheck.
2. **Reliable real-time media** — consistent WebRTC behaviour and, in
   particular, **system/application-audio capture during screen share**, without
   the background and capture restrictions browsers impose.

Chatto is **self-hosted and multi-server**: a single client connects to
arbitrary self-hosted servers, each identified by URL with its own bearer token
and identity (ADR-024, ADR-025). Voice/video is routed through LiveKit, an
external WebRTC service; the LiveKit client SDK runs inside the renderer's
WebRTC engine (ADR-009, FDR-016).

Two architectural questions dominate, and they are what this ADR decides:

- **Where does the UI code come from** — bundled in the app, or loaded remotely
  from whichever server the user connects to?
- **Which shell** — a bundled-Chromium runtime (Electron) or an OS-webview
  runtime (Tauri)?

Everything else (packaging, phasing, `apps/desktop/` layout, spike tasks) is
implementation planning and is tracked in the GitHub issue, not here.

## Decision

### 1. Bundle the frontend; reach servers as data only

The app ships Chatto's own SvelteKit build as its renderer and loads it from a
fixed, first-party origin. Remote servers are contacted **only as data** over
ConnectRPC and the realtime WebSocket, exactly as the web client does. The app
does **not** load a remote server's UI code.

**Why:** users connect to arbitrary self-hosted servers. Loading a remote
server's UI *code* into a window that also holds native privileges (filesystem,
global hotkeys, tray, notifications) would grant any malicious or compromised
server code execution with those privileges on the user's machine. A
first-party single-service app can load remote UI safely because it controls the
origin; a generic client for arbitrary servers cannot. Bundling keeps the
privileged origin trusted and fixed, and confines a hostile server to what it
can already attempt against a browser.

This is cheap because the frontend is already `adapter-static` with a
`200.html` fallback (ADR-018) and the multi-server model is already fully
client-side (ADR-025): the shell adds no server-management UI and no auth
redesign.

### 2. Electron, not Tauri

The shell bundles its own Chromium (Electron) rather than riding the per-OS
webview (Tauri).

**Why:** real-time media is a primary motivator, and the LiveKit client plus
`getDisplayMedia` (including screen-share audio) depend on the underlying WebRTC
engine. Electron's bundled Chromium behaves identically on Windows, macOS, and
Linux. Tauri uses WebView2/Chromium (Windows), WKWebView (macOS), and
**WebKitGTK (Linux)**, where WebRTC and screen-share audio are inconsistent to
poor — on exactly the platform self-hosters most often run. Electron's larger
footprint is an acceptable price for making "media works the same everywhere"
true.

### 3. One feature-detected native bridge

Native capabilities are exposed to the unchanged web app through a single,
typed, allow-listed bridge (`window.chattoNative`) injected by an isolated
preload. The renderer runs with `contextIsolation: true`,
`nodeIntegration: false`, and `sandbox: true`; the preload exposes named
capabilities only, never a general "run native code" surface.

**Why:** the same frontend build must run unchanged as a browser PWA (bridge
absent → existing behaviour) and inside the shell (bridge present → native
behaviour). A single feature-detected object keeps native features additive and
optional, and is what lets a future mobile shell (Capacitor) satisfy the same
contract without a web-app rewrite.

### 4. Generic multi-server, reusing the existing client model

The shell is a generic multi-server client. It reuses the existing client-side
server registry and per-server opaque bearer tokens (ADR-024, ADR-025) verbatim;
it builds no server-management UI of its own.

### 5. Relax CORS only for user-registered origins

Because the renderer runs from a fixed app origin, authenticated calls to remote
servers are cross-origin. ADR-025 already establishes that only
`ServerDiscoveryService.GetServer` has wildcard CORS; authenticated ConnectRPC
and realtime traffic are **not** wildcard-CORS and require the server to trust
the calling origin. Self-hosted servers cannot be expected to whitelist a native
app origin.

A native HTTP client is not subject to CORS; a browser is. The shell therefore
emulates a native client **only for origins the user has explicitly registered**:
the main process adjusts CORS response headers scoped to the registered server
origins, and nothing else. Registration is the same act of trust the user
already extends by entering a token for that server. This is the highest-risk
decision in this ADR and must be validated early against preflight, credentialed
requests, and WebSocket upgrade. Proxying API traffic through the main process
was considered and rejected as the default because it would fork the renderer's
ConnectRPC/WebSocket transport.

### 6. Whole-app auto-update; drift absorbed by the API

Because the UI is bundled, a UI change is an app release. The app auto-updates.
A bundled UI that lags a given server is tolerated by the already
mixed-version-tolerant public API, so drift is soft, not breaking.

### 7. Keep call audio in Chromium and LiveKit

The initial native client does not add a second audio engine or a Chatto-owned
native Node audio addon. Chromium and LiveKit continue to own microphone
capture, echo cancellation, automatic gain control, publication, and output.
The existing renderer-owned enhanced noise suppression remains layered onto
that pipeline.

Device hot-swap also stays in the shared renderer: LiveKit media-device change
events refresh the available devices and switch an active microphone, speaker,
or camera away from a removed hardware ID. The shell owns only the capabilities
the browser cannot supply reliably: a low-level global push-to-talk hook and an
explicit desktop-capture source grant. Electron's display-media loopback
provides system-wide audio on Windows (not per-application isolation); the
initial macOS and Linux path is video-only.

This avoids a second capture lifecycle, Electron ABI rebuild work, and another
platform-specific media stack without giving up the existing AEC, AGC, or
device-recovery behaviour. A native audio module should be reconsidered only
if measured production failures cannot be fixed in Chromium/LiveKit, or if a
maintainable cross-platform system-audio API becomes necessary. It must not
duplicate the renderer's noise suppression.

### 8. Deliberately out of scope

- **Remote loading of server UI code** — rejected per Decision 1.
- **In-game overlay** (native injection/hooking) and **game "rich presence" IPC**
  — large effort, niche for self-hosted community chat.
- **Detached mini-call window** — optional shell UI deferred until the main call
  stage has demonstrated a stable compact interaction model.
- **Native noise suppression** — already solved in the renderer; the fork runs
  DeepFilterNet3 client-side. Any future native audio module targets only
  capture, echo cancellation, AGC, and device handling, not noise suppression.

## Consequences

### Positive

- The privileged window only ever runs first-party code; a hostile server is
  confined to browser-equivalent capabilities.
- Near-zero change to the web app: it ships unchanged and feature-detects the
  bridge.
- Media behaves consistently across desktop OSes via bundled Chromium.
- The multi-server registry, bearer auth, and routing are reused as-is.
- The same bridge contract extends to mobile (Capacitor) without a web-app
  rewrite.
- Keeping call audio in the renderer avoids a second media engine and native
  addon ABI lifecycle.

### Negative

- Bundling means a UI change requires an app release and auto-update, not just a
  server deploy.
- Electron's bundled Chromium makes the app substantially larger than a Tauri or
  webview-based shell.
- The CORS relaxation (Decision 5) is a real security-sensitive surface that must
  be tightly scoped to registered origins and carefully tested.
- Bearer tokens in client storage remain XSS-exposed (as noted in ADR-025); the
  native origin does not change that boundary but does fix and trust the origin.
- System/application-audio capture is initially available on Windows only;
  macOS and Linux screen sharing is video-only until Electron exposes a stable
  equivalent or production evidence justifies native capture work.

### Trade-offs

- Choosing Electron over Tauri trades install size and memory for media
  reliability and cross-platform consistency — justified only because media is a
  core motivator.
- Relaxing CORS in the shell trades a small, explicitly scoped deviation from
  browser behaviour for the ability to reach user-trusted servers the way a
  native client naturally would.
- Reusing Chromium/LiveKit audio trades full control over capture internals for
  one shared, already-tested call pipeline and substantially less native code.

## Implementation

- `apps/desktop/` owns the Electron main process, isolated preload, native
  integrations, package configuration, hardening fuses, and Electron smoke
  test. `packages/native-bridge/` owns the complete typed allowlist exposed as
  `window.chattoNative`.
- The static frontend is served from `chatto-app://app` with a report-only CSP
  (including Trusted Types) matching the web frontend, navigation restrictions,
  and no active service worker. The browser build still registers its service
  worker normally.
- The exact-origin policy rewrites the outgoing `Origin` for registered server
  HTTP and WebSocket traffic and reflects the app origin only on responses from
  those same origins. Short-lived probe and OAuth grants cover only the public
  discovery RPC and token endpoint, respectively.
- OAuth authorization uses the system browser and a one-shot random loopback
  callback. Remote authorization UI never enters the privileged window.
- Launch deep links are queued behind an explicit renderer-ready handshake so
  the first process invocation cannot race the frontend subscriptions.
- The Tier A bridge covers tray actions, badges and mention flashing, native
  notifications and inline replies, startup, spellcheck, updates, deep links,
  and global push-to-talk. The window uses the native OS frame, so no
  window-control surface crosses the bridge.
- Screen sharing runs through the ordinary web `getDisplayMedia` path, so the
  frontend ships no screen-share picker. macOS uses the OS system picker
  (`useSystemPicker`); Windows and Linux use a chooser rendered by the main
  process in a hardened child window. The audio intent rides on the
  `getDisplayMedia` constraints (`request.audioRequested`), and Windows display
  capture can include loopback audio.
- Electron Builder targets Windows NSIS/MSI, macOS DMG/ZIP, and Linux
  AppImage/DEB packages. The macOS package declares the required media usage
  descriptions and hardened-runtime entitlements.

## Related

- **ADRs:** ADR-018 (SvelteKit SPA), ADR-024 (opaque bearer tokens for
  cross-origin auth), ADR-025 (multi-instance client architecture), ADR-009
  (durable LiveKit call state).
- **FDRs:** FDR-016 (voice calls), FDR-027 (PWA shell and service worker). A
  feature record for the desktop client itself should be written once it ships.
- **Planning:** phases and implementation checklist are tracked in
  [PR #19](https://github.com/tha23rd/chatto/pull/19).
