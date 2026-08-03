# FDR-900: Custom Emoji

**Status:** Active
**Last reviewed:** 2026-08-03

## Overview

Server administrators can build a server-wide catalog of named custom emoji —
image shortcodes such as `:partyparrot:` — that every member can use in messages
and reactions and as custom-status markers. The catalog is shared by the whole
server; there are no per-user or per-room emoji sets.

## Behavior

- Admins upload custom emoji from a dedicated admin page. Each emoji has a name
  (its shortcode) and an image.
- Uploaded images are processed into small WebP images bounded to emoji display
  dimensions while preserving their aspect ratio. Animated GIF uploads are
  preserved as animated WebP so the emoji keeps its motion; other formats render
  as a single static frame.
- Names are lowercase and limited to letters, digits, and underscores
  (`^[a-z0-9_]{1,64}$`). A name that collides with a built-in gemoji shortcode
  (for example `:smile:`) is rejected so the two namespaces never overlap.
- Admins can delete a custom emoji. Existing reactions and custom-status markers
  that used it stop rendering as that image once it is gone. Any accompanying
  custom-status text remains intact and continues rendering on text-capable
  surfaces.
- Any authenticated member sees the current custom emoji catalog in the emoji
  picker alongside built-in emoji and can use one in a message, reaction, or
  custom status.
- Selected custom emoji participate in the per-server Recently Used list and
  image-aware quick-reaction slots. Deleted or otherwise unresolved entries stay
  hidden instead of rendering their raw names.
- Connected members receive custom emoji additions and deletions immediately;
  they do not need to reload before a newly uploaded emoji renders.
- Known `:name:` shortcodes render as custom emoji images in normal message
  prose. Shortcodes in code, preformatted text, and links remain literal.
- Reaction pills backed by a custom emoji render the emoji image; pills backed
  by a built-in emoji render the glyph as before. Counts, viewer highlight, and
  reactor tooltips behave the same as ordinary reactions.

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
gated on `emoji.manage`, with `server.manage` accepted for compatibility (see
decision 7).
**Why:** Every member needs to read the catalog, but only administrators should
change it. Splitting a broad read service from an admin write service follows the
public API conventions in ADR-042 and ADR-044 and keeps the authorization
boundary obvious.
**Tradeoff:** Two services describe one resource, but each has a single clear
audience and permission requirement.

### 6. Inline shortcodes render after message formatting

**Decision:** Known `:name:` shortcodes render as inline custom emoji in normal
message prose. Code, preformatted text, and link text remain literal.
**Why:** Shortcodes round-trip as message text, preserve editing and copying
semantics, reuse the server catalog, and avoid changing the stored message
schema.
**Tradeoff:** Rendering depends on the current catalog. Deleted or unavailable
emoji remain literal text, and custom emoji cannot render where the server
catalog is unavailable.

### 7. Dedicated `emoji.manage` permission, accepting `server.manage` too

**Decision:** Emoji create/delete are gated on a dedicated server-scope
`emoji.manage` permission rather than the broad `server.manage`. The check
(`CanManageCustomEmoji`) succeeds for either `emoji.manage` or `server.manage`,
and `emoji.manage` is seeded into the admin role defaults.
**Why:** Curating emoji is a low-risk, high-frequency task that admins reasonably
want to delegate. Requiring `server.manage` for it meant delegating the entire
server-settings surface (branding, blocked usernames, webhooks). A dedicated
permission lets an operator grant a narrow "emoji manager" role. Accepting
`server.manage` as well keeps the change non-breaking: existing admins and any
custom role previously granted `server.manage` for emoji keep working without a
re-grant.
**Tradeoff:** Two permissions can now authorize the same action, so reasoning
about "who can manage emoji" means checking both grants rather than one.

### 8. Realtime carries authoritative full-catalog replacements

**Decision:** Custom-emoji create and delete facts are delivered to every
authenticated realtime projection. Each fact emits the existing
`server_state_upsert` operation with an optional, complete custom-emoji catalog;
fresh compacted projections include the same catalog.
**Why:** Every member can read the server-wide catalog, and message/reaction
rendering must resolve an emoji uploaded moments earlier. Using an optional
field on an existing operation is additive for older clients, while a full
replacement handles missed events, reconnects, and deletion of the last emoji
without client-side delta ordering.
**Tradeoff:** A catalog change retransmits the small server-wide catalog instead
of one row. Custom emoji are low-cardinality and admin-curated, so the simpler
recovery and version-skew behavior is worth that bounded payload.

### 9. Custom statuses store canonical shortcode names

**Decision:** A custom-status marker may be one supported Unicode emoji or a
custom-emoji name from the current catalog. The server matches custom names
case-insensitively, stores the canonical lowercase name in the existing durable
status marker, and clients resolve it against their server-scoped catalog.
Unresolved names are hidden while the rest of the status remains intact.
**Why:** A catalog name is already the stable identity used to resolve custom
emoji images in messages and reactions. Reusing it keeps Unicode status markers
unchanged, avoids another persistent shape, and prevents arbitrary names from
being accepted without a corresponding image.
**Tradeoff:** Deleting a custom emoji also removes its image from existing
statuses. Marker-only badges disappear and text-capable surfaces become
text-only; a later status edit replaces the missing marker with a neutral
supported emoji unless the member chooses another one.

## Permissions

- `emoji.manage` — upload and delete server custom emoji. Held by the owner and
  admin roles by default, and grantable on its own to a narrower role so people
  can curate emoji without the broader `server.manage` capability. `server.manage`
  holders retain emoji access too, so existing server managers are unaffected
  (see decision 7). Reading the catalog and choosing a custom emoji for one's own
  status require only authentication (reacting also requires `message.react`, per
  FDR-005).

## Related

- **ADRs:** ADR-022 (NanoID with entity prefixes), ADR-033 (event-sourced state
  with projections), ADR-034 (single event stream), ADR-035 (per-aggregate
  migration), ADR-040 (permission-only RBAC with owner override), ADR-042
  (protobuf-first public API), ADR-044 (ConnectRPC service conventions)
- **FDRs:** FDR-001 (Roles & Permissions), FDR-005 (Reactions), FDR-008 (File
  Attachments & Video Processing), FDR-020 (Server Branding & Configuration),
  FDR-021 (Admin Dashboard & System Monitoring), FDR-022 (User Profile)
