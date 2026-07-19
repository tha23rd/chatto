<script lang="ts">
  import { onDestroy } from 'svelte';
  import { initPresenceTracking } from '$lib/presenceTracking';
  import {
    updateAuthenticatedCurrentUserPresenceEntries,
    type PresenceCache
  } from '$lib/state/presenceCache.svelte';
  import { eventBusManager } from '$lib/state/server/eventBus.svelte';
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
