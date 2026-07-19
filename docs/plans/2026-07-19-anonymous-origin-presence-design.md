# Anonymous-Origin Presence Tracking Design

**Date:** 2026-07-19
**Status:** Approved

## Problem

Chatto starts its presence heartbeat from `AuthenticatedChatProvider.svelte`.
That provider only mounts when the page origin has an authenticated user. A
native Tauri window is served from `tauri.localhost`, while every real Chatto
server is represented as a remote server in the registry. The same topology is
also supported by the web client when its origin remains anonymous and the user
signs in only to a remote server.

In that topology, the remote server can be fully authenticated and its realtime
bus can be active without `initPresenceTracking()` ever running. The server
therefore receives no `MyAccountService.UpdatePresence` heartbeat, its live
presence record expires, and public user reads return Offline. Selecting Online
only updates the local stored preference because the presence tracker's UI
callback was never installed.

## Goals

- Start one presence tracker when the origin is anonymous but one or more remote
  servers can become authenticated.
- Preserve the existing Online, Away, Do Not Disturb, invisible, auto-away,
  heartbeat, and realtime pause/resume behavior.
- Keep presence reporting coordinated across every authenticated server.
- Minimize edits to upstream-owned frontend lifecycle files.
- Make the fix useful and independently upstreamable for the existing
  anonymous-origin remote-server web flow.

## Non-Goals

- Moving presence into the Tauri/Rust host.
- Changing server presence storage, expiry, API, or realtime semantics.
- Refactoring the existing authenticated-origin provider.
- Adding per-server activity detectors or heartbeat timers.

## Decision

Add a headless `AnonymousOriginPresenceProvider.svelte` beside the existing
authenticated providers. `apps/frontend/src/routes/chat/+layout.svelte` mounts
it only when `data.user` is absent, which is exactly when
`AuthenticatedChatProvider.svelte` cannot mount.

The fallback provider calls the existing module-singleton
`initPresenceTracking()` and supplies the same boundaries used by the normal
provider:

- reporters are derived lazily from authenticated server-registry entries;
- accepted/local status changes seed each authenticated current user's
  server-scoped presence-cache entry;
- invisible mode pauses all event buses;
- resuming presence restarts buses for authenticated servers;
- component destruction releases the singleton's document listeners and
  timers.

The established tracker remains the single implementation of idle detection,
visibility handling, mode persistence, API status mapping, reporting cadence,
and accepted-status reconciliation. The fallback duplicates only the small
lifecycle adapter needed to connect that tracker to the registry and cache.

## Upstream-Merge Strategy

Do not edit `AuthenticatedChatProvider.svelte`. The only existing runtime file
changed is the chat layout, with one import and one conditional component mount.
The provider itself and its tests are new files, so ordinary upstream changes
cannot conflict with them mechanically.

Keep the behavior fix in a separate conventional commit from the Tauri work.
Because anonymous-origin remote authentication is already a supported web flow,
the commit can be proposed upstream independently. If accepted, the long-term
fork delta for this behavior becomes zero.

The trade-off is a small amount of duplicated registry/cache/event-bus wiring.
That is preferable in the POC to a broader extraction across active upstream
lifecycle code. The actual presence rules are not duplicated.

## Error Handling

Presence reports remain best-effort, matching current behavior. Authentication
failures continue through the shared Connect client hook. An empty reporter list
is valid while no remote server is authenticated; later mode changes, activity
transitions, and the existing refresh interval resolve reporters lazily.

The fallback never reports Offline. Invisible mode continues to stop reporting
and lets the server-side TTL expire.

## Verification

Extend the existing end-to-end case, “signing in to a remote server works while
the origin is anonymous,” to assert that the current-user presence control
becomes Online. This is the closest automated reproduction of the native
topology and exercises OAuth, registry hydration, the real Connect presence
RPC, server live state, and the rendered presence cache.

Use test-driven development:

1. Add the assertion and confirm it fails on the current branch because the
   current-user presence remains Offline.
2. Add the fallback provider and conditional mount.
3. Confirm the focused remote-only e2e case passes.
4. Run focused presence unit/component tests, the desktop frontend suite, Svelte
   analysis, and a desktop build.
5. Verify the corrected native package against an authenticated server and
   confirm the current-user status remains Online across at least one heartbeat
   interval.
