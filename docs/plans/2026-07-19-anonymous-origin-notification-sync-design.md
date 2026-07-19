# Anonymous-Origin Notification Sync Design

**Date:** 2026-07-19
**Status:** Approved

## Problem

Chatto clears thread read cursors and their covered pending notifications on the
server when `ThreadService.MarkThreadAsRead` succeeds. The server publishes a
transient `NotificationDismissed` realtime event for each cleared notification.
`NotificationSync` consumes those events and removes the corresponding items
from the per-server `NotificationStore`, which drives the orange thread and
My Threads indicators.

The bundled web topology mounts `NotificationSync` through
`AuthenticatedRoot` because the page origin itself has an authenticated user.
The Windows client uses an anonymous `tauri.localhost` origin and authenticates
remote servers with bearer tokens, so `AuthenticatedRoot` does not mount. The
read mutation succeeds, but its dismissal events never update the desktop
client's notification cache.

## Options Considered

### 1. Mount notification sync in the anonymous-origin branch

Mount the existing `NotificationSync` component beside
`AnonymousOriginPresenceProvider` when `data.user` is absent.

- Keeps the upstream-owned `AuthenticatedRoot` and
  `AuthenticatedChatProvider` unchanged.
- Guarantees exactly one notification-sync owner in either topology.
- Reuses the existing multi-server event-bus consumer and reconnect behavior.
- Adds only one import and one component mount to the chat layout.

### 2. Move notification sync out of `AuthenticatedRoot` globally

Mount `NotificationSync` unconditionally in the chat layout and remove its
existing mount from `AuthenticatedRoot`.

- Produces a conceptually central ownership location.
- Modifies an upstream-owned provider and increases merge-conflict surface.
- Changes the established web composition even though it already works.

### 3. Introduce a generalized remote-session root

Create a new wrapper that owns presence, notification sync, auth notices, and
future remote-session behavior.

- Could centralize additional remote-only lifecycle responsibilities later.
- Is unnecessary for this bug and creates a broader abstraction before its
  boundaries are known.

## Decision

Use option 1. The anonymous-origin branch will mount `NotificationSync` next to
the existing presence fallback. The authenticated web branch will continue to
mount it through `AuthenticatedRoot`. The branches are mutually exclusive, so
the component is never duplicated.

No backend, protobuf, event subject, read-state, or notification persistence
behavior changes. Pending notifications remain `RUNTIME_STATE`; thread read
markers remain viewer runtime state; dismissal remains a transient live sync
signal backed by an authoritative notification-list refetch after reconnect.

## Data Flow

1. The user opens a thread with a pending reply notification.
2. `ThreadPane` calls `ThreadService.MarkThreadAsRead`.
3. The server advances the thread read cursor, deletes covered notification
   records, and publishes `NotificationDismissed` events.
4. The anonymous-origin `NotificationSync` receives each event from the remote
   server's existing event bus.
5. `NotificationStore.removeNotification` removes the cached notification.
6. Derived thread and My Threads indicators disappear immediately.

## Error And Recovery Behavior

This change preserves existing behavior. If the live dismissal is missed,
`NotificationSync` and the per-server stores reconcile through their existing
fetch paths after reconnect. A read mutation failure still leaves the indicator
present and is logged by `ThreadPane`; the client does not falsely mark a failed
read as successful.

## Testing

- Add a browser component regression test for the chat layout proving that an
  anonymous origin mounts notification sync.
- Prove the test fails before the implementation because the sync marker is
  absent.
- Add an authenticated-origin assertion proving that composition still has one
  notification-sync owner rather than two.
- Run the focused component tests, Svelte autofixer, Svelte checks, and the
  anonymous-origin remote-server e2e coverage.
- Build and verify a fresh Windows NSIS installer from the final commit.

## Compatibility And Merge Surface

The change is frontend-only and additive in the desktop/anonymous-origin branch.
It introduces no API or persisted-state compatibility concern. Existing web
provider files remain untouched, limiting likely upstream merge conflicts to
the small chat-layout branch already added by the Windows POC.
