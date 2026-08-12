<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onNotificationClick } from '$lib/notifications/pushNotifications';
  import { prepareUiForNotificationPath } from '$lib/notifications/notificationNavigationUi';
  import { setAuthServerInfo } from '$lib/components/authServerInfo';
  import GlobalKeyboardShortcuts from '$lib/components/GlobalKeyboardShortcuts.svelte';
  import IdleTracker from '$lib/components/IdleTracker.svelte';
  import MobileSidebarChrome from '$lib/components/MobileSidebarChrome.svelte';
  import NotificationSync from '$lib/components/NotificationSync.svelte';
  import UpdateNotifier from '$lib/components/UpdateNotifier.svelte';
  import { usePageTitle } from '$lib/hooks/usePageTitle.svelte';
  import { usePinchZoomPrevention } from '$lib/hooks/usePinchZoomPrevention.svelte';
  import { sidebarSwipe } from '$lib/hooks/useSidebarSwipe.svelte';
  import { useVisualViewport } from '$lib/hooks/useVisualViewport.svelte';
  import { chatRoomIdFromRoute } from '$lib/navigation/chatRoomRoute';
  import { getActiveServer } from '$lib/state/activeServer.svelte';
  import { sidebarNav } from '$lib/state/globals.svelte';
  import { provideAppUiState } from '$lib/state/appUi.svelte';
  import { useServerRegistry } from '$lib/state/server/useServerRegistry.svelte';
  import { ToastContainer } from '$lib/ui/toast';
  import AppHeader from '$lib/ui/AppHeader.svelte';
  import Frame from '$lib/ui/Frame.svelte';
  import { getNativeHost } from '$lib/native/host';
  import { onMount } from 'svelte';
  import '../app.css';

  let { data, children } = $props();
  let modalContainerModule: Promise<typeof import('./chat/ModalContainer.svelte')> | null = null;

  function loadModalContainer() {
    modalContainerModule ??= import('./chat/ModalContainer.svelte');
    return modalContainerModule;
  }

  // The desktop updater and its notifier only exist in the packaged build, so
  // they load behind the capability rather than shipping in every web bundle.
  const supportsDesktopUpdates = getNativeHost().capabilities.desktopUpdates;
  let desktopUpdateNotifierModule: Promise<
    typeof import('$lib/components/DesktopUpdateNotifier.svelte')
  > | null = null;

  function loadDesktopUpdateNotifier() {
    desktopUpdateNotifierModule ??= import('$lib/components/DesktopUpdateNotifier.svelte');
    return desktopUpdateNotifierModule;
  }

  setAuthServerInfo(() => data.serverInfo);
  const appUi = provideAppUiState();
  useServerRegistry(() => data.user);
  useVisualViewport();
  usePinchZoomPrevention();

  onMount(() => {
    if (!supportsDesktopUpdates) return;
    let started: typeof import('$lib/native/desktopUpdates.svelte') | null = null;
    void import('$lib/native/desktopUpdates.svelte').then((module) => {
      started = module;
      void module.desktopUpdates.initialize();
    });
    return () => {
      void started?.desktopUpdates.destroy();
    };
  });

  const activeServerId = $derived(getActiveServer());
  const activeRoomId = $derived(chatRoomIdFromRoute(page.route.id, page.params.roomId));

  $effect(() => {
    if (typeof activeRoomId === 'string' && activeRoomId) {
      appUi.setActiveRoomScope(activeServerId, activeRoomId);
      return;
    }
    appUi.setActiveServer(activeServerId);
  });

  // Route push-notification clicks via SvelteKit's client-side navigation
  // instead of letting the SW do a full document navigation. Same-URL
  // clicks become a no-op; cross-URL clicks just update the route.
  $effect(() =>
    onNotificationClick((url) => {
      try {
        const target = new URL(url);
        if (target.origin !== window.location.origin) return;
        prepareUiForNotificationPath(appUi, target.pathname);
        return goto(resolve((target.pathname + target.search + target.hash) as '/'));
      } catch {
        // Ignore malformed URLs from the SW.
      }
    })
  );

  $effect(() => sidebarNav.initViewportTracking());
  afterNavigate(() => {
    if (sidebarNav.isMobile) sidebarNav.close();
  });
  const getFullTitle = usePageTitle();
  const fullTitle = $derived(getFullTitle());
</script>

<GlobalKeyboardShortcuts />
<IdleTracker />
<NotificationSync />
<UpdateNotifier />
{#if supportsDesktopUpdates}
  {#await loadDesktopUpdateNotifier() then { default: DesktopUpdateNotifier }}
    <DesktopUpdateNotifier />
  {/await}
{/if}

<svelte:head>
  <title>{fullTitle}</title>
</svelte:head>

<div
  use:sidebarSwipe
  class="flex h-full w-full flex-col overscroll-y-contain bg-surface pt-[env(safe-area-inset-top,0px)] md:p-3 md:pt-0"
>
  <AppHeader />

  <Frame class="relative flex-col">
    <MobileSidebarChrome>
      {@render children?.()}
    </MobileSidebarChrome>
  </Frame>
</div>

{#if page.state.modal}
  {#await loadModalContainer() then { default: ModalContainer }}
    <ModalContainer />
  {/await}
{/if}

<ToastContainer />
