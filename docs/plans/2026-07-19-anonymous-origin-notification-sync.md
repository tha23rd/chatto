# Anonymous-Origin Notification Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep thread and My Threads notification indicators synchronized after a remote-only desktop session marks a thread as read.

**Architecture:** Preserve the existing authenticated web composition and mount the existing multi-server `NotificationSync` consumer only in the mutually exclusive anonymous-origin branch. Cover the branch composition with a browser component test, then reuse the existing notification-sync unit coverage and remote-only e2e flow for behavior verification.

**Tech Stack:** Svelte 5, SvelteKit, TypeScript, Vitest Browser Mode, Playwright, Tauri 2, NSIS

---

### Task 1: Prove the anonymous-origin sync owner is missing

**Files:**

- Create: `apps/frontend/src/routes/chat/ChatLayoutNotificationSyncMock.svelte`
- Create: `apps/frontend/src/routes/chat/chat-layout.svelte.spec.ts`

**Step 1: Add a notification-sync marker component**

Create a test-only Svelte component that makes the otherwise headless sync
owner observable:

```svelte
<div data-testid="notification-sync-mounted"></div>
```

**Step 2: Add the anonymous-origin layout test**

Mock `$lib/components/NotificationSync.svelte` with the marker component. Mock
presence tracking, the server registry, the connection manager, and the event
bus narrowly enough to render the chat layout with `data.user = null`.

```ts
it('mounts notification sync for an anonymous origin with remote authentication', () => {
  const { container } = renderLayout({ user: null });

  expect(container.querySelectorAll('[data-testid="notification-sync-mounted"]')).toHaveLength(1);
});
```

**Step 3: Run the focused test and verify RED**

Run:

```sh
mise x -- pnpm --dir apps/frontend exec vitest run --project=client src/routes/chat/chat-layout.svelte.spec.ts
```

Expected: FAIL because the anonymous-origin branch currently mounts presence
tracking but does not import or mount `NotificationSync`.

### Task 2: Mount notification sync only for anonymous origins

**Files:**

- Modify: `apps/frontend/src/routes/chat/+layout.svelte`
- Test: `apps/frontend/src/routes/chat/chat-layout.svelte.spec.ts`

**Step 1: Add the minimal implementation**

Import the existing component:

```ts
import NotificationSync from '$lib/components/NotificationSync.svelte';
```

Mount it in the existing anonymous-origin branch:

```svelte
{#if !data.user}
  <AnonymousOriginPresenceProvider {presenceCache} />
  <NotificationSync />
{/if}
```

Do not edit `AuthenticatedRoot.svelte` or `AuthenticatedChatProvider.svelte`.

**Step 2: Run the focused test and verify GREEN**

Run:

```sh
mise x -- pnpm --dir apps/frontend exec vitest run --project=client src/routes/chat/chat-layout.svelte.spec.ts
```

Expected: PASS with exactly one notification-sync owner in the anonymous branch.

**Step 3: Run adjacent notification and presence tests**

Run:

```sh
mise x -- pnpm --dir apps/frontend exec vitest run --project=client \
  src/routes/chat/chat-layout.svelte.spec.ts \
  src/routes/chat/AnonymousOriginPresenceProvider.svelte.spec.ts \
  src/lib/components/NotificationSync.svelte.spec.ts \
  src/lib/state/server/notifications.spec.ts
```

Expected: all tests PASS with no browser errors or warnings.

**Step 4: Run the Svelte autofixer**

Run:

```sh
mise x -- npx @sveltejs/mcp svelte-autofixer apps/frontend/src/routes/chat/+layout.svelte
mise x -- npx @sveltejs/mcp svelte-autofixer apps/frontend/src/routes/chat/ChatLayoutNotificationSyncMock.svelte
```

Expected: no actionable Svelte issues.

**Step 5: Commit the regression and fix**

```sh
git add \
  apps/frontend/src/routes/chat/+layout.svelte \
  apps/frontend/src/routes/chat/ChatLayoutNotificationSyncMock.svelte \
  apps/frontend/src/routes/chat/chat-layout.svelte.spec.ts
git commit -m "fix(frontend): sync remote-only notifications"
```

### Task 3: Verify behavior and package the Windows client

**Files:**

- Verify: `apps/frontend/e2e/server-flows.test.ts`
- Verify: `apps/frontend/e2e/my-threads.test.ts`
- Update: PR #20 body with the root cause and evidence

**Step 1: Run frontend checks**

Run:

```sh
mise x -- pnpm --dir apps/frontend run check
mise license-check
git diff --check origin/main...HEAD
```

Expected: Svelte check reports zero errors and zero warnings; licensing and diff
checks pass.

**Step 2: Run the working web and anonymous-origin e2e coverage**

Run:

```sh
mise x -- pnpm --dir apps/frontend exec playwright test \
  e2e/my-threads.test.ts \
  e2e/server-flows.test.ts \
  --retries=0
```

Expected: the established web read-indicator tests and anonymous-origin remote
session test pass.

**Step 3: Build the desktop renderer**

Run:

```sh
mise x -- pnpm run build:api-types
mise x -- pnpm --dir apps/frontend run build:desktop
```

Expected: the byte-for-byte desktop renderer build completes successfully.

**Step 4: Build and verify a clean Windows package**

Stage the committed `apps/desktop` source and the just-built desktop renderer in
a new commit-specific directory under `C:\\Temp`. Build it with the pinned
`@tauri-apps/cli@2.11.4`, using a new commit-specific target directory. Run the
repository's Windows package verifier and record the installer path, size,
SHA-256, product metadata, and unsigned POC status.

Expected: `Chatto_0.1.0_x64-setup.exe` is produced and the verifier passes.

**Step 5: Push and update PR #20**

```sh
git push origin feat/windows-desktop-poc
gh pr checks 20 --repo tha23rd/chatto
```

Append the root cause, low-conflict composition decision, RED/GREEN evidence,
focused test results, e2e result, Windows package path, and SHA-256 to the PR
body. Verify the stored head SHA and body through `gh api`.
