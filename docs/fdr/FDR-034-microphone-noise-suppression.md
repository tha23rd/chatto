# FDR-034: Microphone Noise Suppression

**Status:** Experimental
**Last reviewed:** 2026-07-14

## Overview

A per-client microphone noise-suppression preference for voice calls, layered
on top of the browser's baseline WebRTC processing. A member in (or about to
join) a call picks one of three modes from the in-call audio device menu; the
choice is remembered on that device and applied to their own outbound audio. It
is a fork feature that trades some CPU and image size for cleaner sent audio,
and it is off by default so nobody's capture changes unless they opt in.

## Behavior

- The audio device menu (microphone/speaker/camera selector) always shows a
  "Noise suppression" section with three options: Standard (browser), Voice
  isolation (experimental), and Enhanced (DeepFilterNet3).
- The setting is per client and persists in `localStorage` across calls and
  reloads. It is not tied to the account and does not sync across devices.
- The default is Standard: the browser's own AGC, echo cancellation, and noise
  suppression, with no extra sender-side processing.
- Voice isolation requests a stronger, browser-implemented suppression tier. It
  is honoured only by browsers that implement the constraint (effectively
  Safari today) and is silently ignored elsewhere.
- Enhanced runs DeepFilterNet3, a model-based suppressor, on the outbound
  microphone track. The first time it is selected in a session the model and
  its runtime are loaded on demand, so there is a brief loading state before it
  becomes active.
- The section reflects real state for the selected mode: a loading line while
  the enhanced model is being fetched/started, and an "Unavailable in this
  browser" line when the chosen mode cannot be applied (for example, enhanced
  on an unsupported browser). Selecting a mode keeps the menu open so this
  feedback is visible.
- On any failure to apply a mode, capture falls back to the browser's baseline
  processing rather than dropping the microphone; the menu reports the mode as
  unavailable instead of showing a healthy state over degraded or dead audio.
- Switching the input microphone device preserves the selected mode.
- The setting only affects the local member's sent audio. It is not visible to
  other participants and creates no durable call facts.

## Design Decisions

### 1. Off by default; the mode is the single source of truth for voice isolation

**Decision:** The preference defaults to Standard (off), and the selected mode
alone decides the `voiceIsolation` capture constraint — the default explicitly
requests it disabled.

**Why:** Sender-side suppression varies in quality and cost across
browsers/devices and should be an opt-in, not a silent default change. Making
the mode authoritative keeps behaviour predictable: what the user picked is what
capture does.

**Tradeoff:** livekit-client's own audio defaults request `voiceIsolation:
true`, which every shipped build previously inherited. Because the default mode
now sends `voiceIsolation: false` explicitly, a Safari user who never opens the
menu loses the voice isolation they used to get and must select Voice isolation
to restore it. Browsers that ignore the constraint (Chrome/Firefox) are
unaffected.

### 2. The setting is exposed in all builds, not behind a build flag

**Decision:** The feature is compiled into and enabled in every frontend build.
There is no build-time flag gating whether the menu section appears or the
controller acts.

**Why:** The feature originally shipped dark, behind a `VITE_ENABLE_NOISE_SUPPRESSION`
build flag that no released image set. In every normal build the menu was hidden
and the controller inert, so real users never got the setting and it could not
be exercised on live calls. Exposing it unconditionally lets people actually use
and evaluate it, while off-by-default keeps the change conservative.

**Tradeoff:** The DeepFilterNet3 model and WASM runtime (~24 MB on disk, ~12 MB
compressed) now ship in every built frontend rather than only flag-on builds.
They are still lazy-loaded at runtime only when Enhanced is selected, so the
default experience pays no download cost; the cost is image size and static
hosting. Checksum-validated files already present are skipped on rebuild.

### 3. Enhanced assets are served same-origin from a fixed, checksum-pinned path

**Decision:** The DeepFilterNet3 assets are fetched at build time with pinned
SHA-256 checksums into a single fixed same-origin path (`/models/deepfilternet3`).
The path is a constant, not configuration, and a checksum mismatch fails the
build. The package's vendor CDN fallback is never used.

**Why:** A configurable asset URL invited protocol-relative, backslash, and
query/fragment values that resolve cross-origin or to a different fetch target
than the browser requests; a fixed constant removes all URL-parsing risk by
construction. Same-origin serving keeps users' browsers off third-party hosts
(the vendor CDN also does not send CORS headers to third-party origins), and
pinned checksums stop a changed upstream artifact from silently entering an
image.

**Tradeoff:** Updating the model means updating the pinned checksums in the
fetch script. The assets are deliberately not committed to git.

### 4. Applies are serialized with best-effort baseline fallback

**Decision:** The controller owns the preference, an `off`/`loading`/`active`/
`unavailable` status, and a serialized apply chain, so overlapping mode/device
changes converge instead of interleaving. Detaching a processor stops the
processed track before awaits that can reject and, on failure, restarts raw
capture and only reports success if that recovers.

**Why:** LiveKit takes its track mutex separately per processor
attach/detach, so concurrent applies could interleave and leave capture in an
inconsistent state. Users care most that their microphone keeps working; the UI
must never claim a clean baseline over degraded or dead audio.

**Tradeoff:** Extra controller complexity (a queue, health checks, and explicit
`unavailable` reporting) relative to a naive "just call setProcessor" approach.

## Permissions

Not permission-gated. It is a per-client capture preference, available to any
member who can join a call (voice calling itself is gated by room membership —
see FDR-016).

## Related

- **FDRs:** FDR-016 (Voice Calls)
- **ADRs:** none directly; media routing/authorization context is in ADR-009
  (Durable LiveKit Call State).

## Open Questions

- The DeepFilterNet3 worklet loads from blob URLs, which violates the intended
  `worker-src 'self'` CSP (report-only today). This should be resolved before
  the feature is considered stable / promoted from experimental.
- Real in-call verification is still outstanding: two participants with E2EE, a
  browser matrix (voice isolation is effectively Safari-only), a listening pass,
  and a low-power/mobile CPU run for the enhanced mode.
- Whether to change the default now that the setting is exposed — for example,
  defaulting Safari back to voice isolation — is deliberately left open pending
  the in-call evaluation above.
