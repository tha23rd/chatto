# Native Window Application Audio Design

**Date:** 2026-08-03
**Status:** Approved

## Purpose

When a Windows desktop presenter selects a game or other application window,
Chatto should share that application's picture and audio without transmitting
unrelated sounds from the rest of the computer. Entire-display sharing should
continue to offer Windows system audio.

## Root Cause

The existing Tauri adapter asks WebView2 for `windowAudio: "system"`. That
request deliberately pairs a selected window's picture with all Windows audio
outputs, and WebView2 accurately exposes an **Also share all audio outputs**
picker toggle. The earlier change therefore implemented system-wide loopback
audio for a window-shaped video capture, not application-scoped audio.

The renderer also treats a video-only `getDisplayMedia()` result as a complete
success when audio was requested. That behavior is technically valid because
display-capture audio is optional, but it gives the presenter no indication
that the stream has no sound.

## Product Contract

- Selecting a window with **Share audio** enabled requests audio from the
  application that owns the selected window.
- On Windows, Chromium implements that request with process-loopback capture
  for the selected application's process tree.
- Selecting an entire display with **Share audio** enabled continues to request
  Windows system audio.
- Chatto never silently broadens selected-window capture from application audio
  to all system output.
- If WebView2 returns window video without an audio track, Chatto keeps the
  video share active and warns the presenter that it is being shared without
  sound.
- The native picker remains the permission boundary. Chatto can request an
  audio scope but cannot force the user to enable the picker control.

## Capture Path

The frontend-owned `NativeHost` boundary remains the only desktop-specific
capture seam. Its Tauri implementation will translate an audio-enabled capture
to `windowAudio: "window"` and retain the existing `systemAudio: "include"`
hint. WebView2 applies the window preference when the presenter selects a
window and the system preference when they select an entire display.

The renderer will continue publishing the returned raw video and optional audio
tracks through LiveKit's normal publication path. This preserves E2EE, sender
settings, reconnect behavior, unpublishing, music-oriented audio constraints,
and the existing independent stream-volume control.

The native capability will be renamed from `windowSystemAudio` to
`windowApplicationAudio`, and the native host API version will advance because
the capability contract changes.

## Missing-Audio Experience

The absence of an audio track is not a screen-share failure: the selected video
may still be useful. Chatto will publish that video, mark screen sharing active,
and show a warning:

> Application audio was not shared. The window is still being shared without
> sound.

The warning will use the existing toast surface and every complete translation
catalogue. It will not claim whether the user disabled the picker control, the
selected application had no active audio, or WebView2 lacked support, because
the returned stream does not distinguish those cases.

## Documentation

FDR-016 will describe application-scoped Windows window capture and preserve
system audio for entire-display capture. ADR-900 will record that the shared
renderer/WebView2 path now uses Chromium's application-loopback capability
instead of treating native process audio as a future subsystem. The runtime
component inventory, public calls guide, and Windows acceptance matrix will be
updated to the same contract.

The selected-window acceptance case must verify both sides of the privacy
boundary: the remote participant hears the selected application's audio, while
unrelated system output and Chatto call playback are not transmitted. The
actual Windows and WebView2 versions remain part of the evidence.

## Verification

Automated coverage will verify:

- the Tauri host advertises application-window audio and requests
  `windowAudio: "window"`;
- the browser host does not advertise the native capability;
- the native host API version advances with the capability rename;
- a returned application-audio track is published as screen-share audio;
- a missing audio track leaves video sharing active and produces the localized
  warning;
- translated catalogues compile and expose the warning message; and
- the relevant Svelte, TypeScript, formatting, documentation, and repository
  policy checks pass.

Native Windows acceptance remains necessary because mocked media streams cannot
prove WebView2's picker label, process-loopback behavior, or remote audio. The
acceptance result stays `UNRUN` until a human exercises a packaged Windows
build.

## Alternatives Considered

### Keep all-system audio as an additional mode

This would preserve the existing behavior as a second user choice, but it adds
UI and creates an easy path to broadcasting unrelated notifications, music, or
calls. It is not needed for the approved application-sharing behavior.

### Fall back automatically to system audio

This could produce sound on a runtime without application-loopback support, but
it would silently cross the selected-window privacy boundary. Chatto will
prefer an explicit no-audio warning over broader capture.

### Add native WASAPI capture or move to Electron

Both approaches can provide more host control, but they add a much larger media
ownership surface. Current Chromium enables Windows application audio capture
for `getDisplayMedia()` window selection, so native or Electron capture should
only be reconsidered after reproducible WebView2 acceptance failure.
