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
  import { PresenceStatus } from '@chatto/api-types/api/v1/presence_pb';
  import { useServerScope } from '$lib/state/server/scope.svelte';
  import { userPreferences } from '$lib/state/userPreferences.svelte';
  import * as m from '$lib/i18n/messages';

  const serverScope = useServerScope();
  const activeServerId = $derived(serverScope.serverId);
  const stores = $derived(serverScope.store);
  const voiceCallState = $derived(stores.voiceCall);
  const activeCallRooms = $derived(stores.activeCallRooms);

  // Shared per-server soundboard catalog. Loaded lazily once the viewer is in
  // the call; the in-call panel plays these into the LiveKit room.
  const soundboardStore = $derived(getSoundboard(activeServerId));
  const connection = () => serverScope.connection;

  import UserAvatar from '$lib/components/UserAvatar.svelte';
  import VideoThumbnail from './VideoThumbnail.svelte';
  import AudioDeviceMenu from './AudioDeviceMenu.svelte';
  import VoiceCallControlButton from './VoiceCallControlButton.svelte';
  import CallTileActionButton from './CallTileActionButton.svelte';
  import CallTileActionToolbar from './CallTileActionToolbar.svelte';
  import ParticipantVolumePopover from './ParticipantVolumePopover.svelte';
  import StreamQualityPopover from './StreamQualityPopover.svelte';
  import SoundboardPopover from './SoundboardPopover.svelte';
  import UserContextMenu from '$lib/components/menus/UserContextMenu.svelte';
  import { getVoiceCallJoinErrorMessage } from '$lib/state/server/voiceCall.svelte';
  import { getSoundboard } from '$lib/state/soundboard.svelte';
  import { getRoomMembersStore } from '$lib/state/room';
  import type { Sound } from '$lib/api-client/soundboard';
  import type { Track } from 'livekit-client';
  import type { Attachment } from 'svelte/attachments';
  import { startDMWith } from '$lib/dm/startDM';
  import { toast } from '$lib/ui/toast';
  import { serializeScreenShareDiagnostics } from '$lib/voice/webrtcDiagnostics';
  import { isVideoPopOutAvailable, toggleVideoPopOut } from '$lib/voice/pictureInPicture';
  import { getNativeHost } from '$lib/native/host';
  import { roleColorToCSS } from '$lib/roleColors';

  const nativeHost = getNativeHost();
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
    stores.navigation?.rooms?.find((room) => room.id === roomId)?.members ?? []
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
    /** Whether this viewer is watching their camera; false means the track is unsubscribed. */
    isCameraWatched: boolean;
    /** Whether this viewer is watching their screen share; false means the track is unsubscribed. */
    isScreenShareWatched: boolean;
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
          presenceStatus: PresenceStatus.ONLINE,
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
        screenShareTrack: p.screenShareTrack,
        isCameraWatched: p.isCameraWatched ?? true,
        isScreenShareWatched: p.isScreenShareWatched ?? true
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
        presenceStatus: PresenceStatus.ONLINE,
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
      screenShareTrack: null,
      // Observer mode has no LiveKit subscriptions to stop watching.
      isCameraWatched: true,
      isScreenShareWatched: true
    }));
  });

  let sortedParticipants = $derived(
    [...participants].sort((a, b) => {
      if (a.isCameraEnabled && a.videoTrack && !(b.isCameraEnabled && b.videoTrack)) return -1;
      if (b.isCameraEnabled && b.videoTrack && !(a.isCameraEnabled && a.videoTrack)) return 1;
      return 0;
    })
  );
  // Keyed on whether they are sharing, never on whether the track has arrived. A track is
  // absent both while a stopped feed is unsubscribed and for the moment after the viewer
  // resumes one, so testing for it made the tile vanish and the stage reflow mid-resume.
  // Someone is either sharing or not; the track only decides what the tile paints.
  let screenShareParticipants = $derived(
    sortedParticipants.filter((p) => p.isScreenShareEnabled)
  );
  // `hidden` means the viewer stopped watching this feed: the track is unsubscribed and,
  // for a screen share, its audio goes with it. It is deliberately not part of `key` or
  // `kind` — the tile keeps its place so the control that resumes it stays reachable, and
  // the feed is still a screen share or a camera for every other decision.
  type StageTile = {
    key: string;
    kind: 'screen' | 'video' | 'voice';
    participant: DisplayParticipant;
    hidden: boolean;
  };
  function toggleFeedWatched(tile: StageTile, event: MouseEvent) {
    event.stopPropagation();
    const surface = tile.kind === 'screen' ? 'screen' : 'camera';
    if (tile.participant.isLocal) {
      // Your own feeds are published, not subscribed, so there is nothing to stop
      // receiving and no audio to drop. What the control means for yourself is "hide my
      // self-view", which is the view option the header menu already owns — and a
      // self-view choice reasonably outlives the call, unlike stopping someone else's
      // picture.
      const option = surface === 'screen' ? 'showOwnScreenShare' : 'showOwnCamera';
      userPreferences.setCallViewPreference(option, !callView[option]);
      return;
    }
    voiceCallState.toggleFeedWatched(tile.participant.key, surface);
  }
  function feedWatchedLabel(tile: StageTile): string {
    if (tile.participant.isLocal) {
      // Only ever the hiding direction: the view option removes the tile outright, so the
      // way back is the header menu rather than a control on a tile that is no longer there.
      return tile.kind === 'screen'
        ? m['voice.hide_own_screen_share']()
        : m['voice.hide_own_camera']();
    }
    return tile.hidden ? m['voice.start_watching_feed']() : m['voice.stop_watching_feed']();
  }
  let screenShareTiles = $derived(
    screenShareParticipants.map((participant) => ({
      key: `${participant.key}:screen`,
      kind: 'screen' as const,
      participant,
      hidden: !participant.isScreenShareWatched
    }))
  );
  let participantTiles = $derived(
    sortedParticipants.map((participant) => ({
      // `isCameraEnabled` rather than `hasVideo`, for the same reason screen shares no
      // longer test for a track. The kind is part of the key, so deriving it from track
      // arrival tore the tile down and rebuilt it the instant a resumed camera came back.
      // Having a camera on is the durable fact; the track landing is just the moment the
      // card swaps its avatar for video, which `participantCard` already handles.
      key: `${participant.key}:${participant.isCameraEnabled ? 'video' : 'voice'}`,
      kind: participant.isCameraEnabled ? ('video' as const) : ('voice' as const),
      participant,
      hidden: participant.isCameraEnabled && !participant.isCameraWatched
    }))
  );
  let allStageTiles = $derived([...screenShareTiles, ...participantTiles]);
  // Viewer-local visibility choices. Hidden tiles are dropped before the stage
  // decides what to feature, so switching a feed off also stops it claiming the
  // featured slot rather than merely hiding it from the strip.
  let callView = $derived(userPreferences.callView);
  let stripCollapsedLabel = $derived(
    callView.collapsedStrip ? m['voice.show_participants']() : m['voice.hide_participants']()
  );
  let filteredStageTiles = $derived(
    allStageTiles.filter((tile) => {
      if (tile.kind === 'screen') return callView.showOwnScreenShare || !tile.participant.isLocal;
      if (tile.kind === 'video') return callView.showOwnCamera || !tile.participant.isLocal;
      return callView.showNonVideoParticipants;
    })
  );
  // Filters are honoured exactly, even when they hide every feed: a control that
  // silently does nothing is worse than an empty stage, and the roster still
  // shows who is in the call. The empty stage explains itself instead of going
  // blank. The sidebar layout ignores the filters entirely, because its control
  // lives in the maximized pane header and a hidden tile there would have no way
  // back.
  let stageTiles = $derived(isStageLayout ? filteredStageTiles : allStageTiles);
  // Clicking a stream enlarges it and pushes everyone else below, until the same
  // stream is clicked again or it goes away. Held as participant + surface
  // rather than as a tile key, because a participant tile's key changes kind
  // when they turn their camera on or off: focus follows the person, while a
  // focused screen share stays bound to the screen. Scoped to the room, since
  // the panel is not re-created when only the route's room changes.
  type StageFocus = { roomId: string; participantKey: string; surface: 'screen' | 'participant' };
  let stageFocus = $state<StageFocus | null>(null);
  let activeStageFocus = $derived(stageFocus?.roomId === roomId ? stageFocus : null);
  function tileMatchesFocus(tile: StageTile, focus: StageFocus): boolean {
    if (tile.participant.key !== focus.participantKey) return false;
    return focus.surface === 'screen' ? tile.kind === 'screen' : tile.kind !== 'screen';
  }
  // A focused feed that is gone (they left, or stopped sharing) falls back to
  // the automatic pick, and re-takes the stage if it returns.
  let focusedStageTile = $derived(
    activeStageFocus
      ? stageTiles.find((tile) => tileMatchesFocus(tile, activeStageFocus))
      : undefined
  );
  // Focusing a stream is an explicit "show me this now", so it wins over the
  // grid preference until it is released.
  let isGridView = $derived(callView.grid && !focusedStageTile);
  // A feed the viewer switched off should not be handed the featured slot by the
  // automatic pick, or hiding it would enlarge it instead.
  let featuredStageTile = $derived(
    focusedStageTile ??
      stageTiles.find((tile) => tile.kind === 'screen' && !tile.hidden) ??
      stageTiles.find((tile) => tile.kind === 'video' && !tile.hidden) ??
      stageTiles.find((tile) => !tile.hidden) ??
      stageTiles[0]
  );
  let secondaryStageTiles = $derived(
    featuredStageTile ? stageTiles.filter((tile) => tile.key !== featuredStageTile.key) : []
  );
  let mediaTileCount = $derived(
    stageTiles.filter((tile) => tile.kind !== 'voice' && !tile.hidden).length
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
  const canStartDMs = $derived(stores.permissions.canStartDMs);

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

  /** Role names for a participant who is still a room member; guests get none. */
  function memberRoles(userId: string | null | undefined): string[] {
    if (!userId) return [];
    return getRoomMembersStore().members.find((member) => member.id === userId)?.roles ?? [];
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

  async function copyScreenShareDiagnostics(): Promise<void> {
    if (voiceCallState.screenShareDiagnostics.history.length === 0) return;
    try {
      await navigator.clipboard.writeText(
        serializeScreenShareDiagnostics(voiceCallState.screenShareDiagnostics)
      );
      toast.success(m['common.copied_to_clipboard']());
    } catch {
      toast.error(m['common.error.generic']());
    }
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
      if (!serverScope.isCurrent()) return;
      stores.handleVoiceCallJoinFailed(roomId);
      toast.error(getVoiceCallJoinErrorMessage(err));
    }
  }

  // Whether this host can float a feed above other windows at all. The desktop client's
  // webview has no video context menu of its own, so the pop-out control is the only way
  // there; WebKit-based webviews have no API to offer, so the control is hidden instead of
  // failing. Read once because a document does not gain the API at runtime.
  const canPopOutFeeds = isVideoPopOutAvailable(
    nativeHost,
    typeof document === 'undefined' ? null : document
  );

  function mediaCardVideo(target: HTMLElement): HTMLVideoElement | null {
    return target.closest<HTMLElement>('[data-call-media-card]')?.querySelector('video') ?? null;
  }

  // Nothing may be awaited before toggleVideoPopOut: both window.open and element PiP need
  // the click's user activation, and Chromium rejects either one after an async hop.
  async function popOutClosestMedia(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const result = await toggleVideoPopOut(
      mediaCardVideo(event.currentTarget as HTMLElement),
      voiceCallState,
      nativeHost,
      document,
      window
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

  function toggleStageFocus(tile: StageTile, event: MouseEvent): void {
    event.stopPropagation();
    if (focusedStageTile?.key === tile.key) {
      // Releasing focus lands in grid rather than back on a single featured feed: having
      // just said "not this one", the useful answer is everything at once. Grid view is
      // switched on with it so the menu never disagrees with what is on screen.
      stageFocus = null;
      userPreferences.setCallViewPreference('grid', true);
      return;
    }
    stageFocus = {
      roomId,
      participantKey: tile.participant.key,
      surface: tile.kind === 'screen' ? 'screen' : 'participant'
    };
  }

  function stageFocusLabel(tile: StageTile): string {
    return focusedStageTile?.key === tile.key
      ? m['voice.unfocus_feed']()
      : m['voice.focus_feed']();
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

{#snippet hiddenFeedBody()}
  <div
    class="flex aspect-video w-full items-center justify-center rounded-sm bg-surface-emphasized/40 text-muted"
    data-testid="call-feed-hidden-placeholder"
  >
    <span class="iconify text-2xl uil--eye-slash" aria-hidden="true"></span>
    <span class="sr-only">{m['voice.feed_not_watched']()}</span>
  </div>
{/snippet}

{#snippet hideFeedButton(tile: StageTile)}
  <CallTileActionButton
    icon={tile.hidden ? 'uil--eye-slash' : 'uil--eye'}
    active={tile.hidden}
    label={feedWatchedLabel(tile)}
    testId="call-feed-watch-button"
    onclick={(event) => toggleFeedWatched(tile, event)}
  />
{/snippet}

{#snippet mediaTileActions(participant: DisplayParticipant, tile: StageTile | null = null)}
  <CallTileActionToolbar testId="call-media-actions">
    {#if tile && tile.kind !== 'voice'}
      {@render hideFeedButton(tile)}
    {/if}
    {#if canPopOutFeeds && !tile?.hidden}
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

{#snippet voiceTileActions(participant: DisplayParticipant, tile: StageTile | null = null)}
  {#if isInThisCall}
    <CallTileActionToolbar testId="call-voice-actions">
      <!-- A hidden feed keeps its card so the switch back is always in reach. -->
      {#if tile?.hidden}
        {@render hideFeedButton(tile)}
      {/if}
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
  showIndicators = true,
  tile: StageTile | null = null
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
      {@render mediaTileActions(participant, tile)}
    {:else if actions === 'voice'}
      {@render voiceTileActions(participant, tile)}
    {/if}
  </div>
{/snippet}

{#snippet participantCard(
  participant: DisplayParticipant,
  mode: 'compact' | 'video',
  tile: StageTile | null = null,
  fill = false
)}
  {@const showVideo = mode === 'video' && hasVideo(participant)}
  {@const showVoiceActions = isInThisCall && !showVideo}
  {@const actions = showVideo ? 'media' : showVoiceActions ? 'voice' : 'none'}
  {#if isInThisCall}
    <div
      class={[
        callTileCardClass,
        mode === 'video' ? 'participant-card-video' : 'participant-card-compact',
        fill && 'h-full min-h-0'
      ]}
      {@attach speakingCard(participant.key)}
      title={participantTitle(participant)}
      data-testid="call-participant-card"
      data-speaking-ring
      data-call-media-card={showVideo ? true : undefined}
    >
      {@render participantHeader(participant, participant.displayName, actions, true, tile)}

      {#if showVideo}
        <button
          type="button"
          class={[callTileMediaButtonClass, fill && 'min-h-0']}
          title={tile ? stageFocusLabel(tile) : undefined}
          aria-label={tile ? stageFocusLabel(tile) : undefined}
          data-testid="call-tile-media-button"
          onclick={tile ? (e) => toggleStageFocus(tile, e) : (e) => showUserMenu(participant, e)}
        >
          <VideoThumbnail
            track={participant.videoTrack!}
            name={participant.displayName}
            user={participant.avatarUser}
            showIdentityOverlay={false}
            {fill}
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
            {fill}
          />
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet screenShareCard(
  participant: DisplayParticipant,
  tile: StageTile | null = null,
  fill = false
)}
  <div
    class={[
      callTileCardClass,
      'participant-card-video',
      fill ? 'h-full min-h-0' : '@min-[368px]:col-span-2'
    ]}
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
      false,
      tile
    )}
    {#if tile?.hidden}
      {@render hiddenFeedBody()}
    {:else}
      <button
        type="button"
        class={[callTileMediaButtonClass, fill && 'min-h-0']}
        title={tile ? stageFocusLabel(tile) : undefined}
        aria-label={tile ? stageFocusLabel(tile) : undefined}
        data-testid="call-tile-media-button"
        onclick={tile ? (e) => toggleStageFocus(tile, e) : (e) => showUserMenu(participant, e)}
      >
        <VideoThumbnail
          track={participant.screenShareTrack!}
          name={m['voice.screen_title']({ name: participant.displayName })}
          user={participant.avatarUser}
          showIdentityOverlay={false}
          fit="contain"
          {fill}
        />
      </button>
    {/if}
  </div>
{/snippet}

{#snippet featuredStageCard(tile: StageTile)}
  {@const participant = tile.participant}
  {@const isScreen = tile.kind === 'screen' && !tile.hidden}
  {@const isVideo = tile.kind === 'video' && !tile.hidden}
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
      true,
      tile
    )}
    <button
      type="button"
      class={[
        callTileMediaButtonClass,
        'min-h-0 items-center justify-center',
        !isScreen && !isVideo && 'p-6'
      ]}
      data-testid="call-tile-media-button"
      title={isScreen || isVideo ? stageFocusLabel(tile) : undefined}
      aria-label={isScreen || isVideo ? stageFocusLabel(tile) : undefined}
      onclick={isScreen || isVideo
        ? (e) => toggleStageFocus(tile, e)
        : (e) => showUserMenu(participant, e)}
    >
      {#if tile.hidden}
        {@render hiddenFeedBody()}
      {:else if isScreen}
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

{#snippet stageTile(tile: StageTile, fill = false)}
  {#if tile.kind === 'screen'}
    {@render screenShareCard(tile.participant, isStageLayout ? tile : null, fill)}
  {:else}
    {@render participantCard(
      tile.participant,
      tile.kind === 'video' && !tile.hidden ? 'video' : 'compact',
      isStageLayout ? tile : null,
      fill
    )}
  {/if}
{/snippet}

{#snippet callControls()}
  {#if isInThisCall}
    <div class={isStageLayout ? 'mx-auto max-w-2xl' : ''}>
      <!-- Auto-flow columns: the soundboard control is conditional, so the
           track count varies between four and six. -->
      <div class="grid grid-flow-col auto-cols-fr gap-2">
        <VoiceCallControlButton
          class={controlButtonClass}
          label={m['voice.devices']()}
          testId="call-device-menu-button"
          icon="uil--setting"
          iconClass="text-lg"
          onclick={openDeviceMenu}
        />

        <VoiceCallControlButton
          class={voiceCallState.isCameraEnabled ? activeControlButtonClass : controlButtonClass}
          label={voiceCallState.isCameraEnabled
            ? m['voice.turn_off_camera']()
            : m['voice.turn_on_camera']()}
          testId="call-camera-toggle"
          icon={voiceCallState.isCameraEnabled ? 'uil--video' : 'uil--video-slash'}
          iconClass="text-lg"
          onclick={() => voiceCallState.toggleCamera()}
          pending={voiceCallState.isCameraPending}
        />

        <VoiceCallControlButton
          class={voiceCallState.isMuted ? controlButtonClass : activeControlButtonClass}
          label={voiceCallState.isMuted ? m['voice.unmute']() : m['voice.mute']()}
          testId="call-mute-toggle"
          icon={voiceCallState.isMuted ? 'uil--microphone-slash' : 'uil--microphone'}
          iconClass="text-lg"
          onclick={() => voiceCallState.toggleMute()}
          pending={voiceCallState.isMicrophonePending}
        />

        <VoiceCallControlButton
          class={voiceCallState.isDeafened ? controlButtonClass : activeControlButtonClass}
          label={voiceCallState.isDeafened ? m['voice.undeafen']() : m['voice.deafen']()}
          testId="call-deafen-toggle"
          icon={voiceCallState.isDeafened ? 'uil--headphone-slash' : 'uil--headphones'}
          iconClass="text-lg"
          pressed={voiceCallState.isDeafened}
          onclick={() => voiceCallState.toggleDeafen()}
          pending={voiceCallState.isDeafenPending}
        />

        <!-- Opens the stream-quality picker rather than toggling directly, so
             this control advertises a dialog instead of a pressed state. -->
        <VoiceCallControlButton
          class={voiceCallState.isScreenShareEnabled
            ? activeControlButtonClass
            : controlButtonClass}
          label={voiceCallState.isScreenShareEnabled
            ? m['voice.stream_quality_settings']()
            : m['voice.share_screen']()}
          testId="call-screen-share-toggle"
          icon="uil--desktop"
          iconClass="text-lg"
          haspopup="dialog"
          expanded={!!streamQualityAnchor}
          onclick={onScreenShareClick}
          pending={voiceCallState.isScreenSharePending}
        />

        {#if showSoundboardButton}
          <VoiceCallControlButton
            class={soundboardAnchor ? activeControlButtonClass : controlButtonClass}
            label={m['soundboard.panel_button']()}
            testId="call-soundboard-button"
            icon="uil--music"
            iconClass="text-lg"
            pressed={!!soundboardAnchor}
            onclick={toggleSoundboard}
          />
        {/if}

        <VoiceCallControlButton
          class={dangerControlButtonClass}
          onclick={() => voiceCallState.leave()}
          label={m['voice.leave']()}
          testId="call-leave-button"
          icon="uil--phone-slash"
          iconClass="text-lg"
        />
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
      {#if isStageLayout && isGridView && stageTiles.length > 0}
        <section
          class="flex min-h-0 flex-1 flex-col"
          aria-label={m['voice.participants']()}
          data-testid="call-stage-grid"
        >
          <div
            class="grid min-h-0 flex-1 auto-rows-fr grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3 overflow-y-auto"
            data-testid="call-grid-stage-list"
          >
            {#each stageTiles as tile (tile.key)}
              {@render stageTile(tile, true)}
            {/each}
          </div>
        </section>
      {:else if isStageLayout && featuredStageTile}
        <section
          class="flex min-h-0 flex-1 flex-col gap-3"
          aria-label={m['voice.participants']()}
          data-testid="call-stage-layout"
        >
          <div class="flex min-h-0 flex-1" data-testid="call-featured-stage">
            {@render featuredStageCard(featuredStageTile)}
          </div>

          {#if secondaryStageTiles.length > 0}
            <div class="flex shrink-0 flex-col items-center gap-1">
              <button
                type="button"
                class="flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-sm text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-action"
                title={stripCollapsedLabel}
                aria-label={stripCollapsedLabel}
                aria-expanded={!callView.collapsedStrip}
                aria-controls="call-secondary-stage-list"
                data-testid="call-strip-collapse-button"
                onclick={() => userPreferences.toggleCallViewPreference('collapsedStrip')}
              >
                <span
                  class={[
                    'iconify uil--angle-down',
                    callView.collapsedStrip && 'rotate-180'
                  ]}
                  aria-hidden="true"
                ></span>
                <span class="iconify uil--users-alt" aria-hidden="true"></span>
              </button>

              {#if !callView.collapsedStrip}
                <div
                  id="call-secondary-stage-list"
                  class="flex max-h-[190px] w-full shrink-0 flex-wrap content-start justify-center gap-3 overflow-y-auto"
                  data-testid="call-secondary-stage-list"
                >
                  {#each secondaryStageTiles as tile (tile.key)}
                    <div class="w-[clamp(180px,22vw,240px)] max-w-full min-w-0">
                      {@render stageTile(tile)}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </section>
      {:else if isStageLayout}
        <section
          class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-center"
          aria-label={m['voice.participants']()}
          data-testid="call-stage-empty"
        >
          <p class="text-muted">{m['voice.all_feeds_hidden']()}</p>
          <p class="text-muted">{m['voice.all_feeds_hidden_hint']()}</p>
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
            {#each stageTiles as tile (tile.key)}
              {@render stageTile(tile)}
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
    serverId={activeServerId}
    user={popoverParticipant.avatarUser}
    anchorRect={popoverAnchorRect}
    roles={memberRoles(popoverParticipant.avatarUser.id)}
    canSendMessage={canStartDMs}
    onSendMessage={() => startDMWith(activeServerId, popoverParticipant!.avatarUser.id)}
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
    diagnosticsAvailable={voiceCallState.screenShareDiagnostics.history.length > 0}
    onchange={(prefs) => voiceCallState.setScreenShareQuality(prefs)}
    ongolive={onStreamQualityGoLive}
    oncopydiagnostics={() => void copyScreenShareDiagnostics()}
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
