# FDR-904: Anonymous-Origin Clients

**Status:** Active
**Last reviewed:** 2026-08-03

## Overview

Chatto's web client normally runs on the same origin as the server it talks to,
so the page itself has an authenticated user. The Windows desktop client
(ADR-900) does not: it is served from an anonymous `tauri.localhost` origin and
reaches every real server as a remote registry entry authenticated by a bearer
token. The same topology occurs in a browser whenever someone opens a Chatto
origin they are not signed in to and signs in only to a remote server.

That distinction matters because several client lifecycles were mounted through
the authenticated-origin provider tree. On an anonymous origin those providers
never mount, so behaviour that looks server-side silently stops: the server sees
no presence heartbeat, and notification dismissals never reach the local cache.
This FDR records how the client keeps those lifecycles running when the origin
is anonymous but one or more remote servers are authenticated.

## Behavior

- Presence works identically in both topologies. A member signed in only to a
  remote server appears Online, can select Away, Do Not Disturb, or invisible,
  is auto-awayed on idle, and stops reporting when the client pauses.
- Reading a thread clears its notification indicator immediately, rather than
  only after a reload, regardless of which origin the client is served from.
- Exactly one owner of each lifecycle runs at a time. The authenticated-origin
  and anonymous-origin branches are mutually exclusive, so presence is never
  reported twice and notification events are never consumed twice.
- Presence is coordinated across every authenticated server at once: one
  heartbeat cadence and one idle detector drive reports to all of them, so a
  member signed in to three servers does not appear Online on one and Offline on
  the others.

## Design Decisions

### Mount the fallbacks in the chat layout, not in the shared providers

`routes/chat/+layout.svelte` mounts `AnonymousOriginPresenceProvider` and
`NotificationSync` when `data.user` is absent, which is exactly the condition
under which the authenticated provider tree cannot mount.

The alternative — moving these lifecycles out of the authenticated providers and
mounting them unconditionally — would give a single ownership point but would
edit provider files this distribution shares with upstream, on a path upstream
changes often. Guarding one branch in the layout keeps the divergence to a
handful of lines. See `docs/FORK-MAINTENANCE.md` for why that trade is made
consistently across the fork.

### Reuse the existing tracker rather than reimplementing it

The fallback provider calls the same module-singleton `initPresenceTracking()`
the authenticated provider uses, supplying the same boundaries: reporters
derived from authenticated registry entries, presence-cache seeding for each
authenticated current user, bus pausing for invisible mode, and listener/timer
release on destroy. Idle detection, visibility handling, mode persistence, API
status mapping, and heartbeat cadence therefore have exactly one implementation,
and neither topology can drift from the other.

### No server-side change

Neither behaviour required a backend, protobuf, event subject, read-state, or
notification-persistence change. Pending notifications remain `RUNTIME_STATE`,
thread read markers remain viewer runtime state, and dismissal remains a
transient live signal backed by an authoritative notification-list refetch after
reconnect. The gap was purely in which client code mounted.

## Related

- ADR-900 — Windows desktop client, which introduced the anonymous origin.
- FDR-011 — user presence.
- FDR-012 — notifications.
