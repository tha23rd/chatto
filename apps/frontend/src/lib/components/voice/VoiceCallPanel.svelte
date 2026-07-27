<!--
@component

Room sidebar panel for voice/video calls.

**Two modes:**
- **Observer mode**: Call is active but user hasn't joined. Shows participants
  from server state and a Join button.
- **Participant mode**: User is connected to LiveKit. Shows live audio levels,
  mute toggle, camera/screen-share controls, audio device selector, and hang-up button.

**Props:**
- `roomId` - The room ID
- `livekitUrl` - The LiveKit server WebSocket URL (needed for joining)
-->
<script lang="ts">
  import { serverRegistry } from '$lib/state/server/registry.svelte';
  import { getServerPermissions } from '$lib/state/server/permissions.svelte';
  import { getActiveServer } from '$lib/state/activeServer.svelte';
  import { userPreferences } from '$lib/state/userPreferences.svelte';
  import * as m from '$lib/i18n/messages';

  const stores = serverRegistry.getStore(getActiveServer());
  const voiceCallState = stores.voiceCall;
  const activeCallRooms = stores.activeCallRooms;

  // Shared per-server soundboard catalog. Loaded lazily once the viewer is in
  // the call; the in-call panel plays these into the LiveKit room.
  const soundboardStore = getSoundboard(getActiveServer());
  const connection = useConnection();
  import type { PresenceStatus } from '$lib/render/types';
  import UserAvatar from '$lib/components/UserAvatar.svelte';
  import VideoThumbnail from './VideoThumbnail.svelte';
  import AudioDeviceMenu from './AudioDeviceMenu.svelte';
  import CallTileActionButton from './CallTileActionButton.svelte';
  import CallTileActionToolbar from './CallTileActionToolbar.svelte';
  import ParticipantVolumePopover from './ParticipantVolumePopover.svelte';
  import StreamQualityPopover from './StreamQualityPopover.svelte';
  import SoundboardPopover from './SoundboardPopover.svelte';
  import UserContextMenu from '$lib/components/menus/UserContextMenu.svelte';
  import { getVoiceCallJoinErrorMessage } from '$lib/state/server/voiceCall.svelte';
  import { getSoundboard } from '$lib/state/soundboard.svelte';
  import type { Sound } from '$lib/api-client/soundboard';
  import { useConnection } from '$lib/state/server/connection.svelte';
  import type { Track } from 'livekit-client';
  import type { Attachment } from 'svelte/attachments';
  import { startDMWith } from '$lib/dm/startDM';
  import { toast } from '$lib/ui/toast';
  import {
    isPictureInPictureAvailable,
    togglePictureInPicture
  } from '$lib/voice/pictureInPicture';
  import { roleColorToCSS } from '$lib/roleColors';

  let {
    roomId,
    livekitUrl,
    layout = 'sidebar'
  }: {
    roomId: string;
    livekitUrl: string;
    layout?: 'sidebar' | 'stage';
  } = $props();

  let isInThisCall = $derived(voiceCallState.isInCall(roomId));
  let isInAnotherCall = $derived(voiceCallState.isInAnyCall && !isInThisCall);
  let isConnecting = $derived(voiceCallState.connecting && voiceCallState.roomId === roomId);
  let hasActiveCall = $derived(activeCallRooms.has(roomId));
  let roomMembers = $derived(
    stores.rooms?.rooms?.find((room) => room.id === roomId)?.members ?? []
  );
  let isStageLayout = $derived(layout === 'stage');
  let deviceMenuAnchor = $state<{ top: number; bottom: number; left: number } | null>(null);

  /** Unified participant shape for rendering (structural data only). */
  type DisplayParticipant = {
    key: string;
    displayName: string;
    avatarUser: {
      id: string;
      login: string;
      displayName: string;
      avatarUrl: string | null;
      presenceStatus: PresenceStatus;
      roleColor?: number | null;
    };
    isMuted: boolean;
    isDeafened: boolean;
    isLocal: boolean;
    isLocallyMuted: boolean;
    volume: number;
    /** Playback volume for this participant's screen-share audio, independent of `volume`. */
    screenShareVolume: number;
    /** Whether they publish stream audio at all; the stream fader is pointless without it. */
    hasScreenShareAudio: boolean;
    connectionQuality: string;
    isCameraEnabled: boolean;
    videoTrack: Track | null;
    isScreenShareEnabled: boolean;
    screenShareTrack: Track | null;
  };

  let participants: DisplayParticipant[] = $derived.by(() => {
    if (isInThisCall) {
      return voiceCallState.participants.map((p) => ({
        key: p.identity,
        displayName: p.name,
        avatarUser: {
          id: p.identity,
          login: p.login,
          displayName: p.name,
          avatarUrl: p.avatarUrl,
          presenceStatus: 'ONLINE' as PresenceStatus,
          roleColor: roomMembers.find((member) => member.id === p.identity)?.roleColor ?? null
        },
        isMuted: p.isMuted,
        isDeafened: p.isDeafened,
        isLocal: p.isLocal,
        isLocallyMuted: p.isLocallyMuted ?? false,
        volume: p.localVolume ?? 100,
        screenShareVolume: p.localScreenShareVolume ?? 100,
        hasScreenShareAudio: p.hasScreenShareAudio ?? false,
        connectionQuality: p.connectionQuality,
        isCameraEnabled: p.isCameraEnabled,
        videoTrack: p.videoTrack,
        isScreenShareEnabled: p.isScreenShareEnabled,
        screenShareTrack: p.screenShareTrack
      }));
    }

    return activeCallRooms.getParticipants(roomId).map((p) => ({
      key: p.userId,
      displayName: p.displayName,
      avatarUser: {
        id: p.userId,
        login: p.login,
        displayName: p.displayName,
        avatarUrl: p.avatarUrl,
        presenceStatus: 'ONLINE' as PresenceStatus,
        roleColor: roomMembers.find((member) => member.id === p.userId)?.roleColor ?? null
      },
      isMuted: false,
      isDeafened: false,
      isLocal: false,
      isLocallyMuted: false,
      volume: 100,
      screenShareVolume: 100,
      hasScreenShareAudio: false,
      connectionQuality: 'unknown',
      isCameraEnabled: false,
      videoTrack: null,
      isScreenShareEnabled: false,
      screenShareTrack: null
    }));
  });

  let sortedParticipants = $derived(
    [...participants].sort((a, b) => {
      if (a.isCameraEnabled && a.videoTrack && !(b.isCameraEnabled && b.videoTrack)) return -1;
      if (b.isCameraEnabled && b.videoTrack && !(a.isCameraEnabled && a.videoTrack)) return 1;
      return 0;
    })
  );
  let screenShareParticipants = $derived(
    sortedParticipants.filter((p) => p.isScreenShareEnabled && p.screenShareTrack)
  );
  let videoParticipants = $derived(
    sortedParticipants.filter((p) => p.isCameraEnabled && p.videoTrack)
  );
  let mediaTileCount = $derived(screenShareParticipants.length + videoParticipants.length);
  type StageTile = {
    key: string;
    kind: 'screen' | 'video' | 'voice';
    participant: DisplayParticipant;
  };
  let screenShareTiles = $derived(
    screenShareParticipants.map((participant) => ({
      key: `${participant.key}:screen`,
      kind: 'screen' as const,
      participant
    }))
  );
  let participantTiles = $derived(
    sortedParticipants.map((participant) => ({
      key: `${participant.key}:${hasVideo(participant) ? 'video' : 'voice'}`,
      kind: hasVideo(participant) ? ('video' as const) : ('voice' as const),
      participant
    }))
  );
  let stageTiles = $derived([...screenShareTiles, ...participantTiles]);
  let featuredStageTile = $derived(
    screenShareTiles[0] ??
      participantTiles.find((tile) => tile.kind === 'video') ??
      participantTiles[0]
  );
  let secondaryStageTiles = $derived(
    featuredStageTile ? stageTiles.filter((tile) => tile.key !== featuredStageTile.key) : []
  );
  let isIdle = $derived(!hasActiveCall && !isInThisCall);
  let joinLabel = $derived.by(() => {
    if (isConnecting) return hasActiveCall ? m['voice.joining']() : m['voice.starting']();
    return hasActiveCall ? m['voice.join_call']() : m['voice.start_call']();
  });
  const controlButtonClass = 'btn-secondary btn-sm h-9 w-full !px-0';
  const activeControlButtonClass = 'btn-success btn-sm h-9 w-full !px-0';
  const dangerControlButtonClass = 'btn-danger btn-sm h-9 w-full !px-0';
  const callTileCardClass =
    'call-speaking-card participant-card group/media relative flex w-full flex-col gap-2 overflow-hidden rounded-lg border border-text/10 bg-surface p-1.5 text-left text-text shadow-sm transition-colors hover:bg-surface-emphasized/70';
  const callTileHeaderClass = 'flex min-w-0 items-center gap-2';
  const callTileIdentityButtonClass =
    'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left text-text outline-none transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-action';
  const callTileMediaButtonClass =
    'flex w-full flex-1 cursor-pointer flex-col overflow-hidden rounded-sm text-left text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-action';

  function hasVideo(participant: DisplayParticipant) {
    return participant.isCameraEnabled && participant.videoTrack;
  }

  function hasScreenShare(participant: DisplayParticipant) {
    return participant.isScreenShareEnabled && participant.screenShareTrack;
  }

  function hasConnectionWarning(participant: DisplayParticipant) {
    return participant.connectionQuality === 'poor' || participant.connectionQuality === 'lost';
  }

  function participantTitle(participant: DisplayParticipant) {
    if (isInThisCall && hasConnectionWarning(participant)) {
      return `${participant.displayName} — poor connection`;
    }

    return participant.displayName;
  }

  const speakingCards: Array<{ identity: string; node: HTMLElement }> = [];
  let speakingIndicatorInterval: ReturnType<typeof setInterval> | null = null;

  function updateSpeakingIndicators() {
    for (const { identity, node } of speakingCards) {
      const { isSpeaking, audioLevel } = voiceCallState.getAudioLevel(identity);
      // Playing a soundboard clip lights up the tile like speech, so you can
      // see who triggered a sound even if they aren't talking.
      const soundboardActive = voiceCallState.isSoundboardActive(identity);
      const opacity = audioLevel > 0.01 ? 0.35 + Math.pow(audioLevel, 0.35) * 0.65 : 0;
      const visible = isSpeaking || opacity > 0 || soundboardActive;

      const ringOpacity = soundboardActive ? 0.95 : opacity || 0.85;
      const ringStrength = soundboardActive ? Math.max(audioLevel, 0.9) : audioLevel;

      node.style.setProperty('--call-speaking-ring-opacity', visible ? String(ringOpacity) : '0');
      node.style.setProperty('--call-speaking-ring-strength', visible ? String(ringStrength) : '0');
      node.dataset.callSpeaking = visible ? 'true' : 'false';
    }
  }

  function startSpeakingIndicatorLoop() {
    if (speakingIndicatorInterval) return;

    speakingIndicatorInterval = setInterval(updateSpeakingIndicators, 60);
  }

  function stopSpeakingIndicatorLoopIfIdle() {
    if (speakingCards.length > 0 || !speakingIndicatorInterval) return;

    clearInterval(speakingIndicatorInterval);
    speakingIndicatorInterval = null;
  }

  function speakingCard(identity: string): Attachment<HTMLElement> {
    return (node) => {
      const entry = { identity, node };
      speakingCards.push(entry);
      updateSpeakingIndicators();
      startSpeakingIndicatorLoop();

      return () => {
        const index = speakingCards.indexOf(entry);
        if (index !== -1) speakingCards.splice(index, 1);
        stopSpeakingIndicatorLoopIfIdle();
      };
    };
  }

  // Re-apply the listener-side soundboard volume/mute to any live soundboard
  // tracks whenever the preference changes while a call is running.
  $effect(() => {
    void userPreferences.soundboardPlaybackGain;
    voiceCallState.refreshSoundboardPlaybackVolume();
  });

  // DM start capability
  const serverPerms = getServerPermissions();
  const canStartDMs = $derived(serverPerms.current.canStartDMs);

  // User context menu popover
  let popoverParticipant = $state<DisplayParticipant | null>(null);
  let popoverAnchorRect = $state<{ top: number; bottom: number; left: number } | null>(null);

  function showUserMenu(participant: DisplayParticipant, e: MouseEvent) {
    const button = (e.target as HTMLElement).closest('button');
    const rect = button?.getBoundingClientRect();
    if (!rect) return;
    popoverParticipant = participant;
    popoverAnchorRect = { top: rect.top, bottom: rect.bottom, left: rect.left };
  }

  function closeUserMenu() {
    popoverParticipant = null;
    popoverAnchorRect = null;
  }

  // Per-participant volume popover. Track by key and derive the live participant
  // so the popover's percentage readout and slider follow store updates while
  // dragging (a captured snapshot would freeze at the value it was opened with),
  // and the popover auto-dismisses if the participant leaves mid-adjust.
  let volumePopoverKey = $state<string | null>(null);
  let volumeAnchorRect = $state<{ top: number; bottom: number; left: number } | null>(null);
  let volumePopoverParticipant = $derived(
    volumePopoverKey === null
      ? null
      : (participants.find((p) => p.key === volumePopoverKey) ?? null)
  );

  function openVolumePopover(participant: DisplayParticipant, event: MouseEvent) {
    event.stopPropagation();
    const button = event.currentTarget as HTMLElement;
    const rect = button.getBoundingClientRect();
    volumePopoverKey = participant.key;
    volumeAnchorRect = { top: rect.top, bottom: rect.bottom, left: rect.left };
  }

  function closeVolumePopover() {
    volumePopoverKey = null;
    volumeAnchorRect = null;
  }

  function onVolumeInput(participant: DisplayParticipant, event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    voiceCallState.setParticipantVolume(participant.key, value);
  }

  function onScreenShareVolumeInput(participant: DisplayParticipant, event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    voiceCallState.setParticipantScreenShareVolume(participant.key, value);
  }

  // Stream-quality popover. The Share Screen button is the only entry point, in both states,
  // so a live share does not add a second gear beside the call's device gear:
  //  - 'preflight' before capture, shown *before* getDisplayMedia() so the user picks quality
  //    then confirms, mirroring Discord's Go Live dialog. A browser cannot put these controls
  //    inside Chrome's own window picker, so they sit immediately before it.
  //  - 'live' while sharing, which retunes the running share and offers Stop sharing.
  let streamQualityAnchor = $state<{ top: number; bottom: number; left: number } | null>(null);
  let streamQualityMode = $state<'preflight' | 'live'>('preflight');

  function openStreamQuality(event: MouseEvent, mode: 'preflight' | 'live') {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    streamQualityMode = mode;
    streamQualityAnchor = { top: rect.top, bottom: rect.bottom, left: rect.left };
  }

  function closeStreamQuality() {
    streamQualityAnchor = null;
  }

  function onScreenShareClick(event: MouseEvent) {
    // One control for the whole stream, in both states: the menu carries the quality
    // settings plus the primary action (Go Live, or Stop while sharing). Keeping stop
    // inside the menu is what lets the separate stream-settings gear go away, so the
    // toolbar is not showing two gears during a share.
    openStreamQuality(event, voiceCallState.isScreenShareEnabled ? 'live' : 'preflight');
  }

  function onStreamQualityGoLive() {
    closeStreamQuality();
    voiceCallState.toggleScreenShare();
  }

  function onStreamQualityStop() {
    closeStreamQuality();
    voiceCallState.toggleScreenShare();
  }

  // Soundboard. Only meaningful once joined to the call and only when LiveKit
  // is configured (playback publishes into the room). The catalog loads lazily
  // on first join so observers don't fetch it.
  const sounds = $derived(soundboardStore.sounds);
  const soundboardConfigured = $derived(isInThisCall && livekitUrl.length > 0);

  $effect(() => {
    if (!soundboardConfigured) return;
    const conn = connection();
    void soundboardStore.ensureLoaded({
      serverId: conn.serverId,
      baseUrl: conn.connectBaseUrl,
      bearerToken: conn.bearerToken
    });
  });

  const showSoundboardButton = $derived(soundboardConfigured && sounds.length > 0);

  let soundboardAnchor = $state<{ top: number; bottom: number; left: number } | null>(null);

  function toggleSoundboard(event: MouseEvent) {
    if (soundboardAnchor) {
      closeSoundboard();
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    soundboardAnchor = { top: rect.top, bottom: rect.bottom, left: rect.left };
  }

  function closeSoundboard() {
    soundboardAnchor = null;
  }

  async function onPlaySound(sound: Sound) {
    const result = await voiceCallState.playSoundIntoCall({ url: sound.url, volume: sound.volume });
    if (result === 'failed') {
      toast.error(m['soundboard.play_failed']());
    }
    // 'throttled' feedback is surfaced inline by the popover via the store flag.
  }

  function openDeviceMenu(e: MouseEvent) {
    const button = e.currentTarget as HTMLElement;
    const rect = button.getBoundingClientRect();
    voiceCallState.refreshDevices();
    deviceMenuAnchor = { top: rect.top, bottom: rect.bottom, left: rect.left };
  }

  async function handleJoin() {
    try {
      await voiceCallState.join(livekitUrl, roomId);
    } catch (err) {
      stores.handleVoiceCallJoinFailed(roomId);
      toast.error(getVoiceCallJoinErrorMessage(err));
    }
  }

  // Whether this host can float a feed above other windows at all. The desktop client's
  // webview has no video context menu of its own, so the pop-out control is the only way
  // there; WebKit-based webviews have no API to offer, so the control is hidden instead of
  // failing. Read once because a document does not gain the API at runtime.
  const canPopOutFeeds = isPictureInPictureAvailable(
    typeof document === 'undefined' ? null : document
  );

  function mediaCardVideo(target: HTMLElement): HTMLVideoElement | null {
    return target.closest<HTMLElement>('[data-call-media-card]')?.querySelector('video') ?? null;
  }

  // Nothing may be awaited before togglePictureInPicture: the request inside it needs the
  // click's user activation, and Chromium rejects it after any async hop.
  async function popOutClosestMedia(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const result = await togglePictureInPicture(
      mediaCardVideo(event.currentTarget as HTMLElement),
      document
    );
    if (result === 'failed' || result === 'unsupported') {
      toast.error(m['voice.pop_out_failed']());
    }
  }

  async function toggleFullscreenElement(element: HTMLElement | null): Promise<void> {
    if (!element || typeof document === 'undefined') return;

    try {
      if (document.fullscreenElement === element) {
        await document.exitFullscreen();
      } else {
        await element.requestFullscreen();
      }
    } catch {
      // Browsers can reject fullscreen requests when system policy denies them.
    }
  }

  function toggleClosestMediaFullscreen(event: MouseEvent): void {
    event.stopPropagation();
    const mediaCard = (event.currentTarget as HTMLElement).closest<HTMLElement>(
      '[data-call-media-card]'
    );
    void toggleFullscreenElement(mediaCard);
  }

  function toggleFeedMute(participant: DisplayParticipant, event: MouseEvent): void {
    event.stopPropagation();
    if (participant.isLocal) {
      void voiceCallState.toggleMute();
    } else {
      voiceCallState.toggleParticipantLocalMute(participant.key);
    }
  }
</script>

{#snippet localMuteButton(participant: DisplayParticipant)}
  {@const isMutedForViewer = participant.isLocal
    ? voiceCallState.isMuted
    : participant.isLocallyMuted}
  <CallTileActionButton
    icon={isMutedForViewer ? 'uil--volume-mute' : 'uil--volume-up'}
    active={isMutedForViewer}
    label={participant.isLocal
      ? isMutedForViewer
        ? m['voice.unmute']()
        : m['voice.mute']()
      : isMutedForViewer
        ? m['voice.locally_unmute_participant']()
        : m['voice.locally_mute_participant']()}
    testId="call-feed-local-mute-button"
    onclick={(event) => toggleFeedMute(participant, event)}
  />
{/snippet}

{#snippet mediaTileActions(participant: DisplayParticipant)}
  <CallTileActionToolbar testId="call-media-actions">
    {#if canPopOutFeeds}
      <CallTileActionButton
        icon="mdi--picture-in-picture-bottom-right"
        label={m['voice.pop_out_feed']()}
        testId="call-feed-pop-out-button"
        onclick={(event) => void popOutClosestMedia(event)}
      />
    {/if}
    <CallTileActionButton
      icon="mdi--fullscreen"
      label={m['voice.fullscreen_feed']()}
      testId="call-feed-fullscreen-button"
      onclick={toggleClosestMediaFullscreen}
    />
    {#if isInThisCall}
      {@render localMuteButton(participant)}
      {#if !participant.isLocal}
        <CallTileActionButton
          icon="uil--volume"
          label={m['voice.participant_volume']()}
          active={volumePopoverParticipant?.key === participant.key}
          testId="call-feed-volume-button"
          onclick={(event) => openVolumePopover(participant, event)}
        />
      {/if}
    {/if}
  </CallTileActionToolbar>
{/snippet}

{#snippet voiceTileActions(participant: DisplayParticipant)}
  {#if isInThisCall}
    <CallTileActionToolbar testId="call-voice-actions">
      {@render localMuteButton(participant)}
      {#if !participant.isLocal}
        <CallTileActionButton
          icon="uil--volume"
          label={m['voice.participant_volume']()}
          active={volumePopoverParticipant?.key === participant.key}
          testId="call-feed-volume-button"
          onclick={(event) => openVolumePopover(participant, event)}
        />
      {/if}
    </CallTileActionToolbar>
  {/if}
{/snippet}

{#snippet participantIndicators(participant: DisplayParticipant)}
  <span class="inline-flex h-5 min-w-5 shrink-0 items-center justify-end gap-1.5 text-sm">
    {#if participant.isMuted}
      <span
        class="iconify text-danger uil--microphone-slash"
        aria-label={m['voice.muted']()}
        data-testid="call-muted-indicator"
      ></span>
    {/if}
    {#if participant.isDeafened}
      <span
        class="iconify text-danger uil--headphone-slash"
        aria-label={m['voice.deafened']()}
        data-testid="call-deafened-indicator"
      ></span>
    {/if}
    {#if participant.isLocallyMuted}
      <span
        class="iconify text-muted uil--volume-mute"
        aria-label={m['voice.locally_muted']()}
        data-testid="call-locally-muted-indicator"
      ></span>
    {/if}
    {#if hasConnectionWarning(participant)}
      <span
        class={[
          'iconify uil--exclamation-triangle',
          participant.connectionQuality === 'lost' && 'text-danger',
          participant.connectionQuality === 'poor' && 'text-warning'
        ]}
        aria-label={m['voice.poor_connection']()}
      ></span>
    {/if}
  </span>
{/snippet}

{#snippet participantHeader(
  participant: DisplayParticipant,
  label: string,
  actions: 'media' | 'voice' | 'none',
  showIndicators = true
)}
  <div class={callTileHeaderClass}>
    <button
      type="button"
      class={callTileIdentityButtonClass}
      onclick={(e) => showUserMenu(participant, e)}
    >
      <UserAvatar user={participant.avatarUser} size="sm" />
      <span
        class="min-w-0 flex-1 truncate text-sm font-medium"
        style:color={roleColorToCSS(participant.avatarUser.roleColor)}>{label}</span
      >
      {#if showIndicators}
        {@render participantIndicators(participant)}
      {/if}
    </button>

    {#if actions === 'media'}
      {@render mediaTileActions(participant)}
    {:else if actions === 'voice'}
      {@render voiceTileActions(participant)}
    {/if}
  </div>
{/snippet}

{#snippet participantCard(participant: DisplayParticipant, mode: 'compact' | 'video')}
  {@const showVideo = mode === 'video' && hasVideo(participant)}
  {@const showVoiceActions = isInThisCall && !showVideo}
  {@const actions = showVideo ? 'media' : showVoiceActions ? 'voice' : 'none'}
  {#if isInThisCall}
    <div
      class={[
        callTileCardClass,
        mode === 'video' ? 'participant-card-video' : 'participant-card-compact'
      ]}
      {@attach speakingCard(participant.key)}
      title={participantTitle(participant)}
      data-testid="call-participant-card"
      data-speaking-ring
      data-call-media-card={showVideo ? true : undefined}
    >
      {@render participantHeader(participant, participant.displayName, actions)}

      {#if showVideo}
        <button
          type="button"
          class={callTileMediaButtonClass}
          onclick={(e) => showUserMenu(participant, e)}
        >
          <VideoThumbnail
            track={participant.videoTrack!}
            name={participant.displayName}
            user={participant.avatarUser}
            showIdentityOverlay={false}
          />
        </button>
      {/if}
    </div>
  {:else}
    <div
      class={[
        callTileCardClass,
        mode === 'video' ? 'participant-card-video' : 'participant-card-compact'
      ]}
      title={participantTitle(participant)}
      data-testid="call-participant-card"
      data-call-media-card={showVideo ? true : undefined}
    >
      {@render participantHeader(participant, participant.displayName, 'none', false)}

      {#if showVideo}
        <button
          type="button"
          class={callTileMediaButtonClass}
          onclick={(e) => showUserMenu(participant, e)}
        >
          <VideoThumbnail
            track={participant.videoTrack!}
            name={participant.displayName}
            user={participant.avatarUser}
            showIdentityOverlay={false}
          />
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet screenShareCard(participant: DisplayParticipant)}
  <div
    class={[callTileCardClass, 'participant-card-video @min-[368px]:col-span-2']}
    {@attach isInThisCall && speakingCard(participant.key)}
    title={m['voice.screen_title']({ name: participant.displayName })}
    data-testid="call-screen-share-card"
    data-speaking-ring={isInThisCall ? true : undefined}
    data-call-media-card
  >
    {@render participantHeader(
      participant,
      m['voice.screen_title']({ name: participant.displayName }),
      'media',
      false
    )}
    <button
      type="button"
      class={callTileMediaButtonClass}
      onclick={(e) => showUserMenu(participant, e)}
    >
      <VideoThumbnail
        track={participant.screenShareTrack!}
        name={m['voice.screen_title']({ name: participant.displayName })}
        user={participant.avatarUser}
        showIdentityOverlay={false}
        fit="contain"
      />
    </button>
  </div>
{/snippet}

{#snippet featuredStageCard(tile: StageTile)}
  {@const participant = tile.participant}
  {@const isScreen = tile.kind === 'screen'}
  {@const isVideo = tile.kind === 'video'}
  <div
    class={[callTileCardClass, 'participant-card-video h-full min-h-0']}
    {@attach isInThisCall && speakingCard(participant.key)}
    title={isScreen
      ? m['voice.screen_title']({ name: participant.displayName })
      : participantTitle(participant)}
    data-testid="call-featured-stage-card"
    data-speaking-ring={isInThisCall ? true : undefined}
    data-call-media-card={isScreen || isVideo ? true : undefined}
  >
    {@render participantHeader(
      participant,
      isScreen
        ? m['voice.screen_title']({ name: participant.displayName })
        : participant.displayName,
      isScreen || isVideo ? 'media' : 'voice',
      true
    )}
    <button
      type="button"
      class={[
        callTileMediaButtonClass,
        'min-h-0 items-center justify-center',
        !isScreen && !isVideo && 'p-6'
      ]}
      onclick={(e) => showUserMenu(participant, e)}
    >
      {#if isScreen}
        <VideoThumbnail
          track={participant.screenShareTrack!}
          name={m['voice.screen_title']({ name: participant.displayName })}
          user={participant.avatarUser}
          showIdentityOverlay={false}
          fit="contain"
          fill
        />
      {:else if isVideo}
        <VideoThumbnail
          track={participant.videoTrack!}
          name={participant.displayName}
          user={participant.avatarUser}
          showIdentityOverlay={false}
          fill
        />
      {:else}
        <div class="flex min-w-0 flex-col items-center gap-4">
          <UserAvatar user={participant.avatarUser} size="xl" showPresence={false} />
          <span class="max-w-full truncate text-lg font-semibold">{participant.displayName}</span>
        </div>
      {/if}
    </button>
  </div>
{/snippet}

{#snippet stageTile(tile: StageTile)}
  {#if tile.kind === 'screen'}
    {@render screenShareCard(tile.participant)}
  {:else}
    {@render participantCard(tile.participant, tile.kind === 'video' ? 'video' : 'compact')}
  {/if}
{/snippet}

{#snippet callControls()}
  {#if isInThisCall}
    <div class={isStageLayout ? 'mx-auto max-w-2xl' : ''}>
      <div class="grid grid-flow-col auto-cols-fr gap-2">
        <button
          type="button"
          class={controlButtonClass}
          title={m['voice.devices']()}
          aria-label={m['voice.devices']()}
          data-testid="call-device-menu-button"
          onclick={openDeviceMenu}
        >
          <span class="iconify text-lg uil--setting" aria-hidden="true"></span>
        </button>

        <button
          type="button"
          class={voiceCallState.isCameraEnabled ? activeControlButtonClass : controlButtonClass}
          title={voiceCallState.isCameraEnabled
            ? m['voice.turn_off_camera']()
            : m['voice.turn_on_camera']()}
          aria-label={voiceCallState.isCameraEnabled
            ? m['voice.turn_off_camera']()
            : m['voice.turn_on_camera']()}
          data-testid="call-camera-toggle"
          onclick={() => voiceCallState.toggleCamera()}
          disabled={voiceCallState.isCameraPending}
          aria-busy={voiceCallState.isCameraPending || undefined}
        >
          {#if voiceCallState.isCameraPending}
            <span class="iconify animate-spin text-lg uil--spinner" aria-hidden="true"></span>
          {:else}
            <span
              class={[
                'iconify text-lg',
                voiceCallState.isCameraEnabled ? 'uil--video' : 'uil--video-slash'
              ]}
              aria-hidden="true"
            ></span>
          {/if}
        </button>

        <button
          type="button"
          class={voiceCallState.isMuted ? controlButtonClass : activeControlButtonClass}
          title={voiceCallState.isMuted ? m['voice.unmute']() : m['voice.mute']()}
          aria-label={voiceCallState.isMuted ? m['voice.unmute']() : m['voice.mute']()}
          data-testid="call-mute-toggle"
          onclick={() => voiceCallState.toggleMute()}
          disabled={voiceCallState.isMicrophonePending}
          aria-busy={voiceCallState.isMicrophonePending || undefined}
        >
          {#if voiceCallState.isMicrophonePending}
            <span class="iconify animate-spin text-lg uil--spinner" aria-hidden="true"></span>
          {:else}
            <span
              class={[
                'iconify text-lg',
                voiceCallState.isMuted ? 'uil--microphone-slash' : 'uil--microphone'
              ]}
              aria-hidden="true"
            ></span>
          {/if}
        </button>

        <button
          type="button"
          class={voiceCallState.isDeafened ? controlButtonClass : activeControlButtonClass}
          title={voiceCallState.isDeafened ? m['voice.undeafen']() : m['voice.deafen']()}
          aria-label={voiceCallState.isDeafened ? m['voice.undeafen']() : m['voice.deafen']()}
          aria-pressed={voiceCallState.isDeafened}
          data-testid="call-deafen-toggle"
          onclick={() => voiceCallState.toggleDeafen()}
          disabled={voiceCallState.isDeafenPending}
          aria-busy={voiceCallState.isDeafenPending || undefined}
        >
          {#if voiceCallState.isDeafenPending}
            <span class="iconify animate-spin text-lg uil--spinner" aria-hidden="true"></span>
          {:else}
            <span
              class={[
                'iconify text-lg',
                voiceCallState.isDeafened ? 'uil--headphone-slash' : 'uil--headphones'
              ]}
              aria-hidden="true"
            ></span>
          {/if}
        </button>

        <button
          type="button"
          class={voiceCallState.isScreenShareEnabled
            ? activeControlButtonClass
            : controlButtonClass}
          title={voiceCallState.isScreenShareEnabled
            ? m['voice.stream_quality_settings']()
            : m['voice.share_screen']()}
          aria-label={voiceCallState.isScreenShareEnabled
            ? m['voice.stream_quality_settings']()
            : m['voice.share_screen']()}
          aria-haspopup="dialog"
          aria-expanded={!!streamQualityAnchor}
          data-testid="call-screen-share-toggle"
          onclick={onScreenShareClick}
          disabled={voiceCallState.isScreenSharePending}
          aria-busy={voiceCallState.isScreenSharePending || undefined}
        >
          {#if voiceCallState.isScreenSharePending}
            <span class="iconify animate-spin text-lg uil--spinner" aria-hidden="true"></span>
          {:else}
            <span class="iconify text-lg uil--desktop" aria-hidden="true"></span>
          {/if}
        </button>

        {#if showSoundboardButton}
          <button
            type="button"
            class={soundboardAnchor ? activeControlButtonClass : controlButtonClass}
            title={m['soundboard.panel_button']()}
            aria-label={m['soundboard.panel_button']()}
            aria-pressed={!!soundboardAnchor}
            data-testid="call-soundboard-button"
            onclick={toggleSoundboard}
          >
            <span class="iconify text-lg uil--music" aria-hidden="true"></span>
          </button>
        {/if}

        <button
          type="button"
          class={dangerControlButtonClass}
          onclick={() => voiceCallState.leave()}
          title={m['voice.leave']()}
          aria-label={m['voice.leave']()}
          data-testid="call-leave-button"
        >
          <span class="iconify text-lg uil--phone-slash" aria-hidden="true"></span>
        </button>
      </div>
    </div>
  {:else}
    <div class={isStageLayout ? 'mx-auto max-w-sm' : ''}>
      <button
        type="button"
        class="btn-action w-full btn-sm"
        data-testid="call-join-button"
        onclick={handleJoin}
        disabled={isInAnotherCall || isConnecting}
        title={isInAnotherCall ? m['voice.already_in_another_call']() : joinLabel}
      >
        {joinLabel}
      </button>
    </div>
  {/if}
{/snippet}

<div
  class="flex min-h-0 flex-1 flex-col"
  data-testid={isInThisCall ? 'call-participant-panel' : 'call-observer-panel'}
>
  {#if !isStageLayout}
    <div class="border-b border-border bg-background p-3" data-testid="call-controls-bar">
      {@render callControls()}
    </div>
  {/if}

  <div
    class={[
      'flex min-h-0 flex-1 flex-col gap-5',
      isStageLayout ? 'p-4' : 'p-3',
      isStageLayout ? 'overflow-hidden' : 'overflow-y-auto'
    ]}
  >
    {#if !isIdle}
      {#if isStageLayout && featuredStageTile}
        <section
          class="flex min-h-0 flex-1 flex-col gap-3"
          aria-label={m['voice.participants']()}
          data-testid="call-stage-layout"
        >
          <div class="flex min-h-0 flex-1" data-testid="call-featured-stage">
            {@render featuredStageCard(featuredStageTile)}
          </div>

          {#if secondaryStageTiles.length > 0}
            <div
              class="flex max-h-[190px] shrink-0 flex-wrap content-start justify-center gap-3 overflow-y-auto"
              data-testid="call-secondary-stage-list"
            >
              {#each secondaryStageTiles as tile (tile.key)}
                <div class="w-[clamp(180px,22vw,240px)] max-w-full min-w-0">
                  {@render stageTile(tile)}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else}
        <section class="@container flex flex-col gap-2" aria-label={m['voice.participants']()}>
          <div
            class={[
              'grid grid-cols-1 gap-3',
              isInThisCall && mediaTileCount > 1 && '@min-[368px]:grid-cols-2'
            ]}
            data-testid="call-participants-list"
          >
            {#each screenShareParticipants as participant (`${participant.key}:screen`)}
              {#if hasScreenShare(participant)}
                {@render screenShareCard(participant)}
              {/if}
            {/each}
            {#each sortedParticipants as participant (participant.key)}
              {@render participantCard(
                participant,
                isInThisCall && hasVideo(participant) ? 'video' : 'compact'
              )}
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </div>

  {#if isStageLayout}
    <div class="border-t border-border bg-background p-3" data-testid="call-controls-bar">
      {@render callControls()}
    </div>
  {/if}
</div>

{#if deviceMenuAnchor}
  <AudioDeviceMenu anchor={deviceMenuAnchor} onclose={() => (deviceMenuAnchor = null)} />
{/if}

{#if popoverParticipant && popoverAnchorRect}
  <UserContextMenu
    user={popoverParticipant.avatarUser}
    anchorRect={popoverAnchorRect}
    canSendMessage={canStartDMs}
    onSendMessage={() => startDMWith(getActiveServer(), popoverParticipant!.avatarUser.id)}
    onClose={closeUserMenu}
  />
{/if}

{#if volumePopoverParticipant && volumeAnchorRect}
  <ParticipantVolumePopover
    anchor={volumeAnchorRect}
    participant={volumePopoverParticipant}
    onclose={closeVolumePopover}
    oninput={(event) => onVolumeInput(volumePopoverParticipant!, event)}
    onscreensharinput={(event) => onScreenShareVolumeInput(volumePopoverParticipant!, event)}
  />
{/if}

{#if soundboardAnchor}
  <SoundboardPopover
    anchor={soundboardAnchor}
    {sounds}
    throttled={voiceCallState.soundboardThrottled}
    onplay={onPlaySound}
    onclose={closeSoundboard}
  />
{/if}

{#if streamQualityAnchor}
  <StreamQualityPopover
    anchor={streamQualityAnchor}
    quality={voiceCallState.screenShareQuality}
    ceiling={voiceCallState.screenShareCeiling}
    mode={streamQualityMode}
    retuneFailed={voiceCallState.screenShareRetuneFailed}
    onchange={(prefs) => voiceCallState.setScreenShareQuality(prefs)}
    ongolive={onStreamQualityGoLive}
    onstop={onStreamQualityStop}
    onclose={closeStreamQuality}
  />
{/if}

<style>
  :global(.call-speaking-card) {
    --call-speaking-ring-opacity: 0;
    --call-speaking-ring-strength: 0;
  }

  :global(.call-speaking-card)::after {
    position: absolute;
    inset: 0;
    border: 2px solid var(--color-action);
    border-radius: inherit;
    box-shadow: 0 0 0.75rem color-mix(in srgb, var(--color-action) 30%, transparent);
    content: '';
    opacity: var(--call-speaking-ring-opacity);
    pointer-events: none;
    transition: opacity 80ms linear;
    animation: call-speaking-ring-pulse 1.25s ease-in-out infinite;
  }

  @keyframes call-speaking-ring-pulse {
    0%,
    100% {
      transform: scale(1);
    }

    50% {
      transform: scale(1.012);
    }
  }
</style>
