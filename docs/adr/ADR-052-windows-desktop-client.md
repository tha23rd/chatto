# ADR-052: Windows Desktop Client Reuses the Web Frontend

**Date:** 2026-07-18
**Status:** Proposed

## Context

Chatto's installable PWA already provides the complete client UI and owns the
LiveKit room, E2EE worker, media tracks, multi-server registry, and realtime
state. A desktop application must therefore earn its maintenance and runtime
cost through capabilities that a browser tab cannot provide reliably:

- global push-to-talk while Chatto is unfocused;
- tray lifecycle and call controls;
- desktop-safe authentication against arbitrary self-hosted servers;
- authenticated HTTP and realtime WebSocket connectivity when a server's
  browser origin policy does not recognize the packaged application origin;
- Windows display capture with system audio; and
- observable resource and WebRTC behavior for streaming optimization.

Maintaining a native Windows UI in parallel with the Svelte client would
duplicate product work and make upstream frontend changes expensive to
integrate. Loading a self-hosted server's remote UI into a privileged desktop
window would avoid that duplication but would make server-controlled code part
of the native trust boundary.

The original desktop proposal selected Electron largely for consistent media
behavior across Linux WebKitGTK, macOS WebKit, and Windows. The proof of concept
is now explicitly Windows-only. Tauri uses Microsoft's Chromium-based WebView2
on Windows and does not distribute a second Chromium runtime, so the
cross-platform WebKit argument does not apply to this decision.

The existing browser OAuth flow also cannot be reused unchanged. It navigates
the current window to a remote authorization page and derives its callback from
`window.location.origin`. Chatto's server accepts HTTP loopback redirects for
installed clients, but the packaged application origin is neither a normal
HTTPS client origin nor an acceptable place to load remote UI.

Finally, browser response-header rewriting is not a complete connectivity
solution. It may make a rejected CORS response readable, but it cannot repair a
realtime WebSocket upgrade that the server rejected after checking `Origin`.

## Decision

### Build a Windows-only Tauri/WebView2 proof of concept

Create `apps/desktop` as a Tauri 2 application targeting Windows WebView2. The
POC packages the existing static SvelteKit build and treats self-hosted Chatto
servers as data and media endpoints only. It never loads a server's frontend
code into the privileged application window.

Tauri is not accepted merely because the executable or installer is small. The
POC must pass the authentication, transport, E2EE voice, global push-to-talk,
system-audio capture, lifecycle, security, and resource checks defined in the
Windows acceptance matrix. This ADR remains Proposed until that evidence is
recorded.

Electron is a fallback, not a second implementation. Chatto will run an
Electron comparison only when WebView2 fails a required media behavior and a
focused Electron spike can demonstrate that bundled Chromium passes the same
reproduction. Familiarity or package size alone does not decide the fallback.

Linux and macOS packaging are out of scope. This boundary does not promise that
the host interface can be reused for a future Android application.

### Share frontend source through one capability-oriented host boundary

The Svelte frontend remains the source of truth for UI and product behavior.
Frontend components and server-scoped stores use a frontend-owned, versioned
`NativeHost` interface; they do not import Tauri packages or scatter platform
checks. A browser implementation reports native capabilities as unavailable,
while the Tauri implementation supplies the approved operations.

Callers select behavior from capabilities rather than platform names or host
versions. The POC boundary covers native OAuth, HTTP fetch, realtime sockets,
global push-to-talk, tray call controls, external URL opening, and lifecycle
events. Inputs and events are validated on both sides.

Shared source does not require byte-identical builds. The desktop target
disables the PWA service worker and SvelteKit version polling because packaged
application updates own the shell lifecycle. The normal web build retains both
features.

### Keep renderer authority narrow

The production desktop window loads only bundled assets, receives a strict
content-security policy, blocks top-level remote navigation and unrequested
window creation, and opens approved HTTPS links in the system browser. Tauri
capabilities apply only to the main window and grant no generic filesystem or
shell access.

Native networking accepts HTTPS/WSS destinations and plaintext HTTP/WS only on
loopback for development. Plugin scopes enforce the same outer boundary, and
the frontend transport policy validates each requested server endpoint. Tokens,
authorization codes, URLs containing queries, and user identifiers are not
logged by the native host.

### Use system-browser OAuth with PKCE and an ephemeral loopback callback

For the desktop build, the native host binds `127.0.0.1` on an operating-system
selected port, constructs the redirect URI, opens the server authorization
endpoint in the system browser, accepts one bounded callback with a short
timeout, validates OAuth state, and exchanges the authorization code with the
PKCE verifier. It returns the opaque access token and public user summary to the
existing multi-server registry.

The browser build keeps the current same-origin callback route. Registry update
logic is shared so native and web completion cannot drift.

### Adapt transports instead of rewriting response headers

Browser fetch and WebSocket remain the default for the web client. The desktop
adapter uses Tauri's Rust-backed HTTP client for allowed absolute Chatto
endpoints and supplies it through ConnectRPC's custom Fetch seam. It uses the
Tauri WebSocket plugin for the realtime protobuf connection so a browser
`Origin` header does not cause a server-side upgrade rejection.

The public ConnectRPC and realtime protocols do not change. The POC validates
public discovery, authenticated unary requests, server streaming, realtime
handshake/subscription, and reconnect behavior. It does not add a
desktop-specific server API.

### Keep LiveKit and E2EE in the renderer

The LiveKit JavaScript SDK, room, participant state, E2EE worker, and track
publishing remain in the renderer. Screen sharing continues through
`getDisplayMedia` and LiveKit; media tracks do not cross Tauri IPC.

The client retains its existing resolution, frame-rate, bitrate, content-hint,
degradation-preference, simulcast, dynacast, and adaptive-stream controls. The
POC adds bounded, non-PII WebRTC diagnostics so requested settings can be
compared with negotiated codec, bitrate, frames, encoder limits, packet loss,
retransmissions, RTT, and jitter.

For this POC, screen-share audio means Windows system/loopback audio offered by
the entire-screen capture path. It does not promise arbitrary selected-process
or selected-window audio. Native LiveKit or Windows audio capture requires a
separate ADR supported by measurements showing that the WebView2 media path is
the bottleneck.

### Use tray-resident lifecycle for the POC

Closing the main window hides it to the tray. Show restores and focuses the
window, and a second process focuses the existing instance. Explicit Quit
terminates the process; LiveKit disconnect-on-page-leave remains the final
media cleanup guard.

The tray exposes mute/deafen toggles while the renderer has an active call.
The native global-shortcut plugin supplies both pressed and released events for
momentary push-to-talk while Chatto is unfocused. The initial POC accelerator is
documented rather than exposed as a new settings surface.

Notifications after explicit process exit, launch-on-startup, deep links,
automatic updates, production signing, inline notification replies,
picture-in-picture, and a custom title bar are follow-up work.

## Consequences

Most upstream client changes continue to land once in the Svelte frontend. The
desktop maintenance surface is limited to a build target, one adapter, and the
Windows host. Desktop-only behavior is testable behind a typed seam instead of
being spread throughout components.

Tauri should reduce distribution overhead compared with Electron, but it does
not turn the Svelte/LiveKit application into a native-rendered UI. WebView2 is
Chromium-based, so active-call and screen-share CPU, GPU, and memory may be
similar to a browser tab. A tray-resident application also has a persistent
idle cost that a closed web tab does not. Resource-efficiency claims require
measurements of cold start, idle, tray, voice, and screen-share states.

The desktop application adds a Rust toolchain, Windows packaging, Tauri plugin
updates, a native security boundary, and platform-specific tests. OAuth and
realtime transport behavior become more complex than the web-only path, though
their public server protocols remain unchanged.

WebView2 updates with Windows rather than with Chatto. This reduces bundle size
but means the exact embedded Chromium build is not pinned by an application
release. The acceptance matrix must record the Windows and WebView2 versions
used for media results.

If a native media stack is later justified, it will likely own the complete
LiveKit session rather than accepting renderer-owned tracks over IPC. That is a
large subsystem and is deliberately not hidden inside this POC.
