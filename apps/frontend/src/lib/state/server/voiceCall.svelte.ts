/**
 * Voice call state — manages LiveKit connection for voice/video calls.
 *
 * Per-instance class that wraps livekit-client's Room instance.
 * Handles joining/leaving calls, mute toggle, camera toggle,
 * screen share toggle, and audio/video device selection.
 */

import {
  Room,
  RoomEvent,
  Track,
  AudioPresets,
  VideoPresets,
  ExternalE2EEKeyProvider,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant
} from 'livekit-client';
import { toast } from '$lib/ui/toast';
import { playCallSound } from '$lib/audio/callSounds';
import * as m from '$lib/i18n/messages';
import type { VoiceCallAPI } from '$lib/api-client/voiceCalls';
import { serverSlot, Codecs, type StorageSlot } from '$lib/storage/slot';
import { NoiseSuppressionController } from '$lib/voice/noiseSuppression.svelte';
import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  clampQualityPrefs,
  isScreenShareQualityPrefs,
  resolveScreenShareOptions,
  type ScreenShareCeiling,
  type ScreenShareQualityPrefs
} from './screenShareQuality';

export type CallParticipantInfo = {
  identity: string;
  name: string;
  login: string;
  avatarUrl: string | null;
  isMuted: boolean;
  isLocal: boolean;
  connectionQuality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
  isCameraEnabled: boolean;
  videoTrack: Track | null;
  isScreenShareEnabled: boolean;
  screenShareTrack: Track | null;
  isLocallyMuted: boolean;
  /** Per-viewer playback volume for this remote participant, percent 0-100. Local participant is always 100. */
  localVolume: number;
};

/** Non-reactive audio level snapshot, read imperatively by the UI at ~60ms. */
export type AudioLevelInfo = {
  isSpeaking: boolean;
  audioLevel: number;
};

export type CallTransitionSoundDecision = 'play' | 'defer' | 'skip';

/** Metadata embedded in the LiveKit token by the backend. */
type ParticipantMetadata = {
  login?: string;
  avatarUrl?: string;
};

const RECENTLY_DISCONNECTED_CALL_SOUND_MS = 5_000;
const MEDIA_DEVICE_TOAST_DEDUPLICATION_MS = 1_500;

type VoiceCallMediaDeviceTarget = 'microphone' | 'camera' | 'screen' | 'speaker' | 'device';
type VoiceCallMediaDeviceContext = 'join' | 'enable' | 'switch' | 'event';
type MediaDeviceFailureKind =
  | 'permission-denied'
  | 'not-found'
  | 'in-use'
  | 'constraint'
  | 'aborted'
  | 'unknown';

export class VoiceCallJoinError extends Error {
  readonly userMessage: string;
  readonly cause?: unknown;

  constructor(message: string, userMessage: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceCallJoinError';
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

export function getVoiceCallJoinErrorMessage(err: unknown): string {
  if (err instanceof VoiceCallJoinError) return err.userMessage;

  const message = errorMessage(err);
  if (/signal connection|serverunreachable|websocket|web socket|abort handler/i.test(message)) {
    return m['voice.signaling_failed']();
  }
  if (/e2ee|cryptor|encoded transform|insertable stream/i.test(message)) {
    return m['voice.encrypted_unsupported']();
  }

  return m['voice.join_failed']();
}

export function getVoiceCallMediaDeviceErrorMessage(
  target: VoiceCallMediaDeviceTarget,
  err: unknown,
  context: VoiceCallMediaDeviceContext = 'event'
): string {
  const failure = classifyMediaDeviceFailure(err);

  if (target === 'microphone' && context === 'join') {
    switch (failure) {
      case 'permission-denied':
        return m['voice.microphone_join_denied']();
      case 'not-found':
        return m['voice.microphone_join_not_found']();
      case 'in-use':
        return m['voice.microphone_join_in_use']();
      default:
        return m['voice.microphone_join_failed']();
    }
  }

  if (target === 'microphone') {
    switch (failure) {
      case 'permission-denied':
        return m['voice.microphone_denied']();
      case 'not-found':
        return m['voice.microphone_not_found']();
      case 'in-use':
        return m['voice.microphone_in_use']();
      default:
        return m['voice.microphone_failed']();
    }
  }

  if (target === 'camera') {
    switch (failure) {
      case 'permission-denied':
        return m['voice.camera_denied']();
      case 'not-found':
        return m['voice.camera_not_found']();
      case 'in-use':
        return m['voice.camera_in_use']();
      default:
        return m['voice.camera_failed']();
    }
  }

  if (target === 'screen') {
    if (failure === 'permission-denied' || failure === 'aborted') {
      return m['voice.screen_share_blocked']();
    }
    return m['voice.screen_share_failed']();
  }

  if (target === 'speaker') {
    return m['voice.speaker_switch_failed']();
  }

  if (context === 'switch') {
    return m['voice.device_switch_failed']();
  }

  return m['voice.media_device_failed']();
}

const CALL_VOLUMES_SUFFIX = 'callParticipantVolumes';
const SCREEN_SHARE_QUALITY_SUFFIX = 'screenShareQuality';

const screenShareQualityCodec = Codecs.json<ScreenShareQualityPrefs>(isScreenShareQualityPrefs);

/**
 * Fallback screen-share ceiling when the server does not advertise one.
 *
 * 8 Mbps matches Discord's Nitro-tier Go Live cap and is what 1080p60 actually needs; a
 * lower ceiling would clamp the default quality away on its first use.
 */
export const DEFAULT_SCREEN_SHARE_CEILING: ScreenShareCeiling = {
  maxWidth: 1920,
  maxHeight: 1080,
  maxFramerate: 60,
  maxBitrate: 8_000_000
};

// Codec only checks "is an object"; individual entries are clamped on read.
const volumeMapCodec = Codecs.json<Record<string, number>>(
  (v): v is Record<string, number> => typeof v === 'object' && v !== null
);

function sanitizeVolumeMap(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, val] of Object.entries(raw)) {
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 100) {
      out[id] = Math.round(val);
    }
  }
  return out;
}

export class VoiceCallState {
  #api: VoiceCallAPI;

  // Current call context
  roomId = $state<string | null>(null);

  // Connection state
  connecting = $state(false);
  connected = $state(false);

  // Audio state
  isMuted = $state(false);
  // True while LiveKit is applying local device enable/disable changes.
  isMicrophonePending = $state(false);

  // Deafen: mutes your own mic AND silences all incoming call audio together.
  // Discord parity — deafening implies muted; undeafening restores the mic to
  // whatever state it had before you deafened.
  isDeafened = $state(false);
  // True while LiveKit is applying the deafen-driven mic enable/disable change.
  isDeafenPending = $state(false);

  // Video state — camera is always disabled by default
  isCameraEnabled = $state(false);
  // True while LiveKit is applying local camera enable/disable changes.
  isCameraPending = $state(false);
  isScreenShareEnabled = $state(false);
  // True while LiveKit is applying local screen-share enable/disable changes.
  isScreenSharePending = $state(false);

  // Participants (including local)
  participants = $state<CallParticipantInfo[]>([]);

  // Remote participants locally muted by this browser session only.
  locallyMutedParticipantIds = $state<Record<string, boolean>>({});

  // Per-participant playback volume (percent 0-100) for this viewer. Absent key == default 100.
  // Persisted per-server across leave/rejoin; keyed by LiveKit participant identity.
  participantVolumes = $state<Record<string, number>>({});

  // Persistence slot for participantVolumes; null when no serverId was provided (tests/in-memory only).
  #volumesSlot: StorageSlot<Record<string, number>> | null = null;

  // Screen-share quality choice (resolution / framerate / audio), persisted per server.
  // Always kept clamped to the server's advertised ceiling.
  screenShareQuality = $state<ScreenShareQualityPrefs>(DEFAULT_SCREEN_SHARE_QUALITY);

  // Persistence slot for screenShareQuality; null when no serverId was provided.
  #screenShareQualitySlot: StorageSlot<ScreenShareQualityPrefs> | null = null;

  // True when the last quality change could not be applied to the live share and will only
  // take effect on the next one. Lets the UI be honest instead of silently doing nothing.
  screenShareRetuneFailed = $state(false);

  // Audio input devices
  audioDevices = $state<MediaDeviceInfo[]>([]);
  selectedDeviceId = $state<string | null>(null);

  // Audio output devices
  audioOutputDevices = $state<MediaDeviceInfo[]>([]);
  selectedOutputDeviceId = $state<string | null>(null);

  // Video input devices
  videoDevices = $state<MediaDeviceInfo[]>([]);
  selectedVideoDeviceId = $state<string | null>(null);

  // Internal LiveKit room instance
  private room: Room | null = null;
  private activeCallId: string | null = null;
  private pendingOwnJoinSound: {
    roomId: string;
    callId: string;
  } | null = null;
  private recentlyDisconnectedCall: {
    roomId: string;
    callId: string;
    disconnectedAt: number;
  } | null = null;
  private joinInFlight: Promise<void> | null = null;
  private joinInFlightRoomId: string | null = null;
  private leaveInFlight: Promise<void> | null = null;
  private microphoneToggleInFlight: Promise<void> | null = null;
  private cameraToggleInFlight: Promise<void> | null = null;
  private screenShareToggleInFlight: Promise<void> | null = null;
  private deafenToggleInFlight: Promise<void> | null = null;
  // Mic mute state captured when deafening, restored on undeafen.
  private mutedBeforeDeafen = false;
  private e2eeWorker: Worker | null = null;
  private audioLevelInterval: ReturnType<typeof setInterval> | null = null;
  private suppressDisconnectToast = false;
  private explicitMediaDeviceOperationDepth = 0;
  private lastMediaDeviceToast: {
    message: string;
    shownAt: number;
  } | null = null;

  // Non-reactive audio level cache — updated at 60ms by the polling interval.
  // Deliberately NOT $state to avoid triggering Svelte reactivity at 60Hz.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- deliberately non-reactive, polled imperatively at 60Hz
  private audioLevelCache = new Map<string, AudioLevelInfo>();

  // Fork-owned enhanced noise suppression for the outbound microphone track.
  // The analyser callback keeps the local speaking indicator connected to
  // LiveKit's current processed/raw track after processor changes.
  readonly noiseSuppression = new NoiseSuppressionController(() => {
    if (!this.isMuted) {
      this.setupLocalAudioAnalyser();
    }
  });

  // Local microphone audio analysis (Web Audio API) for instant level feedback.
  // LiveKit's audioLevel for the local participant comes from the server
  // (round-trip latency), so we read the mic input directly instead.
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserSource: MediaStreamAudioSourceNode | null = null;
  private analyserData: Float32Array<ArrayBuffer> | null = null;

  // Lazily resolves the server-configured screen-share quality ceiling at
  // share time. Optional so tests/callers can omit it (falls back to defaults).
  #screenShareConfigProvider?: () => {
    maxWidth: number;
    maxHeight: number;
    maxFramerate: number;
    maxBitrate: number;
  };

  constructor(
    api: VoiceCallAPI,
    screenShareConfigProvider?: () => {
      maxWidth: number;
      maxHeight: number;
      maxFramerate: number;
      maxBitrate: number;
    },
    serverId?: string
  ) {
    this.#api = api;
    this.#screenShareConfigProvider = screenShareConfigProvider;
    if (serverId) {
      this.#volumesSlot = serverSlot(serverId, CALL_VOLUMES_SUFFIX, {}, volumeMapCodec);
      this.participantVolumes = sanitizeVolumeMap(this.#volumesSlot.get());

      this.#screenShareQualitySlot = serverSlot(
        serverId,
        SCREEN_SHARE_QUALITY_SUFFIX,
        DEFAULT_SCREEN_SHARE_QUALITY,
        screenShareQualityCodec
      );
      // Clamp on read: the stored preference may predate a self-hoster lowering the ceiling.
      this.screenShareQuality = clampQualityPrefs(
        this.#screenShareQualitySlot.get(),
        this.screenShareCeiling
      );
    }
  }

  /**
   * The server's advertised screen-share quality ceiling, or a Discord-Nitro-equivalent
   * default (1080p60 @ 8 Mbps) when the server does not advertise one.
   *
   * Advisory only — see `ScreenShareCeiling`.
   */
  get screenShareCeiling(): ScreenShareCeiling {
    return this.#screenShareConfigProvider?.() ?? DEFAULT_SCREEN_SHARE_CEILING;
  }

  /**
   * Update the screen-share quality preference, persist it, and retune a live share in place.
   *
   * Deliberately does NOT republish the track. Restarting a screen share means calling
   * `getDisplayMedia()` again, which re-opens the browser's window picker — the user would
   * have to re-choose their window every time they nudged the frame rate. Instead both axes
   * are retuned on the existing track:
   *
   * - capture: `applyConstraints()` on the underlying `MediaStreamTrack`
   * - publish: `setParameters()` on the `RTCRtpSender`'s single encoding
   *
   * Neither re-prompts, so quality changes are seamless for the sharer and appear to viewers
   * as an ordinary bitrate/resolution shift rather than the stream dropping and returning.
   *
   * Best-effort by design: if the sender or capture track is not retunable (older browser,
   * or LiveKit has not attached a sender yet) the preference is still saved and takes effect
   * on the next share. `screenShareRetuneFailed` reports that so the UI can say so rather
   * than claiming a change that did not land.
   */
  async setScreenShareQuality(prefs: ScreenShareQualityPrefs): Promise<void> {
    const clamped = clampQualityPrefs(prefs, this.screenShareCeiling);
    this.screenShareQuality = clamped;
    this.#screenShareQualitySlot?.set(clamped);
    this.screenShareRetuneFailed = false;

    if (!this.isScreenShareEnabled || !this.room) return;

    const { capture, publish } = resolveScreenShareOptions(clamped, this.screenShareCeiling);
    const publication = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = publication?.track;
    if (!track) {
      this.screenShareRetuneFailed = true;
      return;
    }

    try {
      await track.mediaStreamTrack?.applyConstraints({
        width: capture.resolution.width,
        height: capture.resolution.height,
        frameRate: capture.resolution.frameRate
      });

      const sender = track.sender;
      if (!sender) {
        this.screenShareRetuneFailed = true;
        return;
      }

      const params = sender.getParameters();
      // simulcast is off for screen share, so there is exactly one encoding to retune.
      if (params.encodings.length === 0) {
        this.screenShareRetuneFailed = true;
        return;
      }
      for (const encoding of params.encodings) {
        encoding.maxBitrate = publish.screenShareEncoding.maxBitrate;
        encoding.maxFramerate = publish.screenShareEncoding.maxFramerate;
      }
      params.degradationPreference = publish.degradationPreference;
      await sender.setParameters(params);
    } catch (err) {
      // Retuning is an optimization over "applies next time", never a reason to kill the
      // live share — leave it running at its current quality and say so.
      console.warn('screen share retune failed', err);
      this.screenShareRetuneFailed = true;
    }
  }

  /**
   * Whether the user is currently in a call in the given room.
   */
  isInCall(roomId: string): boolean {
    return this.connected && this.roomId === roomId;
  }

  matchesActiveCall(roomId: string, callId: string | null): boolean {
    return (
      this.connected && this.roomId === roomId && callId !== null && this.activeCallId === callId
    );
  }

  /**
   * Whether a durable call transition event should be audible to this client.
   *
   * Remote transitions only play while the viewer is actively connected to
   * the same call. The viewer's own join can arrive before LiveKit finishes
   * connecting, so it is deferred until connect succeeds. The viewer's own
   * leave can arrive just after local cleanup, so a short recently-left
   * window keeps that event audible without leaking sounds to bystanders.
   */
  callTransitionSoundDecision(
    kind: 'join' | 'leave',
    roomId: string,
    callId: string | null,
    actorIsCurrentUser: boolean
  ): CallTransitionSoundDecision {
    if (!callId) return 'skip';

    if (this.matchesActiveCall(roomId, callId)) return 'play';

    if (!actorIsCurrentUser) return 'skip';

    if (kind === 'join' && this.roomId === roomId && this.connecting) {
      this.pendingOwnJoinSound = { roomId, callId };
      return 'defer';
    }

    if (kind === 'leave' && this.matchesRecentlyDisconnectedCall(roomId, callId)) {
      return 'play';
    }

    return 'skip';
  }

  /**
   * Whether the user is currently in any call.
   */
  get isInAnyCall(): boolean {
    return this.connected;
  }

  /**
   * Read the current audio level for a participant. Non-reactive — intended
   * to be called from a manual polling loop (setInterval), not from Svelte
   * templates or $derived expressions.
   */
  getAudioLevel(identity: string): AudioLevelInfo {
    return this.audioLevelCache.get(identity) ?? { isSpeaking: false, audioLevel: 0 };
  }

  isParticipantLocallyMuted(identity: string): boolean {
    return !!this.locallyMutedParticipantIds[identity];
  }

  toggleParticipantLocalMute(identity: string): void {
    if (!this.room || identity === this.room.localParticipant.identity) return;

    const muted = !this.isParticipantLocallyMuted(identity);
    this.locallyMutedParticipantIds = {
      ...this.locallyMutedParticipantIds,
      [identity]: muted
    };
    if (!muted) {
      const { [identity]: _removed, ...remaining } = this.locallyMutedParticipantIds;
      void _removed;
      this.locallyMutedParticipantIds = remaining;
    }
    this.applyParticipantAudioVolume(identity);
    this.updateParticipants();
  }

  getParticipantVolume(identity: string): number {
    return this.participantVolumes[identity] ?? 100;
  }

  setParticipantVolume(identity: string, volumePercent: number): void {
    if (!this.room || identity === this.room.localParticipant.identity) return;

    const clamped = Math.max(0, Math.min(100, Math.round(volumePercent)));
    if (clamped === 100) {
      // Keep the map sparse: absent key == default 100.
      const { [identity]: _removed, ...remaining } = this.participantVolumes;
      void _removed;
      this.participantVolumes = remaining;
    } else {
      this.participantVolumes = { ...this.participantVolumes, [identity]: clamped };
    }
    this.#volumesSlot?.set(this.participantVolumes);
    this.applyParticipantAudioVolume(identity);
    this.updateParticipants();
  }

  /**
   * Join a voice call in a room.
   */
  async join(livekitUrl: string, roomId: string): Promise<void> {
    // Already in this call
    if (this.isInCall(roomId)) return;

    if (this.joinInFlight) {
      if (this.joinInFlightRoomId === roomId) {
        return this.joinInFlight;
      }
      await this.joinInFlight;
      if (this.isInCall(roomId)) return;
    }

    const joinPromise = this.performJoin(livekitUrl, roomId);
    this.joinInFlight = joinPromise;
    this.joinInFlightRoomId = roomId;
    try {
      await joinPromise;
    } finally {
      if (this.joinInFlight === joinPromise) {
        this.joinInFlight = null;
        this.joinInFlightRoomId = null;
      }
    }
  }

  private async performJoin(livekitUrl: string, roomId: string): Promise<void> {
    assertLiveKitE2EESupported();

    // Leave existing call first
    if (this.connected) {
      await this.leave();
    }

    this.connecting = true;
    this.roomId = roomId;
    let joinIntentRecorded = false;

    try {
      await this.#api.joinCall(roomId);
      joinIntentRecorded = true;

      // Get token from server (pure query, no side effects)
      const tokenResponse = await this.#api.getCallToken(roomId);
      if (!tokenResponse) {
        throw new Error('Failed to get voice call token');
      }
      const { token, e2eeKey, callId } = tokenResponse;
      this.activeCallId = callId;

      const keyProvider = new ExternalE2EEKeyProvider();
      const { default: E2EEWorker } = await import('livekit-client/e2ee-worker?worker');
      this.e2eeWorker = new E2EEWorker();

      // Create and connect LiveKit room
      this.room = new Room({
        encryption: {
          keyProvider,
          worker: this.e2eeWorker
        },
        audioCaptureDefaults: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          ...this.noiseSuppression.captureConstraints()
        },
        videoCaptureDefaults: {
          resolution: VideoPresets.h720.resolution
        },
        publishDefaults: {
          audioPreset: AudioPresets.speech,
          dtx: true,
          red: true,
          simulcast: true
        },
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true
      });

      this.setupRoomEventListeners();

      await keyProvider.setKey(e2eeKey);
      await this.room.setE2EEEnabled(true);
      await this.room.connect(livekitUrl, token);

      // Try to enable microphone, but join muted if no device is available
      try {
        await this.runExplicitMediaDeviceOperation(() =>
          this.room!.localParticipant.setMicrophoneEnabled(true)
        );
        this.isMuted = false;
        this.setupLocalAudioAnalyser();
        // Best-effort: failures fall back to baseline browser processing.
        void this.noiseSuppression.applyToCall(this.room);
      } catch (err) {
        this.isMuted = true;
        this.notifyMediaDeviceError(getVoiceCallMediaDeviceErrorMessage('microphone', err, 'join'));
      }

      this.connected = true;
      this.updateParticipants();
      await this.refreshDevices();
      if (this.consumePendingOwnJoinSound()) {
        void playCallSound('join');
      }
    } catch (err) {
      console.error('Failed to join voice call:', summarizeJoinError(err));
      if (joinIntentRecorded) {
        await this.recordLeaveIntent(roomId);
      }
      this.cleanup();
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Leave the current voice call.
   */
  async leave(): Promise<void> {
    if (this.leaveInFlight) return this.leaveInFlight;
    if (!this.room) return;

    const leavePromise = this.performLeave();
    this.leaveInFlight = leavePromise;
    try {
      await leavePromise;
    } finally {
      if (this.leaveInFlight === leavePromise) {
        this.leaveInFlight = null;
      }
    }
  }

  private async performLeave(): Promise<void> {
    const roomId = this.roomId;
    if (roomId) {
      await this.recordLeaveIntent(roomId);
    }

    this.room?.disconnect();
    this.cleanup();
  }

  /**
   * Apply a backend-authored participant leave. Used for reconciliation and
   * moderation paths where the server has already committed the leave fact.
   */
  handleParticipantLeftEvent(
    roomId: string,
    callId: string | null,
    actorId: string | null,
    currentUserId: string | null
  ): void {
    if (!actorId || !currentUserId || actorId !== currentUserId) return;
    this.disconnectFromServerEvent(roomId, callId);
  }

  /**
   * Apply a backend-authored call end. Does not record another leave intent.
   */
  handleCallEndedEvent(roomId: string, callId: string | null): void {
    this.disconnectFromServerEvent(roomId, callId);
  }

  private disconnectFromServerEvent(roomId: string, callId: string | null): void {
    if (this.roomId !== roomId) return;
    if (!callId || this.activeCallId !== callId) return;

    const room = this.room;
    if (room) {
      this.suppressDisconnectToast = true;
      room.disconnect();
    }
    this.cleanup();
    this.suppressDisconnectToast = false;
  }

  private async recordLeaveIntent(roomId: string): Promise<void> {
    try {
      await this.#api.leaveCall(roomId);
    } catch {
      // LiveKit disconnect/cleanup should still proceed if the intent write fails.
    }
  }

  /**
   * Toggle microphone mute.
   */
  async toggleMute(): Promise<void> {
    if (this.microphoneToggleInFlight) return this.microphoneToggleInFlight;

    const room = this.room;
    if (!room) return;

    const togglePromise = this.performToggleMute(room);
    this.microphoneToggleInFlight = togglePromise;
    this.isMicrophonePending = true;
    try {
      await togglePromise;
    } finally {
      if (this.microphoneToggleInFlight === togglePromise) {
        this.microphoneToggleInFlight = null;
        this.isMicrophonePending = false;
      }
    }
  }

  private async performToggleMute(room: Room): Promise<void> {
    const newMuted = !this.isMuted;
    try {
      await this.runExplicitMediaDeviceOperation(() =>
        room.localParticipant.setMicrophoneEnabled(!newMuted)
      );
      if (this.room !== room) return;
    } catch (err) {
      if (this.room === room && !newMuted) {
        this.notifyMediaDeviceError(
          getVoiceCallMediaDeviceErrorMessage('microphone', err, 'enable')
        );
      }
      return;
    }

    this.isMuted = newMuted;

    if (!newMuted) {
      this.setupLocalAudioAnalyser();
      // Covers joining muted (no mic at join time): the suppression
      // preference is applied on the first successful unmute instead.
      void this.noiseSuppression.applyToCall(room);
    } else {
      this.teardownLocalAudioAnalyser();
    }

    // Turning your mic back on while deafened is contradictory — undeafen so
    // you can hear again, matching Discord.
    if (!newMuted && this.isDeafened) {
      this.isDeafened = false;
      this.applyAllParticipantAudioVolumes();
    }

    this.updateParticipants();
  }

  /**
   * Toggle deafen: silence all incoming audio and force-mute your own mic.
   * Undeafening restores incoming audio and returns the mic to its pre-deafen
   * state (still muted if you were already muted before you deafened).
   */
  async toggleDeafen(): Promise<void> {
    if (this.deafenToggleInFlight) return this.deafenToggleInFlight;

    const room = this.room;
    if (!room) return;

    const togglePromise = this.performToggleDeafen(room);
    this.deafenToggleInFlight = togglePromise;
    this.isDeafenPending = true;
    try {
      await togglePromise;
    } finally {
      if (this.deafenToggleInFlight === togglePromise) {
        this.deafenToggleInFlight = null;
        this.isDeafenPending = false;
      }
    }
  }

  private async performToggleDeafen(room: Room): Promise<void> {
    const newDeafened = !this.isDeafened;

    // Silence (or restore) INCOMING audio immediately. This is independent of the
    // outgoing mic, so it must not wait on the local device operation below —
    // otherwise a slow setMicrophoneEnabled would keep you hearing everyone after
    // you pressed Deafen. Setting isDeafened first also mutes any participant who
    // joins while the mic operation is still in flight.
    this.isDeafened = newDeafened;
    this.applyAllParticipantAudioVolumes();

    // The mic is shared with toggleMute; wait for any in-flight mic toggle to
    // settle so we capture and mutate a committed mic state, never a stale one.
    const inFlightMic = this.microphoneToggleInFlight;
    if (inFlightMic) {
      try {
        await inFlightMic;
      } catch {
        // Ignore; committed state is re-read below.
      }
      // A racing leave or unmute-driven undeafen may have run while we waited.
      if (this.room !== room || this.isDeafened !== newDeafened) return;
    }

    if (newDeafened) {
      // Remember the committed mic state so undeafen can restore it, then
      // force-mute the mic if it isn't already muted.
      this.mutedBeforeDeafen = this.isMuted;
      if (!this.isMuted) {
        await this.applyDeafenMicState(room, false);
      }
    } else if (!this.mutedBeforeDeafen && this.isMuted) {
      // Restore the mic only if deafen was what muted it.
      await this.applyDeafenMicState(room, true);
    }

    this.updateParticipants();
  }

  /**
   * Applies a deafen-driven microphone enable/disable through the shared
   * microphone in-flight guard so a concurrent toggleMute cannot race the same
   * device. isMuted is committed only on success: a failed disable must never
   * report the mic muted while it is still transmitting.
   */
  private async applyDeafenMicState(room: Room, enabled: boolean): Promise<void> {
    const micToggle: Promise<void> = this.runExplicitMediaDeviceOperation(() =>
      room.localParticipant.setMicrophoneEnabled(enabled)
    ).then(() => {});
    this.microphoneToggleInFlight = micToggle;
    this.isMicrophonePending = true;
    try {
      await micToggle;
      if (this.room !== room) return;
      this.isMuted = !enabled;
      if (enabled) {
        this.setupLocalAudioAnalyser();
      } else {
        this.teardownLocalAudioAnalyser();
      }
    } catch (err) {
      // Re-enabling failure is user-visible (they asked to speak again). A failed
      // disable leaves the mic live, so isMuted is deliberately left unchanged.
      if (this.room === room && enabled) {
        this.notifyMediaDeviceError(
          getVoiceCallMediaDeviceErrorMessage('microphone', err, 'enable')
        );
      }
    } finally {
      if (this.microphoneToggleInFlight === micToggle) {
        this.microphoneToggleInFlight = null;
        this.isMicrophonePending = false;
      }
    }
  }

  /**
   * Toggle camera on/off. Camera is always off by default.
   */
  async toggleCamera(): Promise<void> {
    if (this.cameraToggleInFlight) return this.cameraToggleInFlight;

    const room = this.room;
    if (!room) return;

    const togglePromise = this.performToggleCamera(room);
    this.cameraToggleInFlight = togglePromise;
    this.isCameraPending = true;
    try {
      await togglePromise;
    } finally {
      if (this.cameraToggleInFlight === togglePromise) {
        this.cameraToggleInFlight = null;
        this.isCameraPending = false;
      }
    }
  }

  private async performToggleCamera(room: Room): Promise<void> {
    const newEnabled = !this.isCameraEnabled;
    try {
      await this.runExplicitMediaDeviceOperation(() =>
        room.localParticipant.setCameraEnabled(newEnabled)
      );
      if (this.room !== room) return;

      this.isCameraEnabled = newEnabled;
      if (newEnabled) {
        await this.refreshDevices({ requestVideoPermissions: true });
      }
    } catch (err) {
      // Permission denied or no camera available — keep current state
      if (this.room !== room) return;
      if (newEnabled) {
        this.notifyMediaDeviceError(getVoiceCallMediaDeviceErrorMessage('camera', err, 'enable'));
      }
      this.isCameraEnabled = false;
    }
    this.updateParticipants();
  }

  /**
   * Toggle video-only screen/window/tab sharing.
   */
  async toggleScreenShare(): Promise<void> {
    if (this.screenShareToggleInFlight) return this.screenShareToggleInFlight;

    const room = this.room;
    if (!room) return;

    const togglePromise = this.performToggleScreenShare(room);
    this.screenShareToggleInFlight = togglePromise;
    this.isScreenSharePending = true;
    try {
      await togglePromise;
    } finally {
      if (this.screenShareToggleInFlight === togglePromise) {
        this.screenShareToggleInFlight = null;
        this.isScreenSharePending = false;
      }
    }
  }

  private async performToggleScreenShare(room: Room): Promise<void> {
    const newEnabled = !this.isScreenShareEnabled;
    // The user's quality choice, clamped to the server's advisory ceiling. See
    // ./screenShareQuality.ts for what each option maps to and why.
    const { capture: screenShareCapture, publish: screenSharePublish } = resolveScreenShareOptions(
      this.screenShareQuality,
      this.screenShareCeiling
    );
    try {
      await this.runExplicitMediaDeviceOperation(() =>
        newEnabled
          ? room.localParticipant.setScreenShareEnabled(
              newEnabled,
              screenShareCapture,
              screenSharePublish
            )
          : room.localParticipant.setScreenShareEnabled(newEnabled)
      );
      if (this.room !== room) return;

      this.isScreenShareEnabled = newEnabled;
    } catch (err) {
      if (this.room !== room) return;
      if (newEnabled) {
        this.notifyMediaDeviceError(getVoiceCallMediaDeviceErrorMessage('screen', err, 'enable'));
      }
      this.isScreenShareEnabled = newEnabled ? false : this.isScreenShareEnabled;
    }
    this.updateParticipants();
  }

  /**
   * Refresh available audio and video devices.
   */
  async refreshDevices(options: { requestVideoPermissions?: boolean } = {}): Promise<void> {
    try {
      const requestVideoPermissions = options.requestVideoPermissions ?? this.isCameraEnabled;
      const [inputDevices, outputDevices, videoInputDevices] = await Promise.all([
        Room.getLocalDevices('audioinput'),
        Room.getLocalDevices('audiooutput'),
        Room.getLocalDevices('videoinput', requestVideoPermissions)
      ]);

      this.audioDevices = inputDevices;
      this.audioOutputDevices = outputDevices;
      this.videoDevices = videoInputDevices;

      // Set default selections if not already set
      if (!this.selectedDeviceId && inputDevices.length > 0) {
        this.selectedDeviceId = inputDevices[0].deviceId;
      }
      if (!this.selectedOutputDeviceId && outputDevices.length > 0) {
        this.selectedOutputDeviceId = outputDevices[0].deviceId;
      }
      if (!this.selectedVideoDeviceId && videoInputDevices.length > 0) {
        this.selectedVideoDeviceId = videoInputDevices[0].deviceId;
      }
    } catch {
      this.audioDevices = [];
      this.audioOutputDevices = [];
      this.videoDevices = [];
    }
  }

  /** @deprecated Use refreshDevices() instead */
  async refreshAudioDevices(): Promise<void> {
    return this.refreshDevices();
  }

  /**
   * Switch to a different audio input device.
   */
  async setAudioDevice(deviceId: string): Promise<void> {
    if (!this.room) return;

    try {
      await this.runExplicitMediaDeviceOperation(() =>
        this.room!.switchActiveDevice('audioinput', deviceId)
      );
      this.selectedDeviceId = deviceId;
    } catch (err) {
      this.notifyMediaDeviceError(getVoiceCallMediaDeviceErrorMessage('microphone', err, 'switch'));
      return;
    }

    // A device switch restarts the capture track from LiveKit's stored
    // constraints, which drops any voiceIsolation set via applyConstraints
    // and can re-request it underneath the enhanced processor. Re-apply the
    // suppression mode so the new track matches the selected mode; the
    // controller's callback reconnects the analyser to the reconciled track.
    if (this.room) {
      await this.noiseSuppression.applyToCall(this.room);
    }
    // Reconnect analyser to the new mic track if the controller did not
    // (e.g. suppression disabled, or currently muted-then-unmuted paths).
    if (!this.isMuted) {
      this.setupLocalAudioAnalyser();
    }
  }

  /**
   * Switch to a different audio output device.
   */
  async setAudioOutputDevice(deviceId: string): Promise<void> {
    if (!this.room) return;

    try {
      await this.runExplicitMediaDeviceOperation(() =>
        this.room!.switchActiveDevice('audiooutput', deviceId)
      );
      this.selectedOutputDeviceId = deviceId;
    } catch (err) {
      this.notifyMediaDeviceError(getVoiceCallMediaDeviceErrorMessage('speaker', err, 'switch'));
    }
  }

  /**
   * Switch to a different video input device.
   */
  async setVideoDevice(deviceId: string): Promise<void> {
    if (!this.room) return;

    try {
      await this.runExplicitMediaDeviceOperation(() =>
        this.room!.switchActiveDevice('videoinput', deviceId)
      );
      this.selectedVideoDeviceId = deviceId;
    } catch (err) {
      this.notifyMediaDeviceError(getVoiceCallMediaDeviceErrorMessage('camera', err, 'switch'));
    }
  }

  private setupRoomEventListeners(): void {
    if (!this.room) return;

    this.room.on(RoomEvent.ParticipantConnected, () => {
      this.updateParticipants();
    });

    this.room.on(RoomEvent.ParticipantDisconnected, () => {
      this.updateParticipants();
    });

    this.room.on(RoomEvent.TrackMuted, () => {
      this.updateParticipants();
    });

    this.room.on(RoomEvent.TrackUnmuted, () => {
      this.updateParticipants();
    });

    this.room.on(RoomEvent.Disconnected, () => {
      // Only show toast if we were in an active call (not a failed join attempt)
      if (this.connected && !this.suppressDisconnectToast) {
        toast.error(m['voice.disconnected']());
      }
      this.cleanup();
    });

    this.room.on(RoomEvent.MediaDevicesChanged, () => {
      this.refreshDevices();
    });

    this.room.on(RoomEvent.MediaDevicesError, (err: Error) => {
      if (this.explicitMediaDeviceOperationDepth > 0) return;
      this.notifyMediaDeviceError(getVoiceCallMediaDeviceErrorMessage('device', err, 'event'));
    });

    this.room.on(RoomEvent.ConnectionQualityChanged, () => {
      this.updateParticipants();
    });

    // Attach remote audio tracks so we actually hear other participants.
    // LiveKit delivers audio data over WebRTC, but the browser won't play it
    // until the track is attached to an <audio> element.
    // Video tracks are NOT attached here — VideoThumbnail manages its own lifecycle.
    this.room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _publication: RemoteTrackPublication) => {
        if (track.kind === Track.Kind.Audio) {
          track.attach();
          this.applyAllParticipantAudioVolumes();
        }
        this.updateParticipants();
      }
    );

    this.room.on(
      RoomEvent.TrackUnsubscribed,
      (track: RemoteTrack, _publication: RemoteTrackPublication) => {
        track.detach();
        this.updateParticipants();
      }
    );

    // Track published/unpublished — catches camera enable/disable by remote participants
    this.room.on(RoomEvent.TrackPublished, () => {
      this.updateParticipants();
    });

    this.room.on(RoomEvent.TrackUnpublished, () => {
      this.updateParticipants();
    });

    this.room.on(RoomEvent.LocalTrackPublished, () => {
      this.updateParticipants();
    });

    this.room.on(RoomEvent.LocalTrackUnpublished, () => {
      this.updateParticipants();
    });

    // Keep audio level snapshots fresh for call UI consumers without pushing
    // 60Hz updates through Svelte's reactive graph.
    this.audioLevelInterval = setInterval(() => {
      this.updateAudioLevels();
    }, 60);
  }

  private updateParticipants(): void {
    if (!this.room) {
      this.participants = [];
      return;
    }

    const allParticipants: Participant[] = [
      this.room.localParticipant,
      ...Array.from(this.room.remoteParticipants.values())
    ];
    this.isCameraEnabled = isParticipantCameraEnabled(this.room.localParticipant);
    this.isScreenShareEnabled = isParticipantScreenShareEnabled(this.room.localParticipant);
    this.applyAllParticipantAudioVolumes();

    this.participants = allParticipants.map((p) => {
      const md = parseParticipantMetadata(p.metadata);
      const isLocal = p === this.room!.localParticipant;
      return {
        identity: p.identity,
        name: p.name ?? p.identity,
        login: md.login ?? p.identity,
        avatarUrl: md.avatarUrl ?? null,
        isMuted: isParticipantMuted(p),
        isLocal,
        connectionQuality: p.connectionQuality as CallParticipantInfo['connectionQuality'],
        isCameraEnabled: isParticipantCameraEnabled(p),
        videoTrack: getParticipantCameraTrack(p),
        isScreenShareEnabled: isParticipantScreenShareEnabled(p),
        screenShareTrack: getParticipantScreenShareTrack(p),
        isLocallyMuted: !isLocal && this.isParticipantLocallyMuted(p.identity),
        localVolume: isLocal ? 100 : this.getParticipantVolume(p.identity)
      };
    });
  }

  private applyAllParticipantAudioVolumes(): void {
    if (!this.room) return;
    for (const participant of this.room.remoteParticipants.values()) {
      this.applyRemoteParticipantAudioVolume(participant);
    }
  }

  private applyParticipantAudioVolume(identity: string): void {
    const participant = this.room?.remoteParticipants.get(identity);
    if (participant) this.applyRemoteParticipantAudioVolume(participant);
  }

  private applyRemoteParticipantAudioVolume(participant: RemoteParticipant): void {
    const muted = this.isDeafened || this.isParticipantLocallyMuted(participant.identity);
    const gain = muted ? 0 : this.getParticipantVolume(participant.identity) / 100;
    participant.setVolume(gain);
  }

  /**
   * Update the non-reactive audio level cache. Called at ~60ms.
   * Writes to a plain Map (not $state) so Svelte's reactive graph is
   * completely untouched.
   */
  private updateAudioLevels(): void {
    if (!this.room) return;

    const localAudioLevel = this.getLocalAudioLevel();

    const allParticipants: Participant[] = [
      this.room.localParticipant,
      ...Array.from(this.room.remoteParticipants.values())
    ];

    for (const p of allParticipants) {
      const isLocal = p === this.room!.localParticipant;
      this.audioLevelCache.set(p.identity, {
        isSpeaking: p.isSpeaking,
        audioLevel: isLocal ? localAudioLevel : p.audioLevel
      });
    }
  }

  /**
   * Set up a Web Audio API analyser connected to the local microphone track.
   * This gives us instant audio level readings without server round-trip.
   */
  private setupLocalAudioAnalyser(): void {
    this.teardownLocalAudioAnalyser();
    if (!this.room) return;

    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const mediaStreamTrack = micPub?.track?.mediaStreamTrack;
    if (!mediaStreamTrack) return;

    try {
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyserData = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;

      const stream = new MediaStream([mediaStreamTrack]);
      this.analyserSource = this.audioContext.createMediaStreamSource(stream);
      this.analyserSource.connect(this.analyser);
      // Don't connect analyser to destination — we don't want to hear ourselves
    } catch {
      this.teardownLocalAudioAnalyser();
    }
  }

  private teardownLocalAudioAnalyser(): void {
    this.analyserSource?.disconnect();
    this.analyserSource = null;
    this.analyser?.disconnect();
    this.analyser = null;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.analyserData = null;
  }

  /**
   * Read the current local microphone audio level (0–1) from the Web Audio
   * API analyser. Returns 0 if the analyser is not set up.
   */
  private getLocalAudioLevel(): number {
    if (!this.analyser || !this.analyserData) return 0;

    this.analyser.getFloatTimeDomainData(this.analyserData);

    // Compute RMS of the waveform samples
    let sumSq = 0;
    for (let i = 0; i < this.analyserData.length; i++) {
      sumSq += this.analyserData[i] * this.analyserData[i];
    }
    const rms = Math.sqrt(sumSq / this.analyserData.length);

    // Normalize: RMS of ~0.5 is very loud speech, scale so it maps to ~1.0
    return Math.min(rms * 2, 1);
  }

  private cleanup(): void {
    const disconnectedRoomId = this.roomId;
    const disconnectedCallId = this.activeCallId;
    const wasConnected = this.connected;

    if (this.audioLevelInterval) {
      clearInterval(this.audioLevelInterval);
      this.audioLevelInterval = null;
    }
    this.noiseSuppression.handleCallEnded();
    this.teardownLocalAudioAnalyser();
    if (this.room) {
      // Detach all remote audio tracks to clean up <audio> elements
      for (const p of this.room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          pub.track?.detach();
        }
      }
      this.room.removeAllListeners();
      this.room = null;
    }
    this.e2eeWorker?.terminate();
    this.e2eeWorker = null;
    if (wasConnected && disconnectedRoomId && disconnectedCallId) {
      this.recentlyDisconnectedCall = {
        roomId: disconnectedRoomId,
        callId: disconnectedCallId,
        disconnectedAt: Date.now()
      };
    }
    this.activeCallId = null;
    this.pendingOwnJoinSound = null;
    this.joinInFlight = null;
    this.joinInFlightRoomId = null;
    this.microphoneToggleInFlight = null;
    this.cameraToggleInFlight = null;
    this.screenShareToggleInFlight = null;
    this.deafenToggleInFlight = null;
    this.mutedBeforeDeafen = false;
    this.suppressDisconnectToast = false;
    this.connected = false;
    this.connecting = false;
    this.roomId = null;
    this.isMuted = false;
    this.isMicrophonePending = false;
    this.isDeafened = false;
    this.isDeafenPending = false;
    this.isCameraEnabled = false;
    this.isCameraPending = false;
    this.isScreenShareEnabled = false;
    this.isScreenSharePending = false;
    this.participants = [];
    this.locallyMutedParticipantIds = {};
    // participantVolumes intentionally persists across leave/rejoin (see serverSlot).
    this.audioDevices = [];
    this.selectedDeviceId = null;
    this.audioOutputDevices = [];
    this.selectedOutputDeviceId = null;
    this.videoDevices = [];
    this.selectedVideoDeviceId = null;
    this.audioLevelCache.clear();
    this.explicitMediaDeviceOperationDepth = 0;
    this.lastMediaDeviceToast = null;
  }

  private async runExplicitMediaDeviceOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.explicitMediaDeviceOperationDepth += 1;
    try {
      return await operation();
    } finally {
      this.explicitMediaDeviceOperationDepth = Math.max(
        0,
        this.explicitMediaDeviceOperationDepth - 1
      );
    }
  }

  private notifyMediaDeviceError(message: string): void {
    const now = Date.now();
    if (
      this.lastMediaDeviceToast &&
      this.lastMediaDeviceToast.message === message &&
      now - this.lastMediaDeviceToast.shownAt < MEDIA_DEVICE_TOAST_DEDUPLICATION_MS
    ) {
      return;
    }

    this.lastMediaDeviceToast = { message, shownAt: now };
    toast.error(message);
  }

  private consumePendingOwnJoinSound(): boolean {
    const pending = this.pendingOwnJoinSound;
    if (!pending) return false;
    this.pendingOwnJoinSound = null;
    return this.matchesActiveCall(pending.roomId, pending.callId);
  }

  private matchesRecentlyDisconnectedCall(roomId: string, callId: string): boolean {
    const recentlyDisconnectedCall = this.recentlyDisconnectedCall;
    if (!recentlyDisconnectedCall) return false;
    if (
      Date.now() - recentlyDisconnectedCall.disconnectedAt >
      RECENTLY_DISCONNECTED_CALL_SOUND_MS
    ) {
      this.recentlyDisconnectedCall = null;
      return false;
    }
    return recentlyDisconnectedCall.roomId === roomId && recentlyDisconnectedCall.callId === callId;
  }
}

/** Parse the JSON metadata string from a LiveKit participant. */
function parseParticipantMetadata(metadata: string | undefined): ParticipantMetadata {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata) as ParticipantMetadata;
  } catch {
    return {};
  }
}

function isParticipantMuted(participant: Participant): boolean {
  for (const pub of participant.getTrackPublications()) {
    if (pub.track?.source === Track.Source.Microphone) {
      return pub.isMuted;
    }
  }
  // No audio track = effectively muted
  return true;
}

function isParticipantCameraEnabled(participant: Participant): boolean {
  for (const pub of participant.getTrackPublications()) {
    if (pub.track?.source === Track.Source.Camera) {
      return !pub.isMuted;
    }
  }
  return false;
}

function getParticipantCameraTrack(participant: Participant): Track | null {
  for (const pub of participant.getTrackPublications()) {
    if (pub.track?.source === Track.Source.Camera && !pub.isMuted) {
      return pub.track;
    }
  }
  return null;
}

function isParticipantScreenShareEnabled(participant: Participant): boolean {
  for (const pub of participant.getTrackPublications()) {
    if (pub.track?.source === Track.Source.ScreenShare) {
      return !pub.isMuted;
    }
  }
  return false;
}

function getParticipantScreenShareTrack(participant: Participant): Track | null {
  for (const pub of participant.getTrackPublications()) {
    if (pub.track?.source === Track.Source.ScreenShare && !pub.isMuted) {
      return pub.track;
    }
  }
  return null;
}

function assertLiveKitE2EESupported(): void {
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const senderCtor = globals.RTCRtpSender as { prototype?: object } | undefined;
  const senderProto = senderCtor?.prototype as Record<string, unknown> | undefined;
  const hasEncodedTransform =
    typeof globals.RTCRtpScriptTransform === 'function' ||
    typeof senderProto?.createEncodedStreams === 'function';

  if (
    typeof globals.Worker !== 'function' ||
    typeof globals.TransformStream !== 'function' ||
    typeof globals.ReadableStream !== 'function' ||
    typeof globals.WritableStream !== 'function' ||
    !globals.crypto ||
    typeof globals.crypto !== 'object' ||
    !('subtle' in globals.crypto) ||
    !hasEncodedTransform
  ) {
    throw new VoiceCallJoinError(
      'LiveKit E2EE is not supported by this browser',
      m['voice.encrypted_unsupported']()
    );
  }
}

function summarizeJoinError(err: unknown): string {
  return redactSensitiveUrlParts(errorMessage(err));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorName(err: unknown): string {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) return err.name;
  if (err instanceof Error) return err.name;
  return '';
}

function classifyMediaDeviceFailure(err: unknown): MediaDeviceFailureKind {
  const name = errorName(err).toLowerCase();
  const message = errorMessage(err).toLowerCase();
  const signal = `${name} ${message}`;

  if (
    signal.includes('notallowed') ||
    signal.includes('permissiondenied') ||
    signal.includes('permission denied') ||
    signal.includes('securityerror')
  ) {
    return 'permission-denied';
  }

  if (
    signal.includes('notfound') ||
    signal.includes('devicesnotfound') ||
    signal.includes('device not found') ||
    signal.includes('no device')
  ) {
    return 'not-found';
  }

  if (
    signal.includes('notreadable') ||
    signal.includes('trackstarterror') ||
    signal.includes('deviceinuse') ||
    signal.includes('device in use') ||
    signal.includes('already in use')
  ) {
    return 'in-use';
  }

  if (signal.includes('overconstrained') || signal.includes('constraint')) {
    return 'constraint';
  }

  if (signal.includes('abort')) {
    return 'aborted';
  }

  return 'unknown';
}

function redactSensitiveUrlParts(message: string): string {
  return message
    .replace(/access_token=([^&\s]+)/gi, 'access_token=<redacted>')
    .replace(/join_request=([^&\s]+)/gi, 'join_request=<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<jwt-redacted>');
}
