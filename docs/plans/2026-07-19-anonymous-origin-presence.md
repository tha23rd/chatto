# Anonymous-Origin Presence Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep authenticated remote users visibly and server-side Online when the page origin is anonymous, including the Windows Tauri client.

**Architecture:** Preserve `AuthenticatedChatProvider.svelte` as the normal origin-authenticated owner. Add one headless fallback provider that mounts only when the origin user is absent and delegates all presence rules to the existing module-singleton `initPresenceTracking()` implementation.

**Tech Stack:** Svelte 5, TypeScript, ConnectRPC, Playwright, Vitest, Tauri 2/WebView2

---

### Task 1: Capture the remote-only presence failure

**Files:**

- Modify: `apps/frontend/e2e/server-flows.test.ts:334`

**Step 1: Extend the existing remote-only flow**

Import `ChatPage` and extend “signing in to a remote server works while the
origin is anonymous” after the existing subscription assertion:

```ts
const currentUserPresenceDot = page
  .getByTestId('current-user-presence-menu')
  .getByTestId('presence-dot');
await expect(currentUserPresenceDot).toHaveClass(/bg-presence-online/, {
  timeout: TIMEOUTS.REALTIME_EVENT
});

const remoteChatPage = new ChatPage(page);
const roomPage = await remoteChatPage.enterRoom('general');
await roomPage.expectMemberVisible('remoteonlyuser');
await expect(roomPage.getMemberPresenceDot('remoteonlyuser')).toHaveClass(
  /bg-presence-online/,
  { timeout: TIMEOUTS.REALTIME_EVENT }
);
```

The current-user assertion reproduces the reported UI symptom. The member-list
assertion proves the real server presence record exists instead of checking only
an optimistic local cache value.

**Step 2: Run the focused case and verify RED**

Run:

```sh
mise x -- pnpm --dir apps/frontend exec playwright test \
  e2e/server-flows.test.ts \
  --grep "signing in to a remote server works while the origin is anonymous" \
  --retries=0
```

Expected: FAIL because the presence dot remains `bg-presence-offline`; the
existing OAuth, navigation, registry, and subscription assertions still pass.

### Task 2: Add the anonymous-origin fallback owner

**Files:**

- Create: `apps/frontend/src/routes/chat/AnonymousOriginPresenceProvider.svelte`
- Modify: `apps/frontend/src/routes/chat/+layout.svelte:1-42`

**Step 1: Implement the headless fallback provider**

Create a component that accepts `presenceCache`, starts the existing singleton,
and cleans it up on destruction:

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { initPresenceTracking } from '$lib/presenceTracking';
  import {
    updateAuthenticatedCurrentUserPresenceEntries,
    type PresenceCache
  } from '$lib/state/presenceCache.svelte';
  import { serverRegistry } from '$lib/state/server/registry.svelte';
  import { serverConnectionManager } from '$lib/state/server/serverConnection.svelte';
  import { eventBusManager } from '$lib/state/server/eventBus.svelte';

  let { presenceCache }: { presenceCache: PresenceCache } = $props();

  const stopPresenceTracking = initPresenceTracking(
    () =>
      serverRegistry.servers
        .filter((server) => serverRegistry.tryGetStore(server.id)?.isAuthenticated)
        .map((server) => {
          const client = serverConnectionManager.getClient(server.id);
          return {
            serverId: server.id,
            baseUrl: client.connectBaseUrl,
            bearerToken: client.bearerToken
          };
        }),
    (status) => {
      updateAuthenticatedCurrentUserPresenceEntries(
        presenceCache,
        currentUserPresenceStores(),
        status
      );
    },
    {
      onPauseLiveEvents: () => eventBusManager.pauseAll(),
      onResumeLiveEvents: () => {
        eventBusManager.resumeAll();
        for (const server of serverRegistry.servers) {
          if (serverRegistry.tryGetStore(server.id)?.isAuthenticated) {
            eventBusManager.startBus(server.id, serverConnectionManager.getClient(server.id));
          }
        }
      }
    }
  );

  onDestroy(stopPresenceTracking);

  function currentUserPresenceStores() {
    return serverRegistry.servers.map((server) => {
      const store = serverRegistry.tryGetStore(server.id);
      return store
        ? {
            serverId: server.id,
            isAuthenticated: store.isAuthenticated,
            currentUser: store.currentUser
          }
        : null;
    });
  }
</script>
```

Do not add markup, another timer, another activity listener, desktop checks, or
changes to `AuthenticatedChatProvider.svelte`.

**Step 2: Mount it only for an anonymous origin**

In `apps/frontend/src/routes/chat/+layout.svelte`, import the provider and mount
it before the authenticated-root conditional:

```svelte
{#if !data.user}
  <AnonymousOriginPresenceProvider {presenceCache} />
{/if}
```

This keeps exactly one caller of `initPresenceTracking()` in either topology.

**Step 3: Run the Svelte analyzer**

Run:

```sh
mise x -- npx @sveltejs/mcp svelte-autofixer \
  apps/frontend/src/routes/chat/AnonymousOriginPresenceProvider.svelte
mise x -- npx @sveltejs/mcp svelte-autofixer \
  apps/frontend/src/routes/chat/+layout.svelte
```

Expected: no issues. Review suggestions rather than suppressing them.

**Step 4: Re-run the focused e2e case and verify GREEN**

Run the command from Task 1.

Expected: PASS. Both the current-user and room-member dots become Online.

**Step 5: Commit the behavior**

```sh
git add \
  apps/frontend/e2e/server-flows.test.ts \
  apps/frontend/src/routes/chat/AnonymousOriginPresenceProvider.svelte \
  apps/frontend/src/routes/chat/+layout.svelte
git commit -m "fix(frontend): report remote-only presence"
```

### Task 3: Focused regression verification

**Files:**

- Test: `apps/frontend/src/lib/presenceTracking.spec.ts`
- Test: `apps/frontend/src/lib/state/presenceCache.svelte.spec.ts`
- Test: `apps/frontend/src/lib/components/CurrentUserBar.svelte.spec.ts`

**Step 1: Run presence unit and component tests**

```sh
mise x -- pnpm --dir apps/frontend exec vitest --run \
  src/lib/presenceTracking.spec.ts \
  src/lib/state/presenceCache.svelte.spec.ts \
  src/lib/components/CurrentUserBar.svelte.spec.ts
```

Expected: all pass without new warnings.

**Step 2: Run the desktop frontend suite**

```sh
mise test-desktop
```

Expected: launcher tests and targeted frontend suites pass. The final Linux
Tauri Rust leg may remain unavailable in WSL if GTK/WebKit development packages
are absent; the native Windows Rust gate remains authoritative for this
Windows-only POC.

**Step 3: Run formatting and license checks**

```sh
mise x -- pnpm --dir apps/frontend exec prettier --check \
  src/routes/chat/AnonymousOriginPresenceProvider.svelte \
  src/routes/chat/+layout.svelte \
  e2e/server-flows.test.ts
mise license-check
git diff --check origin/main...HEAD
```

Expected: all pass.

### Task 4: Rebuild and verify the Windows client

**Files:**

- Build input: `apps/frontend/build/`
- Package output: Windows Cargo target directory under `C:\Temp`

**Step 1: Build the exact desktop frontend**

```sh
mise x -- pnpm run build:api-types
mise x -- pnpm --dir apps/frontend run build:desktop
```

Expected: the static desktop frontend emits `apps/frontend/build/index.html`.

**Step 2: Build a fresh native Windows release and isolated diagnostic copy**

Use the same committed-source staging process and Windows Node/Tauri/Rust tools
recorded in the Windows desktop POC plan. Give the Cargo target and diagnostic
identifier unique names derived from the new behavior commit.

Expected: release executable, NSIS installer, and diagnostic executable build
successfully.

**Step 3: Verify presence in WebView2**

Launch only the isolated diagnostic executable with a local WebView2 CDP port.
Authenticate against a disposable local/remote test server, then assert:

- the current-user presence dot becomes Online;
- a server-backed member read shows that user Online;
- the state stays Online across at least one 30-second heartbeat interval;
- no Connect or realtime errors are emitted.

Stop only the isolated diagnostic process.

**Step 4: Verify the corrected installer**

Run `apps/desktop/scripts/verify-package.ps1` against the new NSIS package and
record its size, SHA-256, product version, and unsigned POC status.

### Task 5: Publish and monitor

**Files:**

- Update: PR #20 body through `gh`

**Step 1: Verify the branch tip**

```sh
git status --short --branch
git log --oneline --decorate -7
git diff --check origin/main...HEAD
```

Expected: only the pre-existing untracked `cli/data.oldbak-23944/` remains.

**Step 2: Push and update PR evidence**

Push `feat/windows-desktop-poc`. Update PR #20 with the anonymous-origin root
cause, focused e2e result, native verification, and latest installer evidence.
Verify the stored body and head SHA through `gh api`.

**Step 3: Monitor CI**

Run `gh pr checks 20 --repo tha23rd/chatto`. Investigate and fix any regression
introduced by the presence commit; distinguish unrelated infrastructure or
runner failures with job logs.
