# Custom Emoji in User Statuses Design

**Date:** 2026-08-03
**Status:** Approved

## Problem

The custom-status editor uses the shared emoji picker, which includes
server-defined custom emoji and returns their bare shortcode names. The backend
currently accepts only one Unicode emoji from the bundled gemoji dataset, so it
rejects every custom-emoji selection with “custom status emoji must be a single
supported emoji.” Status renderers also print the stored string directly, which
would expose a shortcode name instead of its image if backend validation alone
were relaxed.

## Goals

- Let a member choose any current server custom emoji as their status marker.
- Preserve the existing Unicode custom-status behavior and validation.
- Render custom status emoji as images everywhere the bundled client renders a
  status marker.
- Preserve status text when an administrator later deletes the selected custom
  emoji, while hiding the unresolved marker.
- Keep existing persisted status events and public protobuf field identities
  compatible.

## Non-Goals

- Embedding custom-emoji image URLs or assets in user profile events.
- Automatically clearing or rewriting statuses when a custom emoji is deleted.
- Adding a separate status-emoji resource or event family.
- Making deleted custom emoji render from historical assets.

## Decision

Store a custom status emoji using the same bare, canonical shortcode name that
the existing picker, reactions, and custom-emoji catalog already use. When a
status is written, the user service accepts either one supported Unicode emoji
or a shortcode that resolves in the current server custom-emoji projection. A
resolved shortcode is normalized to the catalog’s canonical lowercase name
before it is appended to the existing user custom-status event.

The bundled client resolves a stored shortcode through the existing per-server
custom-emoji store and renders it with the shared image-aware emoji component.
Unicode values continue to render as glyphs. If a shortcode no longer resolves,
emoji-only surfaces render no marker; surfaces that include status text keep
showing that text.

Custom emoji names permit up to 64 characters, so the status emoji limit and
the public response validation are relaxed from 16 to 64 characters. This does
not allow arbitrary longer values: the service still requires either a complete
supported Unicode emoji or a current catalog entry.

## Data and Event Compatibility

The existing `CustomUserStatus.emoji` string field carries both forms without a
schema change. The existing `custom_status_set` user event, aggregate subject,
projection, read-your-writes behavior, and realtime delivery remain unchanged.
Historical Unicode statuses replay exactly as before, and new shortcode values
remain valid strings for older readers. No data migration or projection
snapshot contract change is required.

## Public API and Version Skew

This is a behavioural, wire-compatible change to `chatto.api.v1`: validation
becomes less restrictive and the existing string field’s maximum accepted
length increases. Field numbers and field types do not change.

- An older client talking to a newer server can continue using Unicode status
  emoji. If it submits a custom shortcode, the server accepts it, although that
  client may display the name literally until upgraded.
- A newer client talking to an older server encounters the existing
  `INVALID_ARGUMENT` response when selecting a custom emoji. The failure is
  limited to updating that status and does not affect the rest of the client.

No protocol capability is added because the current picker already exposes
custom emoji in this workflow and the change repairs that existing path rather
than introducing a newly negotiated client feature. The PR and release notes
must call out the validation relaxation and the older-client rendering caveat.

## Error Handling

Empty markers, arbitrary text, unknown shortcode names, multiple adjacent
Unicode emoji, and values longer than 64 characters remain invalid. A custom
emoji deleted before or during a concurrent status update may leave an
unresolved shortcode in the durable status; this is safe because deletion is
defined to hide only the marker while preserving the status text.

## Verification

Use test-driven development at both responsible layers:

1. Add a backend regression test that installs a custom emoji, writes it as a
   status, and verifies canonical persistence. Keep negative coverage for
   unknown names and multiple Unicode emoji.
2. Add component coverage proving known custom status emoji render as images
   and deleted/unresolved emoji hide without removing status text.
3. Exercise the status editor’s picker-to-save path with a custom emoji.
4. Regenerate public Go/TypeScript bindings and ConnectRPC reference docs.
5. Run focused backend and frontend tests, Svelte analysis, API checks, lint,
   formatting, and the relevant broader suites before opening the PR.
