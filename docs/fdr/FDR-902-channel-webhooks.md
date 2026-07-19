# FDR-902: Channel Webhooks

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
- Appending `/github` to the webhook URL yields an endpoint that accepts GitHub's
  own webhook payloads directly, so the URL can be pasted into a GitHub
  repository's webhook settings with no intermediate relay. GitHub must be
  configured with the JSON content type; the form-encoded content type is not
  supported. Each supported event is rendered to a short markdown message
  attributed to the GitHub user who caused it.
- The `/github` endpoint renders pushes, issue opens/closes/reopens, issue
  comments, pull request opens/closes/merges/reopens/ready-for-review, pull
  request approvals and change requests, and published releases. Event types and
  actions outside that set — including GitHub's `ping` probe — are accepted and
  acknowledged without posting a message, so GitHub's delivery log does not fill
  with failures for events Chatto has nothing to say about.
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

### 7. Platform payloads are adapted at a URL suffix, not by a relay or a new resource

**Decision:** GitHub support is a `/github` suffix on the existing inbound webhook
URL, sharing the same webhook resource, token, rate limit, and body cap. It decodes
GitHub's payload, renders markdown, and posts through the same
`PostWebhookMessage` seam as a plain post. Unrenderable-but-well-formed deliveries
return `204`; only malformed JSON is a `400`.
**Why:** This is exactly Discord's shape, so existing integration instructions and
muscle memory transfer, and a self-hoster needs no relay service to put GitHub
activity in a channel. Reusing the webhook resource means no new management
surface, permission, or persisted schema. The `204`-for-unhandled rule is what keeps
a webhook subscribed to many event types from showing a wall of failed deliveries.
**Tradeoff:** Chatto now owns a mapping against a third-party payload schema it does
not control, which will need maintenance as GitHub evolves. Each new event type is a
code change rather than configuration.

### 8. Platform events render as markdown text, not embeds

**Decision:** Events render as short markdown messages — a bold summary line and a
linked title or commit list — rather than as structured embeds. Provenance is
carried by the existing per-message override: the message is attributed to the
GitHub actor's login and avatar.
**Why:** Chatto has no embed concept, and message bodies already render a restricted
CommonMark subset, so markdown reaches the same goal with no new rendering surface,
protobuf field, or frontend work. Attributing to the actor reads better than
repeating "by @login" on every line, and reuses override plumbing that already
exists for this purpose.
**Tradeoff:** Two consequences follow from rendering untrusted text as markdown.
First, GitHub text is interpolated into markdown without escaping, because the
renderer deliberately disables backslash escapes to preserve kaomoji — so a value
containing link or emphasis syntax renders as formatting. This is not an injection
into Chatto (raw HTML and images are disabled and link schemes are allowlisted to
http/https), but on a public repository a stranger's issue title can choose both a
link's text and its destination. Judged an acceptable increment over what
subscribing to a public repository's events already grants a stranger; neutralising
markdown syntax in interpolated fields remains available if it proves a problem.
Second, per-field truncation and a commit-list cap are applied before assembly,
because a burst push or a very long comment would otherwise exceed the message body
limit and be rejected as a failed delivery.

### 9. Inbound platform requests are authorized by the URL token alone

**Decision:** GitHub's `X-Hub-Signature-256` is not verified; the secret token in the
URL remains the sole credential, as on the plain inbound endpoint.
**Why:** The URL token is already the credential for this whole feature, and
Discord's equivalent endpoint does not verify GitHub signatures either. Verifying
signatures would require persisting a per-webhook signing secret — a schema addition
to a durable record — for a second credential on a path that already has one.
**Tradeoff:** A leaked URL can be used to post forged GitHub-shaped activity, and
there is no cryptographic proof a delivery originated from GitHub. Adding an
optional per-webhook secret that, when set, requires a valid signature is a clean
additive follow-up.

## Permissions

- `server.manage` — create, edit, delete, and regenerate tokens for channel
  webhooks (the same permission that gates other server-administrative surfaces).

## Related

- **ADRs:** ADR-004 (authorization at the API boundary), ADR-042 (REST endpoints
  for webhooks/callbacks), the per-user message encryption ADR.
- **FDRs:** FDR-001 (Roles & Permissions), FDR-008 (File Attachments), FDR-022
  (User Profile), FDR-023 (Authentication & Sessions), FDR-025 (User Search &
  Member Directory), FDR-900 (Custom Emoji).

## Open Questions

- **Member-list visibility:** should webhook users appear in a room's member list
  (as an "integrations" grouping) or be hidden entirely? First cut hides them.
- **Per-room management delegation:** a future `webhook.manage` at room/group
  scope would let room admins manage their own webhooks without server.manage.
- **Slack-compatible endpoint:** a `/slack` variant of the inbound endpoint would
  ease migration from Slack-shaped integrations. Deferred; the `/github` suffix
  establishes the pattern it would follow.
- **GitHub signature verification:** an optional per-webhook signing secret that,
  when set, requires a valid `X-Hub-Signature-256` (see decision 9). Needs an
  additive field on the persisted webhook record.
- **GitHub event coverage:** the rendered set is deliberately small. `create`,
  `delete`, `fork`, `deployment_status`, and workflow/check runs are plausible next
  additions; each is one formatter plus one test case.
- **Escaping interpolated platform text:** rendering untrusted GitHub text as
  markdown lets it carry formatting and links (see decision 8). If this becomes a
  nuisance or a phishing vector in practice, neutralising markdown-active syntax in
  interpolated fields is the intended fix.
- **Outbound/event webhooks:** posting Chatto events *out* to external URLs is a
  separate feature and out of scope here.
