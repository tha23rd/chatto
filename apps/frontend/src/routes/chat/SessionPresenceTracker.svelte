<!--
@component

Drives session-wide presence for every authenticated server.

Presence is a session-level concern, not an origin-server one: idle/active
detection and the reported status apply to all authenticated instances at once,
and the reporter list already spans every authenticated server. Keeping this
outside the origin-only `AuthenticatedChatProvider` means presence also works
for remote-only sessions — the bundled desktop client and any standalone
frontend served from a non-Chatto origin, where there is no origin server.

Mount this once per authenticated session (see `chat/+layout.svelte`). It
initialises presence tracking on mount and tears it down on destroy.

**Props:**
- `presenceCache` - Shared server-scoped presence cache to update locally.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    updateAuthenticatedCurrentUserPresenceEntries,
    type PresenceCache
  } from '$lib/state/presenceCache.svelte';
  import { presencePreference } from '$lib/state/presencePreference.svelte';
  import { serverRegistry } from '$lib/state/server/registry.svelte';
  import { serverConnectionManager } from '$lib/state/server/serverConnection.svelte';
  import { eventBusManager } from '$lib/state/server/eventBus.svelte';
  import { initPresenceTracking } from '$lib/presenceTracking';

  let { presenceCache }: { presenceCache: PresenceCache } = $props();

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

  // Initialize presence tracking (idle detection → AWAY, active → ONLINE).
  // This works across all instances, not just origin.
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
      onPauseLiveEvents: () => {
        eventBusManager.pauseAll();
      },
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

  $effect(() => {
    updateAuthenticatedCurrentUserPresenceEntries(
      presenceCache,
      currentUserPresenceStores(),
      presencePreference.effectiveStatus
    );
  });
</script>
