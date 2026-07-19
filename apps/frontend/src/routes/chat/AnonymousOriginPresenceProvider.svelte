<script lang="ts">
  import { onDestroy } from 'svelte';
  import { initPresenceTracking } from '$lib/presenceTracking';
  import {
    updateAuthenticatedCurrentUserPresenceEntries,
    type PresenceCache
  } from '$lib/state/presenceCache.svelte';
  import { presencePreference } from '$lib/state/presencePreference.svelte';
  import { serverRegistry } from '$lib/state/server/registry.svelte';
  import { serverConnectionManager } from '$lib/state/server/serverConnection.svelte';

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
