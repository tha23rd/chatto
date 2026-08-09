# FDR-905: Profile Popover

**Status:** Active
**Last reviewed:** 2026-08-09

## Overview

Clicking a member's name — in a message, the room member sidebar, or a voice
call tile — opens a compact profile popover showing the member's identity and
their explicit server roles as Discord-style coloured pills. This is the first
slice of the broader profile epic: a surface for presenting a member's public
identity in one place, later extended into a full profile view.

## Behavior

- Clicking a member's name opens the profile popover from every surface that
  shows a member name: message authors, the room member list, and voice call
  participants.
- The popover shows the member's avatar, display name (in their highest
  role's colour), login, and custom status.
- The member's explicit roles appear as pills at the bottom of the popover,
  matching Discord's mini profile: a role-colour dot followed by the role's
  display name, listed highest role first.
- The virtual `everyone` role is never shown.
- A member with no explicit roles shows no role section at all.
- Roles whose catalogue metadata is unavailable (e.g. deleted roles) are
  skipped rather than rendered as unknown names.

## Design Decisions

### 1. Reuse the public role catalogue instead of a per-popover fetch

**Decision:** The popover resolves role names to metadata through the
server-scoped public role catalogue that message rendering and the composer
already load lazily.
**Why:** One coalesced catalogue load per server serves every consumer; a
per-open fetch would duplicate the same data on every popover click.
**Tradeoff:** Pills appear only once the catalogue is loaded; the popover
triggers the load on open, so the section can appear a moment after the rest
of the card on first use.

### 2. Pills are ordered by role hierarchy, highest first

**Decision:** Roles render in descending position order (owner, admin,
moderator, then custom roles), matching Discord.
**Why:** Hierarchy order is the canonical server-side rank and is already
exposed on the public `Role` shape; it needs no client-side model.
**Tradeoff:** None beyond relying on server-assigned positions, which are
already authoritative.

### 3. `everyone` is excluded and absent roles are skipped

**Decision:** The virtual `everyone` role is filtered before it reaches the
popover, and role names missing from the catalogue are silently skipped.
**Why:** `everyone` is a permission-model device, not a badge a member wears;
Discord hides it in profiles. Skipping unknown names mirrors the public
`BatchGetRoles` contract and keeps the popover robust to deleted roles.
**Tradeoff:** A viewer with no explicit roles sees no role section, which is
the Discord baseline.

### 4. No heading, no new copy

**Decision:** The role section renders pills without a "Roles" heading, and
no new localised strings were added.
**Why:** Discord's mini profile shows bare pills; adding a heading would
require new message catalogs in every locale for no parity gain.
**Tradeoff:** The section's meaning relies on the familiar pill visual
language.

## Permissions

No dedicated permission. The popover is available to any authenticated room
member who can see the member's name; role metadata is the public role
catalogue.

## Related

- **ADRs:** ADR-043 (client-shell internationalization)
- **FDRs:** FDR-001 (Roles & Permissions), FDR-022 (User Profile),
  FDR-025 (User Search & Member Directory)

## Open Questions

- Future profile-epic slices (full profile modal with banner, About,
  member-since, pronouns, notes; a DM entry point) will likely need a richer
  profile read surface than the member directory row, a dedicated route, and
  the popover refactored to open the modal. The popover's lazy-loading
  pattern is the intended template for that work.
