# FDR-030: Custom Emoji

**Status:** Active
**Last reviewed:** 2026-07-12

## Overview

Server administrators can build a server-wide catalog of named custom emoji —
image shortcodes such as `:partyparrot:` — that every member can use. In this
first version, custom emoji are usable as message **reactions**: a member picks
one from the emoji picker and it renders as a small inline image on the reaction
pill. The catalog is shared by the whole server; there are no per-user or
per-room emoji sets.

## Behavior

- Admins upload custom emoji from a dedicated admin page. Each emoji has a name
  (its shortcode) and an image.
- Uploaded images are processed into small WebP images sized for inline display,
  so a large source image still renders as a compact emoji. Animated GIF uploads
  are preserved as animated WebP so the emoji keeps its motion; other formats
  render as a single static frame.
- Names are lowercase and limited to letters, digits, and underscores
  (`^[a-z0-9_]{1,64}$`). A name that collides with a built-in gemoji shortcode
  (for example `:smile:`) is rejected so the two namespaces never overlap.
- Admins can delete a custom emoji. Existing reactions that used it stop
  rendering as that image once it is gone.
- Any authenticated member sees the current custom emoji catalog in the emoji
  picker alongside built-in emoji and can react to a message with one.
- Reaction pills backed by a custom emoji render the emoji image; pills backed
  by a built-in emoji render the glyph as before. Counts, viewer highlight, and
  reactor tooltips behave the same as ordinary reactions.
- Custom emoji do **not** substitute inside message text. Typing `:partyparrot:`
  in a message body posts the literal text; only reactions render custom emoji
  images in this version.

## Design Decisions

### 1. Reaction names carry custom emoji through the existing shortcode field

**Decision:** A reaction is still stored as a shortcode name, exactly as an
ordinary emoji reaction (FDR-005). Rendering resolves the name by first checking
the server's custom emoji catalog; if the name is a known custom emoji it renders
as an image, otherwise the name falls through to built-in gemoji glyph
resolution.
**Why:** Reactions already key on a stable `^[a-z0-9_]{1,64}$`-shaped shortcode,
so custom emoji need no new reaction storage shape, no new reaction event, and no
change to how reaction counts and viewer state are aggregated. Detection is a
pure read-side concern layered on the current catalog.
**Tradeoff:** The custom-emoji-vs-gemoji distinction is derived at render time
from the current catalog rather than recorded on the reaction fact. A reaction
made against a custom emoji that is later deleted, and whose name is not a
gemoji, no longer resolves to an image.

### 2. No-collision rule keeps one shortcode namespace

**Decision:** Custom emoji names are validated to the reaction shortcode shape
and are rejected when they match a built-in gemoji shortcode.
**Why:** Reactions resolve a single name space. Forbidding collisions means a
given shortcode is unambiguously either a custom emoji or a gemoji, so the
fall-through resolution in decision 1 is deterministic and a member's picker
choice always renders the emoji they selected.
**Tradeoff:** Admins cannot shadow or override a built-in emoji with a custom
image of the same name.

### 3. Server-scoped singleton aggregate, in-memory projection

**Decision:** Custom emoji are durable, event-sourced server facts. Create and
delete write events to a single server-scoped `custom_emoji` aggregate
(`CustomEmojiCreatedEvent`, `CustomEmojiDeletedEvent`), and current catalog state
is derived by an in-memory `CustomEmojiProjection`.
**Why:** The catalog is server-wide, low-cardinality, and shared by every member,
so a single server-scoped aggregate matches the data's natural ownership and
keeps create/delete ordering explicit and replayable, consistent with Chatto's
event-sourcing model (ADR-033, ADR-034). Per-aggregate migration (ADR-035) keeps
the new aggregate's evolution isolated from other domains.
**Tradeoff:** A single aggregate serializes catalog writes, which is fine for an
admin-only, infrequently edited list but would not suit high-write-rate data.

### 4. Reuse the server-asset pipeline for storage and serving

**Decision:** Processed emoji images are stored in the existing server-asset
object store (NATS ObjectStore or S3) and served over HTTP, the same
infrastructure that backs avatars, server branding, and link-preview images.
**Why:** Emoji images are small, public, server-scoped binaries with the same
lifecycle needs as other server assets. Reusing the pipeline avoids a parallel
storage/serving path and inherits its backend flexibility.
**Tradeoff:** Emoji images are public once their URL is known, like other
server-scoped assets; they are not access-ticket gated the way room attachments
are.

### 5. Public read API, admin-gated write API

**Decision:** Listing the catalog is a public authenticated read
(`chatto.api.v1.CustomEmojiService.ListCustomEmojis`) available to any signed-in
member for the picker and reaction rendering. Creating and deleting emoji live on
a separate administrative service (`chatto.admin.v1.AdminCustomEmojiService`)
gated on `server.manage`.
**Why:** Every member needs to read the catalog, but only administrators should
change it. Splitting a broad read service from an admin write service follows the
public API conventions in ADR-042 and ADR-044 and keeps the authorization
boundary obvious.
**Tradeoff:** Two services describe one resource, but each has a single clear
audience and permission requirement.

### 6. Reactions only for the first version

**Decision:** Custom emoji are usable as reactions and nothing else. Inline
`:name:` substitution inside message bodies is explicitly out of scope for this
version.
**Why:** Reactions already resolve shortcodes, so custom emoji reuse that path
with minimal new surface. Inline body substitution would require parsing and
rendering emoji tokens inside message content, with its own escaping, editing,
and notification interactions, and is deferred until the catalog and picker have
proven out.
**Tradeoff:** Members can react with a custom emoji but cannot drop it into a
sentence yet.

## Permissions

- `server.manage` — upload and delete server custom emoji. Held by the owner and
  admin roles. Reading the catalog and reacting with a custom emoji require only
  authentication (reacting also requires `message.react`, per FDR-005).

## Related

- **ADRs:** ADR-022 (NanoID with entity prefixes), ADR-033 (event-sourced state
  with projections), ADR-034 (single event stream), ADR-035 (per-aggregate
  migration), ADR-042 (protobuf-first public API), ADR-044 (ConnectRPC service
  conventions)
- **FDRs:** FDR-005 (Reactions), FDR-008 (File Attachments & Video Processing),
  FDR-020 (Server Branding & Configuration), FDR-021 (Admin Dashboard & System
  Monitoring)

## Open Questions

- Inline `:name:` custom emoji rendering inside message bodies is deferred to a
  future version and will need its own parsing, editing, and notification
  decisions.
