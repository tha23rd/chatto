<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { initPresenceTracking } from '$lib/presenceTracking';
  import {
    updateAuthenticatedCurrentUserPresenceEntries,
    type PresenceCache
  } from '$lib/state/presenceCache.svelte';
  import { presencePreference } from '$lib/state/presencePreference.svelte';
  import { getActiveServer } from '$lib/state/activeServer.svelte';
  import { eventBusManager } from '$lib/state/server/eventBus.svelte';
  import { serverRegistry } from '$lib/state/server/registry.svelte';
  import { serverConnectionManager } from '$lib/state/server/serverConnection.svelte';

  let { presenceCache }: { presenceCache: PresenceCache } = $props();

  function realtimeRegistrations() {
    return serverRegistry.servers.flatMap((server) => {
      const store = serverRegistry.tryGetStore(server.id);
      return store?.isAuthenticated
        ? [
            {
              serverId: server.id,
              connection: serverConnectionManager.getClient(server.id),
              projectionSupported: store.serverInfo.supportsRealtimeProjection,
              sync: store.realtimeSync
            }
          ]
        : [];
    });
  }

  function synchronizeRealtimeTransports(
    registrations: ReturnType<typeof realtimeRegistrations>,
    activeServerId: string
  ) {
    eventBusManager.synchronizeAuthenticatedServers(registrations, activeServerId || null);
  }

  // AuthenticatedRoot owns this coordinator when the origin is authenticated.
  // An anonymous origin still needs the same ownership for authenticated remote
  // servers, including the synchronous registration before child routes mount.
  synchronizeRealtimeTransports(realtimeRegistrations(), getActiveServer());

  const registrations = $derived.by(realtimeRegistrations);
  const activeServerId = $derived(getActiveServer());

  $effect(() => {
    const nextRegistrations = registrations;
    const nextActiveServerId = activeServerId;

    untrack(() => {
      synchronizeRealtimeTransports(nextRegistrations, nextActiveServerId);
    });
  });

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
