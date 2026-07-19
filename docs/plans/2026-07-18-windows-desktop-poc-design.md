# Windows Desktop POC Design

**Date:** 2026-07-18
**Status:** Approved

## Purpose

Chatto will prove that its existing Svelte frontend can be distributed as a
resource-conscious Windows application without creating a second UI codebase.
The desktop client must add capabilities that a browser tab cannot provide
reliably while keeping ordinary frontend changes shared with the web client.

The proof of concept will answer the highest-risk questions before Chatto
commits to a production desktop platform:

- Can the frontend and its LiveKit E2EE media session run correctly in Windows
  WebView2?
- Can a desktop-safe OAuth flow authenticate against self-hosted servers?
- Can ConnectRPC and realtime WebSocket traffic reach default and restricted
  servers without weakening the renderer's browser security boundary?
- Can Windows provide unfocused push-to-talk and screen sharing with system
  audio?
- Does the application have an acceptable resource profile when idle, hidden
  to the tray, in a call, and sharing a screen?

## Scope

The POC is Windows-only. It does not establish a Linux, macOS, or mobile
commitment. Android may be considered separately in the future, but the
desktop bridge is not required to be a mobile abstraction.

The POC includes:

- a Tauri 2 host using Windows WebView2;
- a bundled build of the existing Svelte frontend;
- a frontend-owned, versioned `NativeHost` capability boundary;
- secure top-level navigation and external-link handling;
- native system-browser OAuth with an ephemeral loopback callback;
- native HTTP and WebSocket adapters for explicitly registered server origins;
- global push-to-talk press and release events;
- tray lifecycle and explicit quit behavior;
- display capture validation, including Windows system audio where WebView2
  makes it available;
- LiveKit/WebRTC diagnostics and representative streaming presets;
- automated contract tests plus a documented Windows acceptance matrix and
  resource-measurement procedure.

Production code signing, automatic updates, notification inline reply,
per-application audio capture, picture-in-picture, a custom title bar, and a
native LiveKit implementation are outside the POC. They remain follow-up work
after the platform decision.

## Platform Decision

The POC will try Tauri/WebView2 first. A Windows-only target removes the
cross-platform WebKit concerns that motivated Electron in the original PR
plan, while WebView2 keeps the existing Chromium-oriented Svelte and LiveKit
application model. Tauri also avoids distributing a second Chromium runtime
and provides native plugins for the small set of operating-system integrations
Chatto needs.

Electron remains a fallback, not a parallel implementation. Chatto will only
switch if a critical acceptance requirement fails in WebView2 and a focused
Electron spike demonstrates that bundled Chromium passes the same scenario.
Installer size or team familiarity alone are not sufficient reasons to switch.

## Architecture

The desktop client is a native distribution and integration host, not a native
rewrite of the UI:

```text
apps/frontend (shared Svelte source)
             |
             v
     static desktop build
             |
             v
apps/desktop (Tauri/WebView2)
     |                   |
     v                   v
Windows integrations   registered Chatto/LiveKit endpoints
```

The desktop build may differ from the web build only where the host owns the
lifecycle. In particular, it will disable the PWA service worker and SvelteKit
version polling so that a cached web shell cannot conflict with the packaged
application updater. This is shared source with target-specific build policy,
not a forked frontend.

The renderer must never load a self-hosted server's UI into its privileged
window. Servers provide data and media only. Remote pages, including OAuth
authorization pages, open in the system browser.

## Native Host Boundary

Frontend components and server-scoped stores must not import Tauri modules or
test platform globals directly. A frontend-owned `NativeHost` adapter exposes
capabilities and stable domain operations. The browser adapter reports the
capabilities it can provide; the Tauri adapter delegates to the native host.

The initial contract is capability-oriented and versioned. It covers:

- application identity and lifecycle;
- external URL opening;
- server OAuth;
- native fetch and realtime socket creation;
- global push-to-talk registration and state events;
- tray call-control state and tray action events;
- desktop resource and WebRTC diagnostic export used by the POC.

Callers choose behavior from capabilities rather than checking `win32`,
`__TAURI__`, or an application version. Inputs crossing the boundary are
validated at the narrowest owning layer. The desktop adapter keeps a
reference-counted set of origins from Chatto's local server registry (plus a
temporary lease while adding a server), rejects requests outside that set,
disables HTTP redirects, and verifies the final response origin. A source guard
keeps direct Tauri imports inside the adapter. The native HTTP plugin separately
enforces the outer HTTPS-or-loopback policy.

Tauri's WebSocket plugin does not expose a dynamic native origin scope, and
self-hosted server domains cannot be enumerated in the packaged capability
file. Consequently, the POC's registered-origin check is a trusted-renderer
boundary rather than protection from already-compromised bundled renderer
code. Advancing this architecture to production requires accepting that
residual risk or replacing the plugin transports with Rust-owned commands and
a native allowlist.

## Authentication And Connectivity

The existing web OAuth flow cannot run unchanged because it navigates the app
window to a remote authorization page and uses the page origin as its callback.
The native flow will:

1. discover the server's authorization endpoint;
2. generate PKCE verifier, challenge, and state in the renderer;
3. ask the native host to bind an ephemeral `127.0.0.1` callback port;
4. open the authorization URL in the system browser;
5. validate the returned state and exchange the code;
6. return the opaque bearer credential to the existing server registry;
7. close the callback listener on completion, cancellation, or timeout.

The existing browser flow remains unchanged when the native capability is
absent.

The web build retains browser ConnectRPC fetch and WebSocket behavior. The
desktop build routes absolute registered-server ConnectRPC requests and its
realtime protobuf socket through the native adapters. This is an application
transport seam, not a global response-header rewrite, and it avoids requiring
self-hosters to recognize a packaged application origin. The POC must cover
public discovery, authenticated unary calls, server streaming, and realtime
reconnect behavior, and its resource measurements must include any IPC cost of
the plugin transports.

## Media And Streaming

The POC keeps the LiveKit JavaScript SDK, existing E2EE worker, room state, and
track publishing in the renderer. Screen capture continues through the normal
`getDisplayMedia`/LiveKit path so tracks do not cross IPC.

Chatto will expose a small set of evidence-based streaming presets using the
controls already available in the LiveKit/browser stack: resolution, frame
rate, bitrate, content hint, degradation preference, codec preference when
supported, simulcast, dynacast, and adaptive streaming. Diagnostics will
capture the negotiated outcome rather than assuming the requested settings
were honored: codec, frames, bitrate, frame drops, encode time, quality
limitation reason, packet loss, retransmissions, RTT, and jitter.

For this POC, "share audio" means Windows system/loopback audio offered by the
entire-screen capture path. It does not promise arbitrary per-process or
selected-window audio. Native LiveKit or Windows audio capture requires a
separate ADR and evidence that WebView2 is the bottleneck.

## Lifecycle

Closing the main window hides the application to the tray. An explicit Quit
action terminates the process and leaves the call cleanly. Autostart is off by
default and is not required for the initial POC UI. Native notifications are
only expected while the desktop process is running; notification delivery
after explicit exit remains web-push/background-process follow-up work.

## Security

The bundled renderer receives a strict production content-security policy.
The host blocks top-level navigation away from bundled content, opens approved
HTTPS links in the system browser, denies unrequested window creation, limits
Tauri capabilities to the main window, validates command and event payloads,
and keeps file-system and shell access unavailable to the renderer.

Plain HTTP self-hosted servers are permitted only for loopback during the POC.
Non-loopback servers must use HTTPS/WSS. OAuth callback listeners bind only to
loopback, use a random port, validate state, and have a short timeout. Tokens,
authorization codes, full URLs with queries, and other PII must not be logged.

## Verification And Decision Gate

Automated checks will cover the frontend adapter, native command validation,
OAuth callback state machine, registered-origin policy, realtime framing
adapter, build targeting, and CSP/configuration. The Windows acceptance run
will record:

- secure launch of the bundled UI;
- OAuth login through the system browser and loopback callback;
- default-CORS and restricted-origin server connectivity;
- LiveKit E2EE voice;
- 720p and 1080p screen sharing at representative frame rates;
- entire-screen system audio;
- global push-to-talk while Chatto is unfocused;
- tray hide, restore, mute/deafen actions, and explicit quit;
- cold-start, idle, tray, call, and screen-share CPU/GPU/memory measurements;
- a clean Windows package installation and launch.

Tauri is accepted only if authentication, authenticated/realtime transports,
E2EE voice, global push-to-talk, and required system-audio capture all pass. A
failure must include a reproducible result before an Electron comparison is
started. The ADR remains Proposed until this evidence is recorded.
