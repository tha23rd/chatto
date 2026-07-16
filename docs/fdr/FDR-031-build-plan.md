# Channel Webhooks — Build Plan (FDR-031)

Working checklist for implementing channel webhooks. Not a durable doc — delete or
move to `.context/` once the feature lands. Ordered so each step compiles/tests
before the next. File refs are current-tree anchors, not prescriptions.

## Decisions locked
- Author = synthetic `User` with `UserKind = WEBHOOK` (a real, passwordless,
  hidden member).
- Per-message `username`/`avatar_url` override = additive display-override fields
  on the message body, applied at render.
- Management = server-admin, gated by new `webhook.manage`; mirrors Custom Emoji.
- Inbound = REST `POST /webhooks/:webhookId/:token`, token-authorized, rate limited.
- First cut includes attachments.

---

## Step 0 — Branch + FDR
- Branch `feat/channel-webhooks` off `main`.
- Land `docs/fdr/FDR-031-channel-webhooks.md` and add it to `docs/fdr/INDEX.md`
  (Experimental → Active on ship).

## Step 1 — Proto: user kind (additive, core + public)
- `proto/chatto/core/v1/models.proto`: add `enum UserKind { UNSPECIFIED=0; HUMAN=1;
  WEBHOOK=2; }` and `UserKind kind = 7;` to `User` (next free field = 7).
- `proto/chatto/core/v1/user_events.proto`: add `UserKind kind = 2;` to
  `UserAccountCreatedEvent` (PII fields start at 10; 2 is free). Unspecified
  backfills to HUMAN in the projection.
- `proto/chatto/api/v1/users.proto`: add `UserKind kind = 8;` to public `User`
  (next free = 8). Reuse the same enum or a public mirror per api conventions.
- **Never renumber** existing fields (core protos are persistence — CLAUDE.md).

## Step 2 — Proto: message display overrides (additive)
- `proto/chatto/core/v1/message_events.proto` `MessageBodyEvent` / `MessageBody`:
  add optional `override_display_name` and `override_avatar_asset_id` (encrypted
  with the body, like author content). Pick next-free tags.
- `proto/chatto/api/v1/message_types.proto` `Message` (reserved 14-18; next free =
  22): add optional `webhook_author` display (name + avatar_url) OR two override
  fields surfaced for render. Keep additive.

## Step 3 — Proto: webhook resource + services (clone Custom Emoji)
- Public read: `proto/chatto/api/v1/webhooks.proto` — `message Webhook {id, room_id,
  name, avatar_url, creator_id, created_at, disabled}`; `WebhookService` with
  `ListWebhooks`, `GetWebhook`, `BatchGetWebhooks`. NO token field on reads.
- Admin write: `proto/chatto/admin/v1/webhooks.proto` — `AdminWebhookService` with
  `CreateWebhook`, `UpdateWebhook`, `DeleteWebhook`, `RegenerateWebhookToken`.
  Create/Regenerate responses carry the one-time raw token + full URL. Each RPC
  comment: "Requires server.manage / webhook.manage." Use `buf.validate` rules.
- Model after `proto/chatto/api/v1/custom_emojis.proto` +
  `proto/chatto/admin/v1/custom_emojis.proto`.

## Step 4 — Codegen wiring (before writing Go)
- Add both new services to `tools/split-connectrpc-docs.mjs` grouping array
  (codegen FAILS if a service is unassigned).
- Add sidebar entries in `apps/docs-website/astro.config.mjs` (public + admin
  reference lists).
- Run `mise codegen-proto`; commit generated Go (`cli/internal/pb/...`), TS
  (`packages/api-types/src/...`), and docs `.mdx`.

## Step 5 — Core: user kind plumbing
- `cli/internal/core/user_projection.go` `applyAccountCreated` (~:171): store kind;
  unspecified → HUMAN. Add `Kind()` accessor on the projected user (~:230 area).
- New minter in `cli/internal/core/users.go` (clone `CreateUser` :49): mint
  `UserKind_WEBHOOK`, passwordless (emit NO `UserPasswordHashChangedEvent`), set
  display_name + avatar. ID via `NewUserID()` (prefix `U`).
- **Exclusion choke points** (from exploration):
  - `GetServerMembers` `spaces.go:151` / `ListUsers` `users.go:736` — filter out
    WEBHOOK kind (directory).
  - `GetUserByLogin` `users.go:314` / auth resolution `http_server/auth.go` —
    exclude WEBHOOK from login/OAuth so they can never authenticate.
  - Mentionables `mentionables_projection.go` — decide mentionability (default:
    exclude from human autocomplete).
  - Room member list `ListRoomMemberReferences` `room_membership.go:693` — hide (or
    group) webhook members. First cut: hide.
- Add tests: webhook user excluded from directory, cannot login, not mentionable.

## Step 6 — Core: webhook aggregate + projection (clone Custom Emoji trio)
- Clone `cli/internal/core/custom_emoji.go` + `custom_emoji_events.go` +
  `custom_emoji_projection.go` → `webhook.go` / `webhook_events.go` /
  `webhook_projection.go`.
- Durable events: `WebhookCreated`, `WebhookUpdated`, `WebhookTokenRotated`,
  `WebhookDeleted` on `evt.room.{roomID}.webhook_*` (add subjects in
  `events/subjects.go`).
- Stored fields: id (`cht_WH…` via new minter in `ids.go`, mirror `NewAuthToken`),
  room_id, group_id, creator_id, name, avatar_asset_id, backing user_id,
  token_hash, timestamps, disabled.
- Token: generate raw `cht_WH…`, persist only HMAC (reuse
  `runtime_token_keys.go` scheme with a new `webhook` domain separator). Projection
  builds `token_hash → webhook` lookup + validator `ValidateWebhookToken`.
- On create: mint the backing webhook user (Step 5), join it to the room so it can
  post.
- Tests: create/list/update/delete/rotate; rotate invalidates old hash; validator
  round-trip; backup `skipReason()` handling per cli/AGENTS.md.

## Step 7 — Core: post-as-webhook + overrides
- New core entry paralleling `MessageModel.PostMessage` but taking a validated
  webhook (not a session user): authorize via webhook, actor = backing user id,
  pass optional override display fields into the message body.
- Thread the override fields through `ChattoCore.PostMessage`
  (`cli/internal/core/messages.go:388`) into `MessageBodyEvent`.
- Timeline mapping (`room_timeline` assembler / `message_types` mapping): when
  overrides present, surface them; else resolve author user. Ensure the webhook
  author is marked as automated (kind on the hydrated `User`).
- Tests: posted message appears in timeline with webhook identity; override wins
  when present; live delivery + notification unaffected.

## Step 8 — ConnectRPC handlers
- `cli/internal/connectapi/webhooks.go`: `webhookService` (public read) +
  `adminWebhookService` (admin write), thin methods calling `s.api.core.*`, mapping
  via `connectError` / `requireCaller`. Assemblers in `*_assembler.go`.
- Enforce `webhook.manage` in the admin handlers (Step 9 permission).
- Register both in `cli/internal/connectapi/api.go` (build handler ~:119; append
  service entry ~:146 with `AuthPolicyAuthenticatedUser`).

## Step 9 — Permission
- `cli/internal/core/permission.go`: `PermWebhookManage Permission =
  "webhook.manage"` + `PermissionMetadata` entry (display name "Manage Webhooks",
  category, server scope).
- `cli/internal/core/can.go`: `CanManageWebhooks` → `hasServerPermission(
  PermWebhookManage)`.
- Verify hyphenated key (fdr skill checklist). Update permission tests +
  permission-inspection surfaces.

## Step 10 — Inbound REST endpoint + attachments
- `cli/internal/http_server/webhooks.go`: add `POST /webhooks/:webhookId/:token`
  to the existing gin `/webhooks` group (already CSRF-exempt, FDR-023). Validate
  token → webhook; reject disabled/mismatched. Parse `{content, username?,
  avatar_url?, attachments?, wait?}`; call Step 7 core entry.
- Attachments: new token-authorized upload path reusing `MediaModel.
  UploadAttachment` (`attachments.go:82`) / `AssetUploadModel` with the webhook
  user id as actor (bypasses `requireCaller`). Enforce size + count limits.
- Per-webhook rate limiting. Return the created message when `wait=true`.
- Tests: valid post; bad token 401/404; disabled webhook; oversize attachment;
  rate-limit trip. Mirror existing `webhooks_test.go` style.

## Step 11 — Frontend (clone Custom Emoji settings)
- Route: `apps/frontend/src/routes/chat/[serverId]/server-admin/webhooks/+page.svelte`
  (clone `custom-emoji/+page.svelte`). Nav tab in
  `lib/components/chat/adminNav.ts`. Route gate in `server-admin/+layout.svelte`
  (`server.manage` / `webhook.manage`).
- Component: clone `lib/CustomEmojiSettings.svelte` — list + inline create (name +
  avatar upload + target-room picker) + per-row regenerate/delete. One-time
  token/URL shown in a copy control (reuse `settings/CopyId.svelte` pattern);
  never re-fetchable.
- Client wrapper `lib/api-client/webhooks.ts` (clone `customEmojis.ts`); per-server
  store `lib/state/webhooks.svelte.ts` (clone `customEmojis.svelte.ts`).
- Timeline rendering: mark webhook-authored messages (kind/override) with an
  "automated" badge; honor override name/avatar.
- i18n: add `server_settings.webhooks.*` strings across all 16 locales
  (en-GB source + catalogs; en-US overrides where wording differs). ADR-043.

## Step 12 — Docs + verification
- `docs/ARCHITECTURE.md`: new EVT events/subjects, `UserKind`, WebhookService +
  AdminWebhookService, `/webhooks/:id/:token` route, webhook projection.
- `docs/GLOSSARY.md`: "Webhook", "Webhook user / synthetic user".
- Docs website: webhook usage/config page.
- `NOTICE` / `mise license-check` if any new files need headers.
- Verify: `mise test-cli`, `mise test-frontend`, targeted e2e (post via webhook →
  appears in room), and `/chatto-live-verify` for PR screenshots
  (UI PRs need screenshots — memory).
- Flip FDR-031 to **Active**.

---

## Risk / watch-list
- **Core proto additivity:** every field added to `core/v1` must be additive and
  never renumbered — persistence + backups depend on it.
- **Webhook-user leakage:** the exclusion choke points (Step 5) are the security
  surface. A missed one = a webhook showing up in the directory or (worse) being
  loginable. Test each explicitly.
- **Unauthenticated upload:** Step 10's attachment path is the biggest new attack
  surface — strict size/count/type limits + rate limiting are not optional.
- **Encryption:** override display fields ride in the encrypted body; confirm they
  round-trip through decrypt and are not logged (no PII in logs — CLAUDE.md).
- **Mixed versions:** old clients that ignore `kind`/override fields must still
  render webhook messages sanely (they'll just show the backing user's identity).
