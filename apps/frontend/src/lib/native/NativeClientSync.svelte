<!--
@component

Synchronizes the existing multi-server frontend with the native desktop bridge.
It owns only shell integration: tray state/actions, global push-to-talk, deep
links, OAuth loopback delivery, taskbar badges, and update installation.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import type {
    NativeDeepLink,
    NativeOAuthCallback,
    NativeUpdateState
  } from '@chatto/native-bridge';
  import AddServerDialog from '$lib/components/AddServerDialog.svelte';
  import * as m from '$lib/i18n/messages';
  import { serverIdToSegment } from '$lib/navigation';
  import { handleNativeNotificationAction } from '$lib/native/notifications';
  import { prepareUiForNotificationTarget } from '$lib/notifications/notificationNavigationUi';
  import { getNativeClient } from '$lib/native/client';
  import { getAppUiState } from '$lib/state/appUi.svelte';
  import { serverRegistry } from '$lib/state/server/registry.svelte';
  import type { VoiceCallState } from '$lib/state/server/voiceCall.svelte';
  import { toast } from '$lib/ui/toast';

  const nativeClient = getNativeClient();
  const appUi = getAppUiState();
  let addServerVisible = $state(false);
  let addServerInitialUrl = $state('');
  let pendingMessageLink = $state<Extract<NativeDeepLink, { kind: 'message' }> | null>(null);
  let pushToTalkCall: { call: VoiceCallState; restoreMuted: boolean } | null = null;
  let pushToTalkQueue = Promise.resolve();
  let lastUpdateVersion: string | null = null;

  const activeVoiceCall = $derived.by(() => {
    for (const server of serverRegistry.servers) {
      const voiceCall = serverRegistry.getStore(server.id).voiceCall;
      if (voiceCall.connected) return voiceCall;
    }
    return null;
  });

  const nativeUnreadCount = $derived(
    Math.min(
      9999,
      serverRegistry.servers.reduce(
        (count, server) =>
          count + serverRegistry.getStore(server.id).notifications.unreadNotificationCount,
        0
      )
    )
  );

  $effect(() => {
    if (!nativeClient) return;
    nativeClient.setBadgeCount(nativeUnreadCount, m['ui.notifications']());
    nativeClient.setTrayState({
      callActive: activeVoiceCall !== null,
      muted: activeVoiceCall?.isMuted ?? false,
      deafened: activeVoiceCall?.isDeafened ?? false,
      unreadCount: nativeUnreadCount,
      labels: {
        open: m['native.tray.open'](),
        mute: m['native.tray.mute'](),
        unmute: m['native.tray.unmute'](),
        deafen: m['native.tray.deafen'](),
        undeafen: m['native.tray.undeafen'](),
        quit: m['native.tray.quit']()
      }
    });
  });

  // Push translated screen-share picker labels to the shell. The picker is a
  // hardened main-process window and cannot read the renderer's i18n runtime,
  // so — like the tray labels above — we send the current locale's strings and
  // re-send whenever the locale changes (the `m[...]()` reads track it).
  $effect(() => {
    if (!nativeClient) return;
    nativeClient.setScreenShareLabels({
      title: m['native.screen_share.picker.title'](),
      subtitle: m['native.screen_share.picker.subtitle'](),
      audioShared: m['native.screen_share.picker.audio_shared'](),
      audioUnavailable: m['native.screen_share.picker.audio_unavailable'](),
      cancel: m['native.screen_share.picker.cancel']()
    });
  });

  $effect(() => {
    const link = pendingMessageLink;
    if (!link) return;
    const server = findServerByOrigin(link.serverUrl);
    if (!server) return;
    pendingMessageLink = null;
    addServerVisible = false;
    void navigateMessageLink(link, server.id);
  });

  onMount(() => {
    if (!nativeClient) return;
    const cleanups = [
      nativeClient.onTrayAction((action) => {
        if (action === 'open') return;
        const call = activeVoiceCall;
        if (!call) return;
        if (action === 'toggle-mute') void call.toggleMute();
        if (action === 'toggle-deafen') void call.toggleDeafen();
      }),
      nativeClient.onPushToTalk((event) => {
        pushToTalkQueue = pushToTalkQueue.then(() => handlePushToTalk(event)).catch(() => {});
      }),
      nativeClient.onNotificationAction((action) => {
        void handleNativeNotificationAction(action, appUi).catch(() => {});
      }),
      nativeClient.onDeepLink(handleDeepLink),
      nativeClient.onOAuthCallback(handleOAuthCallback),
      nativeClient.onUpdateState(handleUpdateState)
    ];

    nativeClient.rendererReady();
    void nativeClient
      .registerPushToTalk({ key: 'F8' })
      .then((result) => {
        if (!result.registered) toast.error(m['native.ptt.unavailable']());
      })
      .catch(() => toast.error(m['native.ptt.unavailable']()));
    void nativeClient.getUpdateState().then(handleUpdateState).catch(() => {});

    const stopFlashing = () => nativeClient.flashFrame(false);
    window.addEventListener('focus', stopFlashing);
    return () => {
      window.removeEventListener('focus', stopFlashing);
      for (const cleanup of cleanups) cleanup();
    };
  });

  async function handlePushToTalk(event: 'pressed' | 'released'): Promise<void> {
    if (event === 'pressed') {
      if (pushToTalkCall) return;
      const call = activeVoiceCall;
      if (!call) return;
      pushToTalkCall = { call, restoreMuted: call.isMuted };
      if (call.isMuted) await call.setMuted(false);
      return;
    }

    const held = pushToTalkCall;
    pushToTalkCall = null;
    if (held?.restoreMuted && held.call.connected) await held.call.setMuted(true);
  }

  function handleDeepLink(link: NativeDeepLink): void {
    if (link.kind === 'join') {
      addServerInitialUrl = link.serverUrl;
      addServerVisible = true;
      return;
    }

    const server = findServerByOrigin(link.serverUrl);
    if (!server) {
      pendingMessageLink = link;
      addServerInitialUrl = link.serverUrl;
      addServerVisible = true;
      return;
    }
    void navigateMessageLink(link, server.id);
  }

  async function navigateMessageLink(
    link: Extract<NativeDeepLink, { kind: 'message' }>,
    serverId: string
  ): Promise<void> {
    const stores = serverRegistry.getStore(serverId);
    prepareUiForNotificationTarget(appUi, serverId, { roomId: link.roomId });
    if (link.eventId) stores.pendingHighlights.set(link.roomId, link.threadId, link.eventId);

    const serverSegment = serverIdToSegment(serverId);
    const path = link.threadId
      ? resolve('/chat/[serverId]/[roomId]/[threadId]', {
          serverId: serverSegment,
          roomId: link.roomId,
          threadId: link.threadId
        })
      : resolve('/chat/[serverId]/[roomId]', {
          serverId: serverSegment,
          roomId: link.roomId
        });
    await goto(path);
  }

  function handleOAuthCallback(callback: NativeOAuthCallback): void {
    addServerVisible = false;
    const params = new SvelteURLSearchParams();
    if (callback.code) params.set('code', callback.code);
    if (callback.state) params.set('state', callback.state);
    if (callback.error) params.set('error', callback.error);
    if (callback.errorDescription) params.set('error_description', callback.errorDescription);
    void goto(resolve(`/servers/callback?${params}`));
  }

  function closeAddServer(): void {
    addServerVisible = false;
    pendingMessageLink = null;
  }

  function handleUpdateState(state: NativeUpdateState): void {
    if (state.kind !== 'downloaded' || state.version === lastUpdateVersion || !nativeClient) return;
    lastUpdateVersion = state.version;
    toast.info(m['ui.update_available'](), 0, {
      label: m['ui.reload'](),
      onClick: () => nativeClient.installUpdate()
    });
  }

  function findServerByOrigin(origin: string) {
    return serverRegistry.servers.find((server) => {
      try {
        return new URL(server.url).origin === origin;
      } catch {
        return false;
      }
    });
  }
</script>

{#if nativeClient}
  {#key addServerInitialUrl}
    <AddServerDialog
      bind:visible={addServerVisible}
      initialUrl={addServerInitialUrl}
      onclose={closeAddServer}
    />
  {/key}
{/if}
