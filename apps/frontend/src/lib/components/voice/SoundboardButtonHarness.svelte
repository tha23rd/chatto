<!--
@component

Test harness that mounts `VoiceCallPanel` in the one state where the in-call
soundboard is reachable: joined to the call, with LiveKit configured. That state
needs a registered origin server, a provided connection, presence/profile
caches, and a seeded per-server voice-call store, so it is assembled here rather
than in each test. Mirrors `VoiceCallPanelStoryHarness.svelte`, which does the
same job for Storybook.

Exists because e2e cannot cover this: the soundboard button is gated on
`voiceCallState.isInCall(roomId)`, which requires a real LiveKit WebRTC
connection that CI does not have.

**Props:**
- `serverId` - Registry id to seed; tests read the same server's soundboard store
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Component } from 'svelte';
  import type { CallParticipantInfo } from '$lib/state/server/voiceCall.svelte';
  import { createPresenceCache } from '$lib/state/presenceCache.svelte';
  import { createUserProfileCache } from '$lib/state/userProfiles.svelte';
  import { provideServerScope } from '$lib/state/server/scope.svelte';
  import { serverRegistry, type RegisteredServer } from '$lib/state/server/registry.svelte';
  import { serverConnectionManager } from '$lib/state/server/serverConnection.svelte';

  type VoiceCallPanelProps = {
    roomId: string;
    livekitUrl: string;
    layout?: 'sidebar' | 'stage';
  };

  let { serverId }: { serverId: string } = $props();

  const roomId = 'soundboard-test-room';
  createPresenceCache();
  createUserProfileCache();
  let Panel = $state<Component<VoiceCallPanelProps> | null>(null);

  function ensureServer(): RegisteredServer {
    // See VoiceCallPanelStoryHarness: the registry lists servers persisted by
    // other spec files but only creates their stores in init(), so call it
    // before any getStore() to avoid a cross-file "No store for server" throw.
    serverRegistry.init();
    const existingOrigin = serverRegistry.originServer;
    if (existingOrigin) return existingOrigin;
    const server: RegisteredServer = {
      id: serverId,
      source: 'local',
      // Must match window.location.origin so the registry treats it as the
      // origin server, which is what getActiveServer() falls back to without a
      // route parameter.
      url: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
      name: 'Soundboard Test',
      iconUrl: null,
      token: null,
      userId: 'viewer',
      userLogin: 'alice',
      userDisplayName: 'Alice',
      userAvatarUrl: null,
      reauthRequiredAt: null,
      addedAt: Date.now()
    };
    serverRegistry.addServer(server);
    return server;
  }

  // The panel reads the server scope while initialising, so provide it before
  // the lazy import resolves.
  provideServerScope({
    get serverId() {
      return ensureServer().id;
    },
    get connection() {
      return serverConnectionManager.getClient(ensureServer().id);
    },
    get store() {
      return serverRegistry.getStore(ensureServer().id);
    },
    isCurrent: () => true
  });

  function localParticipant(): CallParticipantInfo {
    return {
      identity: 'viewer',
      name: 'Alice',
      login: 'alice',
      avatarUrl: null,
      isMuted: false,
      isDeafened: false,
      isLocal: true,
      connectionQuality: 'excellent',
      isCameraEnabled: false,
      videoTrack: null,
      isScreenShareEnabled: false,
      screenShareTrack: null,
      hasScreenShareAudio: false,
      isLocallyMuted: false,
      localVolume: 100,
      localScreenShareVolume: 100,
      isCameraWatched: true,
      isScreenShareWatched: true
    };
  }

  onMount(async () => {
    const server = ensureServer();
    const store = serverRegistry.getStore(server.id);
    // isInCall(roomId) is `connected && roomId === roomId`; both are required
    // for the panel to treat the soundboard as configured.
    store.voiceCall.roomId = roomId;
    store.voiceCall.connected = true;
    store.voiceCall.connecting = false;
    store.voiceCall.participants = [localParticipant()];
    Panel = (await import('./VoiceCallPanel.svelte')).default as Component<VoiceCallPanelProps>;
  });
</script>

{#if Panel}
  <Panel {roomId} livekitUrl="wss://livekit.invalid" layout="stage" />
{/if}
