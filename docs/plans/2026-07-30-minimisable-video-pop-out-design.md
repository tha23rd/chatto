# Minimisable Video Pop-Out Design

## Problem

Chatto currently opens an individual call feed with the browser's element-level
Picture-in-Picture API. That surface works in the Windows WebView2 client, but
it is browser-managed: it has no normal taskbar minimise lifecycle. It can also
outlive the call because voice-call cleanup does not explicitly close an active
pop-out.

The desired desktop behaviour follows Discord's window model for the selected
feed: a separate movable and resizable window with normal Windows minimise,
maximise/restore, and close controls. Leaving or otherwise disconnecting from
the owning call must close it. The web client should retain its existing
Picture-in-Picture behaviour.

## Decision

The Windows client will create one managed Tauri `WebviewWindow` in response to
a narrowly identified, same-origin `window.open` request made directly from the
feed action's click handler. Tauri will apply the request's window features and
reuse the opener's WebView2 environment. The window will load only a minimal
trusted document and display the selected video stream; it will not load a
second Chatto application, request another call token, or establish another
LiveKit connection.

The native host contract will advertise managed video-pop-out support. The
frontend pop-out service will select that path only when the capability is
present and will otherwise use the existing element-level Picture-in-Picture
implementation. Only one feed may be popped out per application at a time.
Opening another feed replaces the previous pop-out, and invoking the action for
the active feed closes it.

The Tauri shell will continue denying arbitrary new windows. It will create the
managed window only for the exact internal pop-out sentinel and will preserve
the main window's existing external-HTTPS opener behaviour for every other
request. The pop-out will reject navigation away from trusted packaged or local
development content.

## Media And Window Lifecycle

The popup will reuse the selected `<video>` element's existing `MediaStream`
inside the opener-linked WebView2 environment. The popup video remains muted;
call audio continues through the main LiveKit attachment path. Closing the
window removes only the additional presentation surface and does not leave the
call.

The frontend service will associate the active pop-out with the owning
server-scoped voice-call store. Every teardown path that reaches that store's
central cleanup routine—including explicit hang-up, the current-user-bar leave
action, backend-authored call end or participant removal, access revocation,
connection failure, and replacement by another call—will ask the service to
close only that store's pop-out. This ownership check prevents cleanup in one
server store from closing a pop-out owned by another active call.

If the selected video track ends or the popup is closed independently, the
service will release its popup and event-listener references. Browser
Picture-in-Picture cleanup will similarly call `exitPictureInPicture()` on
teardown when the owning feed is active. Cleanup is best-effort and must never
make leaving a call fail.

## Performance

The managed window shares the existing WebView2 environment and uses a minimal
document, but it still adds a WebView2 controller and may add a renderer. The
temporary incremental footprint is accepted up to approximately 100 MiB while
the pop-out is open. Closing the window must destroy the managed WebView and
return the process tree close to its pre-pop-out baseline.

Windows acceptance evidence will compare a settled call before opening the
pop-out, with the pop-out visible, with it minimised, and after it closes.
Measurements will use total Chatto host-plus-descendant private working set,
private bytes, working set, CPU, GPU where available, and process count. The
existing Picture-in-Picture path remains the lower-overhead web fallback.

## Testing And Documentation

Unit tests will cover native capability selection, one-window replacement,
same-feed toggling, rejected popup creation, independent window closure, ended
tracks, owner-scoped teardown, and browser Picture-in-Picture fallback.
Voice-call-store tests will prove that explicit and server-driven cleanup close
the owning pop-out without allowing a close failure to block call teardown.

Rust tests will cover strict classification of the internal new-window
sentinel and continued denial or external handling of all other URLs. Frontend
component coverage will exercise the feed action through the native-capability
path. The Svelte autofixer, targeted frontend and Rust suites, a browser check
of the web fallback, and a native Windows build and smoke test will be run.

FDR-016 will be updated to distinguish the managed Windows pop-out from the web
Picture-in-Picture fallback and to state the teardown guarantee.
ADR-900 will record the additional native window lifecycle and its measured
resource consequence. The desktop acceptance matrix will gain visible,
minimised, closed, and leave-call pop-out checks.
