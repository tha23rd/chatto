# Custom Emoji in User Statuses Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow current server custom emoji to be stored and rendered as user custom-status markers while preserving Unicode statuses and status text after emoji deletion.

**Architecture:** Keep the existing `CustomUserStatus.emoji` string and user event. Resolve writes against either the bundled Unicode emoji set or the current custom-emoji projection, normalize custom names to their canonical catalog value, and render stored names through the existing per-server custom-emoji store and `EmojiToken` component.

**Tech Stack:** Go, NATS JetStream projections, protobuf/ConnectRPC, Svelte 5, TypeScript, Vitest browser tests, Buf code generation

---

### Task 1: Capture backend custom-status acceptance

**Files:**

- Modify: `cli/internal/core/users_test.go:2043`
- Modify: `cli/internal/connectapi/api_test.go:4360`

**Step 1: Add a failing core regression**

In `TestChattoCore_SetAndClearUserCustomStatus`, grant the test user the admin
role, create a real custom emoji through `CreateCustomEmoji`, and write an
uppercase form of its 64-character name as a status:

```go
if err := core.AssignAdminRole(ctx, user.Id); err != nil {
	t.Fatalf("AssignAdminRole: %v", err)
}
customEmojiName := strings.Repeat("a", MaxCustomStatusEmojiLength)
if _, err := core.CreateCustomEmoji(
	ctx,
	user.Id,
	customEmojiName,
	createTestImage(2, 2),
); err != nil {
	t.Fatalf("CreateCustomEmoji: %v", err)
}

customUpdated, err := core.SetUserCustomStatus(
	ctx,
	user.Id,
	strings.ToUpper(customEmojiName),
	"Custom marker",
	nil,
)
if err != nil {
	t.Fatalf("SetUserCustomStatus custom emoji: %v", err)
}
if got := customUpdated.GetCustomStatus().GetEmoji(); got != customEmojiName {
	t.Fatalf("custom status emoji = %q, want canonical %q", got, customEmojiName)
}
```

Keep the unknown-name and multiple-Unicode-emoji negative assertions. Add a
65-character input assertion for `ErrCustomStatusEmojiTooLong`. Update the
expected status-event count to include the second successful write.

**Step 2: Add a failing ConnectRPC regression**

In `TestMyAccountServiceSetAndDeleteCustomStatus`, make the viewer an admin,
create `partyparrot` through the core, submit `PARTYPARROT`, and assert the
response contains canonical `partyparrot`:

```go
if err := env.core.AssignAdminRole(ctx, env.viewer.Id); err != nil {
	t.Fatalf("AssignAdminRole: %v", err)
}
if _, err := env.core.CreateCustomEmoji(
	ctx,
	env.viewer.Id,
	"partyparrot",
	bytes.NewReader(connectAPITestPNG()),
); err != nil {
	t.Fatalf("CreateCustomEmoji: %v", err)
}
customResp, err := env.account.UpdateCustomStatus(
	ctx,
	connect.NewRequest(&apiv1.UpdateCustomStatusRequest{
		Emoji: "PARTYPARROT",
		Text:  "Custom marker",
	}),
)
if err != nil {
	t.Fatalf("UpdateCustomStatus custom emoji: %v", err)
}
if got := customResp.Msg.GetStatus().GetEmoji(); got != "partyparrot" {
	t.Fatalf("custom status emoji = %q, want partyparrot", got)
}
```

**Step 3: Run the focused tests and verify RED**

```sh
cd cli
mise x -- go test ./internal/core \
  -run '^TestChattoCore_SetAndClearUserCustomStatus$' \
  -count=1 -timeout 30s
mise x -- go test ./internal/connectapi \
  -run '^TestMyAccountServiceSetAndDeleteCustomStatus$' \
  -count=1 -timeout 30s
```

Expected: both tests fail because custom shortcode names produce
`ErrCustomStatusEmojiInvalid` / `INVALID_ARGUMENT`.

### Task 2: Accept canonical catalog emoji in status writes

**Files:**

- Modify: `cli/internal/core/users.go:32`
- Modify: `cli/internal/core/users.go:1224`

**Step 1: Match the existing custom-emoji length contract**

Change `MaxCustomStatusEmojiLength` from 16 to 64.

**Step 2: Resolve the status marker**

Add a focused helper near the status errors:

```go
func (c *ChattoCore) resolveCustomStatusEmoji(emoji string) (string, error) {
	if IsValidUnicodeEmoji(emoji) {
		return emoji, nil
	}
	if c.CustomEmojis != nil {
		if customEmoji, ok := c.CustomEmojis.ByName(emoji); ok {
			return customEmoji.Name, nil
		}
	}
	return "", ErrCustomStatusEmojiInvalid
}
```

After trimming, required checks, and the 64-rune length check in
`SetUserCustomStatus`, replace the direct Unicode-only predicate with:

```go
emoji, err = c.resolveCustomStatusEmoji(emoji)
if err != nil {
	return nil, err
}
```

Do not change the event shape, aggregate subject, OCC path, projection, or live
delivery.

**Step 3: Re-run the focused tests and verify GREEN**

Run both commands from Task 1.

Expected: PASS. Unicode and custom emoji succeed; arbitrary strings, multiple
glyphs, and oversized values remain rejected.

**Step 4: Commit the backend behavior**

```sh
git add cli/internal/core/users.go cli/internal/core/users_test.go \
  cli/internal/connectapi/api_test.go
git commit -m "fix(profile): accept custom emoji status markers"
```

### Task 3: Capture image-aware status rendering

**Files:**

- Create: `apps/frontend/src/lib/components/UserCustomStatusBadge.svelte.spec.ts`
- Modify: `apps/frontend/src/lib/components/CurrentUserBar.svelte.spec.ts`

**Step 1: Add focused badge tests**

Seed the per-server custom-emoji store with `partyparrot`, render
`UserCustomStatusBadge` with `serverId="origin"`, and assert the image URL and
alt text:

```ts
getCustomEmojis('origin').upsert({
  id: 'emoji-partyparrot',
  name: 'partyparrot',
  url: 'https://example.test/assets/emoji/partyparrot'
});
const { container } = render(UserCustomStatusBadge, {
  props: {
    serverId: 'origin',
    status: { emoji: 'partyparrot', text: 'Working', expiresAt: null },
    showText: true
  }
});
expect(container.querySelector('img')?.getAttribute('src')).toBe(
  'https://example.test/assets/emoji/partyparrot'
);
expect(container.querySelector('img')?.getAttribute('alt')).toBe(':partyparrot:');
expect(container.textContent).toContain('Working');
```

Add a second test with no catalog entry. Assert there is no image, no literal
`partyparrot`, and the status text remains visible when `showText` is true.
Reset the custom-emoji stores before each test.

**Step 2: Extend the current-user surface test**

Seed `partyparrot`, set it on `currentUserState.user.customStatus`, render the
bar, and assert the identity card and status editor emoji button render the
custom image rather than shortcode text. Reset the store in `beforeEach`.

**Step 3: Run the focused component tests and verify RED**

```sh
mise x -- pnpm --filter chatto-frontend exec vitest --run \
  src/lib/components/UserCustomStatusBadge.svelte.spec.ts \
  src/lib/components/CurrentUserBar.svelte.spec.ts
```

Expected: FAIL because current status surfaces print the bare shortcode and the
badge does not yet accept a server ID.

### Task 4: Render status markers through the custom-emoji catalog

**Files:**

- Modify: `apps/frontend/src/lib/components/UserCustomStatusBadge.svelte`
- Modify: `apps/frontend/src/lib/components/UserCustomStatusEditor.svelte`
- Modify: `apps/frontend/src/lib/components/CurrentUserBar.svelte`
- Modify: `apps/frontend/src/lib/components/UserAvatar.svelte`
- Modify: `apps/frontend/src/lib/components/menus/UserContextMenu.svelte`
- Modify: `apps/frontend/src/routes/chat/[serverId]/[roomId]/RoomSidebar.svelte`
- Modify: `apps/frontend/src/routes/chat/[serverId]/[roomId]/MessageEvent.svelte`
- Modify: `apps/frontend/src/lib/components/voice/VoiceCallPanel.svelte`
- Test: `apps/frontend/src/lib/components/UserCustomStatusBadge.svelte.spec.ts`
- Test: `apps/frontend/src/lib/components/CurrentUserBar.svelte.spec.ts`

**Step 1: Make the badge server-aware**

Add a required `serverId` prop. Use `isCustomEmojiName` and `getCustomEmoji` to
derive whether the marker is unresolved. Render a shared `EmojiToken` for the
marker. Render nothing when a custom marker is unresolved and `showText` is
false; when `showText` is true, keep the text and omit the missing marker from
the title and DOM.

**Step 2: Pass explicit server IDs**

Pass the active or caller-provided server ID to every
`UserCustomStatusBadge`. Add a required `serverId` prop to `UserContextMenu` and
pass it from its three active-server callers. `UserAvatar` already derives the
active server and passes it to its badge.

**Step 3: Make editor and menu previews image-aware**

Import `EmojiToken` into `UserCustomStatusEditor` and use it for the active
custom marker in both compact and full editor controls and the compact active
status row. In `CurrentUserBar`, use the server-aware badge for both the
identity marker and the status-menu marker.

**Step 4: Run official Svelte analysis**

Run the Svelte MCP autofixer against every modified `.svelte` file. Apply real
issues; do not suppress diagnostics.

**Step 5: Re-run component tests and verify GREEN**

Run the Task 3 command.

Expected: both specs pass, known names render images, and deleted/unresolved
names preserve text without exposing a dead marker.

**Step 6: Commit the frontend behavior**

```sh
git add apps/frontend/src/lib/components \
  apps/frontend/src/routes/chat/[serverId]/[roomId]/RoomSidebar.svelte \
  apps/frontend/src/routes/chat/[serverId]/[roomId]/MessageEvent.svelte
git commit -m "fix(frontend): render custom emoji statuses"
```

### Task 5: Update the public API contract and generated artifacts

**Files:**

- Modify: `proto/chatto/api/v1/user_status.proto`
- Regenerate: `cli/internal/pb/chatto/api/v1/user_status.pb.go`
- Regenerate: `packages/api-types/src/api/v1/user_status_pb.ts`
- Regenerate: `apps/docs-website/src/generated/connectrpc-api/api.raw.mdx`
- Regenerate: `apps/docs-website/src/content/docs/reference/connectrpc-api/*.mdx`
- Regenerate: any additional output changed by `mise codegen-proto`

**Step 1: Document both accepted forms**

Change the `CustomUserStatus.emoji` and `UpdateCustomStatusRequest.emoji`
comments to say the value is one Unicode emoji or a current server custom-emoji
shortcode name. Change the response field’s `max_len` from 16 to 64.

**Step 2: Regenerate public artifacts**

```sh
mise codegen-proto
```

Review every generated diff. No hand-edited generated output is permitted.

**Step 3: Run protobuf compatibility and drift checks**

```sh
cd proto
mise x -- buf lint .
mise x -- buf breaking . \
  --against "../.git#branch=origin/main-native,subdir=proto"
cd ..
mise codegen-proto
git diff --exit-code
```

Expected: lint and breaking checks pass; the second codegen leaves no drift.

**Step 4: Commit schema and generated output**

```sh
git add proto/chatto/api/v1/user_status.proto \
  cli/internal/pb/chatto/api/v1/user_status.pb.go \
  packages/api-types/src \
  apps/docs-website/src/generated/connectrpc-api \
  apps/docs-website/src/content/docs/reference/connectrpc-api
git commit -m "docs(api): describe custom status emoji markers"
```

### Task 6: Update feature records

**Files:**

- Modify: `docs/fdr/FDR-022-user-profile.md`
- Modify: `docs/fdr/FDR-900-custom-emoji.md`
- Modify: `docs/fdr/INDEX.md`

**Step 1: Update current behavior**

In FDR-022, state that status markers may be Unicode or current server custom
emoji and that deleting a custom emoji hides the marker without clearing the
status text. Add a design decision describing canonical shortcode storage and
read-time catalog resolution.

In FDR-900, add custom statuses to the supported member surfaces and document
the same deletion behavior. Update both review dates to 2026-08-03. Update the
FDR index review date for FDR-022 and add the existing FDR-900 entry if absent.

**Step 2: Verify the FDR claims**

Check the edited behavior against the backend tests, badge tests, current API
comments, and FDR cross-references. Do not add implementation walkthroughs.

**Step 3: Commit the records**

```sh
git add docs/fdr/FDR-022-user-profile.md docs/fdr/FDR-900-custom-emoji.md \
  docs/fdr/INDEX.md
git commit -m "docs(fdr): document custom emoji statuses"
```

### Task 7: Verify, review, and publish

**Files:**

- Review all changed files against this plan and
  `docs/plans/2026-08-03-custom-status-custom-emoji-design.md`

**Step 1: Run focused verification**

```sh
cd cli
mise x -- go test ./internal/core \
  -run '^TestChattoCore_SetAndClearUserCustomStatus$' \
  -count=1 -timeout 30s
mise x -- go test ./internal/connectapi \
  -run '^TestMyAccountServiceSetAndDeleteCustomStatus$' \
  -count=1 -timeout 30s
cd ..
mise x -- pnpm --filter chatto-frontend exec vitest --run \
  src/lib/components/UserCustomStatusBadge.svelte.spec.ts \
  src/lib/components/CurrentUserBar.svelte.spec.ts \
  src/lib/components/UserAvatar.svelte.spec.ts \
  src/lib/components/menus/UserContextMenu.svelte.spec.ts
```

**Step 2: Run broader verification**

Run sequentially:

```sh
mise test-cli
mise test-frontend
mise lint-frontend
mise license-check
git diff --check origin/main-native...HEAD
```

Expected: all checks pass with no warnings introduced by the change. Report
partial verification honestly if an unrelated environment failure prevents a
suite from completing.

**Step 3: Request code review**

Review the diff from `origin/main-native` to `HEAD` for contract compliance,
error handling, deletion behavior, version skew, test adequacy, and generated
artifacts. Fix every critical or important finding and rerun affected tests.

**Step 4: Push and open the PR**

Use a conventional PR title such as:

```text
fix(profile): support custom emoji in user statuses
```

The body must link the planning issue, summarize backend and frontend changes,
classify the API change as behavioural and wire-compatible, describe both
version-skew directions, state that no migration/capability is required, give
release-note guidance, and list exact verification. Use a closing keyword for
the issue and verify the stored body and closing-issue wiring with:

```sh
gh pr view --json body,baseRefName,closingIssuesReferences
```

**Step 5: Monitor and merge**

Run `gh pr checks --watch` until all required CI checks pass. Investigate and
fix regressions from `main-native`, pushing follow-up commits and rechecking CI.
When all checks pass and the PR is mergeable, merge it using the repository’s
normal merge method, then verify the merged state with `gh pr view`.
