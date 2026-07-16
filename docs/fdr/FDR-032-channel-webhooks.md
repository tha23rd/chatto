# FDR-032: Channel Webhooks

**Status:** Active
**Last reviewed:** 2026-07-16

## Overview

Channel webhooks let an external service post messages into a room by sending an
HTTP `POST` to a secret, per-webhook URL — no user account or session required.
Each webhook has a stable identity (name + avatar) that authored messages are
attributed to, mirroring Discord's incoming webhooks. Webhooks are created and
managed by server administrators; the URL embeds a secret token that is shown once
at creation and never again. This gives self-hosters a simple, standards-shaped
integration point for CI pipelines, alerting, RSS bridges, and similar tools
without building a full bot.

## Behavior

- A server administrator creates a webhook against a specific room, giving it a
  name and (optionally) an avatar. On creation the full webhook URL — containing
  the webhook id and a one-time secret token — is displayed for copying. The raw
  token is never shown again.
- Administrators can list, rename, re-avatar, delete, and regenerate the token of
  existing webhooks. Regenerating a token immediately invalidates the previous
  URL.
- An external client posts a message by sending `POST` to the webhook URL with a
  JSON body containing message `content`, and optionally `username` and
  `avatar_url` overrides and file `attachments`.
- Posted messages appear in the target room's timeline like any other message,
  attributed to the webhook's identity. They are delivered live to connected
  clients, generate notifications, can be replied to and reacted to, and are
  encrypted at rest like human-authored messages.
- When a `POST` supplies a `username` and/or `avatar_url`, that message is
  displayed with the override identity instead of the webhook's default name and
  avatar. Absent overrides, the webhook's own name and avatar are used.
- Messages authored by a webhook are visually marked as coming from an automated
  integration rather than a human member.
- Webhook identities never appear in the human member directory, are never
  suggested for mention autocomplete as accounts to converse with, never show
  presence, and can never log in or hold a session.
- Requests to a revoked, deleted, or malformed webhook URL are rejected. The
  inbound endpoint is rate limited per webhook.

## Design Decisions

### 1. Each webhook is backed by a synthetic, non-human user

**Decision:** A webhook owns a real `User` record with a new user *kind* of
`WEBHOOK` (versus `HUMAN`). Webhook-authored messages are authored by that user
id, so they flow through the existing message, timeline, projection, live-delivery,
notification, and encryption paths unchanged.
**Why:** Messages are authored by a user id end to end; the read/render pipeline
hydrates authors as users. Reusing a real user for the webhook avoids introducing
a parallel "non-user author" concept across every consumer of a message author.
**Tradeoff:** Webhook users are real member records, so every human-only surface
(member directory, login/auth, presence, mention autocomplete) must explicitly
exclude the `WEBHOOK` kind. The kind is enforced at a small number of choke points
rather than being structurally impossible.

### 2. Per-message name/avatar overrides are additive message fields

**Decision:** The Discord-style per-`POST` `username`/`avatar_url` override is
carried as new optional display-override fields on the message body, applied at
render time. The webhook's synthetic user supplies the default identity; overrides
win when present.
**Why:** A single synthetic user cannot represent a different name/avatar per
message, and overrides are a core webhook use case (one webhook, many logical
senders). Additive message fields preserve the synthetic-user model while
supporting overrides.
**Tradeoff:** Timeline rendering gains a branch (override vs. author identity), and
the override display data is denormalized onto the message.

### 3. Only the token hash is persisted; the raw token is shown once

**Decision:** The secret token is generated at create/regenerate time, returned to
the caller exactly once, and only an HMAC of it is stored. Inbound requests are
authorized by re-hashing the presented token and matching.
**Why:** Consistent with how Chatto handles every other bearer credential; a
database or backup leak never exposes usable tokens.
**Tradeoff:** A lost token cannot be recovered, only regenerated.

### 4. The webhook resource is a durable runtime-state record

**Decision:** Each webhook is stored as a latest-value record in `RUNTIME_STATE`,
keyed by webhook ID, holding only the HMAC of its secret token alongside its
name, target room, creator, and backing user. Its name and avatar are mirrored
onto the backing user, which is itself an event-sourced durable fact.
**Why:** A webhook is fundamentally a named credential with metadata — the same
class of durable latest-value record as sessions and tokens, which `RUNTIME_STATE`
exists for. It survives restarts and is included in backups without adding a new
event-sourced aggregate. Because the inbound URL carries the webhook ID,
validation is a direct lookup plus a constant-time hash compare, so no separate
token-hash index is needed.
**Tradeoff:** No append-only audit history of webhook edits, unlike an EVT
aggregate.

### 5. Management is server-administrative; possession of the token is the post authorization

**Decision:** Creating and managing webhooks is gated by the existing
`server.manage` permission, surfaced in the server-admin area alongside custom
emoji and roles. The inbound post endpoint performs no per-user permission
check — holding a valid token is sufficient to post to that webhook's room.
**Why:** Webhook creation grants standing post access to a room and should be an
administrative act. Reusing `server.manage` (held by owner and admin roles)
matches the custom-emoji management surface and needs no new default-role seeding.
Once a webhook exists, its whole purpose is unauthenticated posting, so the token
*is* the credential.
**Tradeoff:** Webhook management is coarser than Discord's per-channel model; any
server admin can manage any room's webhooks. A dedicated, room-scoped
`webhook.manage` permission is left to a future iteration.

### 6. Attachments post through a token-authorized upload path

**Decision:** Posting files through a webhook reuses the existing asset-upload and
attachment machinery, but via a path authorized by the webhook token rather than a
user session, stamping the webhook's user id as the uploading actor.
**Why:** Reuses the established asset storage, processing, and encryption pipeline
instead of a second upload path.
**Tradeoff:** The upload surface must be carefully validated and rate/size limited
because it is reachable without a user session.

## Permissions

- `server.manage` — create, edit, delete, and regenerate tokens for channel
  webhooks (the same permission that gates other server-administrative surfaces).

## Related

- **ADRs:** ADR-004 (authorization at the API boundary), ADR-042 (REST endpoints
  for webhooks/callbacks), the per-user message encryption ADR.
- **FDRs:** FDR-001 (Roles & Permissions), FDR-008 (File Attachments), FDR-022
  (User Profile), FDR-023 (Authentication & Sessions), FDR-025 (User Search &
  Member Directory), FDR-030 (Custom Emoji).

## Open Questions

- **Member-list visibility:** should webhook users appear in a room's member list
  (as an "integrations" grouping) or be hidden entirely? First cut hides them.
- **Per-room management delegation:** a future `webhook.manage` at room/group
  scope would let room admins manage their own webhooks without server.manage.
- **Slack-compatible endpoint:** a `/slack` variant of the inbound endpoint would
  ease migration from Slack-shaped integrations. Deferred.
- **Outbound/event webhooks:** posting Chatto events *out* to external URLs is a
  separate feature and out of scope here.
