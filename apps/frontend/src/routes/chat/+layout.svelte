<script lang="ts">
  import { fullscreenVideo } from '$lib/state/globals.svelte';
  import NotificationSync from '$lib/components/NotificationSync.svelte';
  import { createPresenceCache } from '$lib/state/presenceCache.svelte';
  import { createUserProfileCache } from '$lib/state/userProfiles.svelte';
  import AnonymousOriginPresenceProvider from './AnonymousOriginPresenceProvider.svelte';
  import ChatRoot from './ChatRoot.svelte';

  let { data, children } = $props();
  let fullscreenVideoOverlayModule: Promise<
    typeof import('$lib/components/chat/FullscreenVideoOverlay.svelte')
  > | null = null;

  function loadFullscreenVideoOverlay() {
    fullscreenVideoOverlayModule ??= import('$lib/components/chat/FullscreenVideoOverlay.svelte');
    return fullscreenVideoOverlayModule;
  }

  const profileCache = createUserProfileCache();
  const presenceCache = createPresenceCache();
</script>

<!-- This distribution keeps origin presence and notification sync running for
     anonymous origin viewers, which ChatRoot does not cover; ChatRoot owns the
     authenticated lifecycle for origin and remote-only sessions alike. -->
{#if !data.user}
  <AnonymousOriginPresenceProvider {presenceCache} />
  <NotificationSync />
{/if}

<!-- Origin login/logout changes replace the origin-scoped effects while the
     chat-wide coordinator remains available to remote-only sessions. -->
{#key data.user?.id}
  <ChatRoot user={data.user} {profileCache} {presenceCache}>
    {@render children?.()}
  </ChatRoot>
{/key}

{#if fullscreenVideo.isOpen}
  {#await loadFullscreenVideoOverlay() then { default: FullscreenVideoOverlay }}
    <FullscreenVideoOverlay />
  {/await}
{/if}
