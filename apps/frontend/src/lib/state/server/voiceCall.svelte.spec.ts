import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceCallAPI } from '$lib/api-client/voiceCalls';

const { soundMocks, toastMocks } = vi.hoisted(() => ({
  soundMocks: {
    playCallSound: vi.fn(() => Promise.resolve())
  },
  toastMocks: {
    error: vi.fn()
  }
}));

vi.mock('$lib/audio/callSounds', () => ({
  playCallSound: soundMocks.playCallSound
}));

vi.mock('$lib/ui/toast', () => ({
  toast: toastMocks
}));

import {
  DEFAULT_SCREEN_SHARE_CEILING,
  getVoiceCallMediaDeviceErrorMessage,
  getVoiceCallJoinErrorMessage,
  VoiceCallJoinError,
  VoiceCallState
} from './voiceCall.svelte';
import { DEFAULT_SCREEN_SHARE_QUALITY, resolveScreenShareOptions } from './screenShareQuality';
import { Room } from 'livekit-client';

const calls: string[] = [];
let lastRoomOptions: Record<string, unknown> | null = null;
let lastKeyProvider: { setKey: ReturnType<typeof vi.fn> } | null = null;
let lastRoom: {
  disconnect: ReturnType<typeof vi.fn>;
  localParticipant: {
    setMicrophoneEnabled: ReturnType<typeof vi.fn>;
    setScreenShareEnabled: ReturnType<typeof vi.fn>;
    setCameraEnabled: ReturnType<typeof vi.fn>;
    // Overridden per-test to stand in for the live screen-share publication whose capture
    // track and RTCRtpSender get retuned by setScreenShareQuality().
    getTrackPublication: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
  };
  switchActiveDevice: ReturnType<typeof vi.fn>;
} | null = null;
let connectFailure: Error | null = null;
let connectGate: { promise: Promise<void>; resolve: () => void } | null = null;
let microphoneGate: { promise: Promise<void>; resolve: () => void } | null = null;
let microphoneFailure: Error | null = null;
let cameraGate: { promise: Promise<void>; resolve: () => void } | null = null;
let cameraFailure: Error | null = null;
let screenShareGate: { promise: Promise<void>; resolve: () => void } | null = null;
let screenShareFailure: Error | null = null;
let switchActiveDeviceFailure: Error | null = null;
let roomEventHandlers = new Map<string, (...args: unknown[]) => void>();
let localTrackPublications: Array<{
  isMuted: boolean;
  track: { source: string; mediaStreamTrack?: MediaStreamTrack };
}> = [];
let mockRemoteParticipants = new Map<string, unknown>();

vi.mock('livekit-client', () => {
  class MockExternalE2EEKeyProvider {
    setKey: ReturnType<typeof vi.fn>;

    constructor() {
      const setKey = vi.fn(async (key: string) => {
        calls.push(`setKey:${key}`);
      });
      this.setKey = setKey;
      lastKeyProvider = { setKey };
    }
  }

  class MockRoom {
    static getLocalDevices = vi.fn(async (kind?: MediaDeviceKind) => {
      if (kind === 'audioinput') {
        return [{ deviceId: 'audio-input-1', kind, label: 'Microphone' }];
      }
      if (kind === 'audiooutput') {
        return [{ deviceId: 'audio-output-1', kind, label: 'Speaker' }];
      }
      if (kind === 'videoinput') {
        return [{ deviceId: 'video-input-1', kind, label: 'Camera' }];
      }
      return [];
    });

    localParticipant = {
      setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
        calls.push('setMicrophoneEnabled');
        await microphoneGate?.promise;
        if (enabled && microphoneFailure) {
          roomEventHandlers.get('MediaDevicesError')?.(microphoneFailure, 'audioinput');
          throw microphoneFailure;
        }
      }),
      setCameraEnabled: vi.fn(async (enabled: boolean) => {
        calls.push(`setCameraEnabled:${enabled}`);
        await cameraGate?.promise;
        if (enabled && cameraFailure) {
          roomEventHandlers.get('MediaDevicesError')?.(cameraFailure, 'videoinput');
          throw cameraFailure;
        }
        localTrackPublications = localTrackPublications.filter(
          (pub) => pub.track.source !== 'camera'
        );
        if (enabled) {
          localTrackPublications.push({
            isMuted: false,
            track: { source: 'camera' }
          });
        }
      }),
      setScreenShareEnabled: vi.fn(async (enabled: boolean) => {
        calls.push(`setScreenShareEnabled:${enabled}`);
        await screenShareGate?.promise;
        if (screenShareFailure) {
          roomEventHandlers.get('MediaDevicesError')?.(screenShareFailure, 'videoinput');
          throw screenShareFailure;
        }
        localTrackPublications = localTrackPublications.filter(
          (pub) => pub.track.source !== 'screen_share'
        );
        if (enabled) {
          localTrackPublications.push({
            isMuted: false,
            track: { source: 'screen_share' }
          });
        }
      }),
      getTrackPublication: vi.fn(),
      setAttributes: vi.fn(async (attrs: Record<string, string>) => {
        calls.push(`setAttributes:${JSON.stringify(attrs)}`);
      }),
      identity: 'local-user',
      name: 'Local User',
      metadata: '',
      attributes: {} as Record<string, string>,
      connectionQuality: 'excellent',
      isSpeaking: false,
      audioLevel: 0,
      getTrackPublications: vi.fn(() => localTrackPublications)
    };
    remoteParticipants = mockRemoteParticipants;

    constructor(options: Record<string, unknown>) {
      lastRoomOptions = options;
      lastRoom = {
        disconnect: this.disconnect,
        localParticipant: this.localParticipant,
        switchActiveDevice: this.switchActiveDevice
      };
    }

    on = vi.fn((event: string, handler: () => void) => {
      roomEventHandlers.set(event, handler);
      return this;
    });
    switchActiveDevice = vi.fn(async (kind: MediaDeviceKind, deviceId: string) => {
      calls.push(`switchActiveDevice:${kind}:${deviceId}`);
      if (switchActiveDeviceFailure) {
        roomEventHandlers.get('MediaDevicesError')?.(switchActiveDeviceFailure, kind);
        throw switchActiveDeviceFailure;
      }
    });
    connect = vi.fn(async () => {
      calls.push('connect');
      await connectGate?.promise;
      if (connectFailure) {
        throw connectFailure;
      }
    });
    setE2EEEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setE2EEEnabled:${enabled}`);
    });
    disconnect = vi.fn();
    removeAllListeners = vi.fn();
  }

  return {
    Room: MockRoom,
    ExternalE2EEKeyProvider: MockExternalE2EEKeyProvider,
    RoomEvent: {
      ParticipantConnected: 'ParticipantConnected',
      ParticipantDisconnected: 'ParticipantDisconnected',
      ParticipantAttributesChanged: 'ParticipantAttributesChanged',
      TrackMuted: 'TrackMuted',
      TrackUnmuted: 'TrackUnmuted',
      Disconnected: 'Disconnected',
      MediaDevicesChanged: 'MediaDevicesChanged',
      MediaDevicesError: 'MediaDevicesError',
      ConnectionQualityChanged: 'ConnectionQualityChanged',
      TrackSubscribed: 'TrackSubscribed',
      TrackUnsubscribed: 'TrackUnsubscribed',
      TrackPublished: 'TrackPublished',
      TrackUnpublished: 'TrackUnpublished',
      LocalTrackPublished: 'LocalTrackPublished',
      LocalTrackUnpublished: 'LocalTrackUnpublished'
    },
    Track: {
      Kind: { Audio: 'audio' },
      Source: { Microphone: 'microphone', Camera: 'camera', ScreenShare: 'screen_share' }
    },
    AudioPresets: { speech: {} },
    VideoPresets: { h720: { resolution: {} } }
  };
});

vi.mock('livekit-client/e2ee-worker?worker', () => ({
  default: class MockE2EEWorker {
    terminate = vi.fn();
  }
}));

function createVoiceCallClient(overrides: Partial<VoiceCallAPI> = {}): VoiceCallAPI {
  return {
    listActiveCalls: vi.fn(async () => []),
    getActiveCall: vi.fn(async () => null),
    batchGetActiveCalls: vi.fn(async () => []),
    listCallParticipants: vi.fn(async () => []),
    joinCall: vi.fn(async () => true),
    getCallToken: vi.fn(async () => ({
      token: 'livekit-token',
      e2eeKey: 'shared-e2ee-key',
      callId: 'call-1'
    })),
    leaveCall: vi.fn(async () => true),
    ...overrides
  };
}

// The options a default (1080p60, no audio) share publishes against the default 8 Mbps
// ceiling. Derived from the mapper rather than hand-written so these stay in lockstep with
// screenShareQuality.ts, which owns the encoder decisions and tests them in detail.
const EXPECTED_SCREEN_SHARE_CAPTURE = resolveScreenShareOptions(
  DEFAULT_SCREEN_SHARE_QUALITY,
  DEFAULT_SCREEN_SHARE_CEILING
).capture;
const EXPECTED_SCREEN_SHARE_PUBLISH = resolveScreenShareOptions(
  DEFAULT_SCREEN_SHARE_QUALITY,
  DEFAULT_SCREEN_SHARE_CEILING
).publish;

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushPromises(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('VoiceCallState', () => {
  beforeEach(() => {
    calls.length = 0;
    lastRoomOptions = null;
    lastKeyProvider = null;
    lastRoom = null;
    connectFailure = null;
    connectGate = null;
    microphoneGate = null;
    microphoneFailure = null;
    cameraGate = null;
    cameraFailure = null;
    screenShareGate = null;
    screenShareFailure = null;
    switchActiveDeviceFailure = null;
    roomEventHandlers = new Map();
    localTrackPublications = [];
    mockRemoteParticipants = new Map();
    vi.stubGlobal('Worker', class MockWorker {});
    vi.stubGlobal('TransformStream', class MockTransformStream {});
    vi.stubGlobal('ReadableStream', class MockReadableStream {});
    vi.stubGlobal('WritableStream', class MockWritableStream {});
    vi.stubGlobal('RTCRtpScriptTransform', class MockRTCRtpScriptTransform {});
    vi.stubGlobal('crypto', { subtle: {} });
    soundMocks.playCallSound.mockClear();
    toastMocks.error.mockClear();
    vi.mocked(Room.getLocalDevices).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes explicit voiceIsolation capture constraints from the noise suppression mode', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    // Pin the shared preference so leftovers from other tests cannot leak in.
    await state.noiseSuppression.setMode('off');

    await state.join('wss://livekit.example.test', 'R1');

    // livekit-client's own audioDefaults request voiceIsolation: true, so the
    // effective Room options must carry an explicit false for the off mode.
    expect(lastRoomOptions?.audioCaptureDefaults).toMatchObject({
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: false
    });
  });

  it('drops empty and duplicate device ids so the device menu keys stay unique', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);

    // refreshDevices enumerates audioinput, then audiooutput, then videoinput.
    // Browsers hand back empty-deviceId placeholders for categories without
    // permission (e.g. cameras while video is off); several of them collide on
    // deviceId === '' and previously broke the keyed {#each} in the menu.
    const dev = (deviceId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo => ({
      deviceId,
      kind,
      label,
      groupId: 'group',
      toJSON: () => ({})
    });
    vi.mocked(Room.getLocalDevices)
      .mockImplementationOnce(async () => [
        dev('mic-1', 'audioinput', 'Mic'),
        dev('mic-1', 'audioinput', 'Mic (dup)'),
        dev('', 'audioinput', '')
      ])
      .mockImplementationOnce(async () => [dev('spk-1', 'audiooutput', 'Speaker')])
      .mockImplementationOnce(async () => [dev('', 'videoinput', ''), dev('', 'videoinput', '')]);

    await state.refreshDevices();

    expect(state.audioDevices.map((d) => d.deviceId)).toEqual(['mic-1']);
    expect(state.audioOutputDevices.map((d) => d.deviceId)).toEqual(['spk-1']);
    expect(state.videoDevices).toEqual([]);
    // No placeholder ('') ids survive to become non-unique {#each} keys.
    const allIds = [...state.audioDevices, ...state.audioOutputDevices, ...state.videoDevices].map(
      (d) => d.deviceId
    );
    expect(allIds.every((id) => id !== '')).toBe(true);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('requests voiceIsolation at capture when the voice isolation mode is selected', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.noiseSuppression.setMode('voice-isolation');
    try {
      await state.join('wss://livekit.example.test', 'R1');

      expect(lastRoomOptions?.audioCaptureDefaults).toMatchObject({
        voiceIsolation: true
      });
    } finally {
      // The preference is module-global; restore for unrelated tests.
      await state.noiseSuppression.setMode('off');
    }
  });

  it('sets up LiveKit E2EE before connecting', async () => {
    const client = createVoiceCallClient();

    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');

    expect(client.joinCall).toHaveBeenCalledWith('R1');
    expect(lastKeyProvider?.setKey).toHaveBeenCalledWith('shared-e2ee-key');
    expect(lastRoomOptions?.encryption).toMatchObject({
      keyProvider: lastKeyProvider
    });
    expect(calls.indexOf('setKey:shared-e2ee-key')).toBeLessThan(
      calls.indexOf('setE2EEEnabled:true')
    );
    expect(calls.indexOf('setE2EEEnabled:true')).toBeLessThan(calls.indexOf('connect'));
  });

  it('configures microphone capture and publication as mono', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);

    await state.join('wss://livekit.example.test', 'R1');

    expect(lastRoomOptions?.audioCaptureDefaults).toMatchObject({
      channelCount: { ideal: 1 }
    });
    expect(lastRoomOptions?.publishDefaults).toMatchObject({
      forceStereo: false
    });
  });

  it('does not play a join sound without the participant join event', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);

    await state.join('wss://livekit.example.test', 'R1');

    expect(soundMocks.playCallSound).not.toHaveBeenCalled();
  });

  it('joins with microphone enabled but does not request camera permission while refreshing devices', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);

    await state.join('wss://livekit.example.test', 'R1');

    expect(lastRoom?.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(lastRoom?.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(Room.getLocalDevices).toHaveBeenCalledWith('audioinput');
    expect(Room.getLocalDevices).toHaveBeenCalledWith('audiooutput');
    expect(Room.getLocalDevices).toHaveBeenCalledWith('videoinput', false);
    expect(Room.getLocalDevices).not.toHaveBeenCalledWith('videoinput');
    expect(Room.getLocalDevices).not.toHaveBeenCalledWith('videoinput', true);
  });

  it('joins muted when microphone enable fails without enabling the camera', async () => {
    microphoneFailure = new Error('microphone unavailable');
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);

    await state.join('wss://livekit.example.test', 'R1');

    expect(lastRoom?.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(lastRoom?.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(state.isMuted).toBe(true);
    expect(state.isInAnyCall).toBe(true);
    expect(Room.getLocalDevices).toHaveBeenCalledWith('videoinput', false);
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Could not start your microphone. You joined muted.'
    );
    expect(toastMocks.error).toHaveBeenCalledOnce();
  });

  it('plays a deferred current-user join event after connecting successfully', async () => {
    connectGate = deferredVoid();
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);

    const join = state.join('wss://livekit.example.test', 'R1');
    await flushPromises();

    expect(state.callTransitionSoundDecision('join', 'R1', 'call-1', true)).toBe('defer');
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();

    connectGate.resolve();
    await join;

    expect(soundMocks.playCallSound).toHaveBeenCalledOnce();
    expect(soundMocks.playCallSound).toHaveBeenCalledWith('join');
  });

  it('fails before recording join intent when encrypted calls are unsupported', async () => {
    vi.stubGlobal('RTCRtpScriptTransform', undefined);
    vi.stubGlobal('RTCRtpSender', class MockRTCRtpSender {});

    const client = createVoiceCallClient();

    const state = new VoiceCallState(client);

    await expect(state.join('wss://livekit.example.test', 'R1')).rejects.toThrow(
      VoiceCallJoinError
    );

    expect(client.joinCall).not.toHaveBeenCalled();
    expect(client.getCallToken).not.toHaveBeenCalled();
    expect(state.isInAnyCall).toBe(false);
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();
  });

  it('maps signaling failures to an actionable join error message', () => {
    const error = new Error('could not establish signal connection: Abort handler called');

    expect(getVoiceCallJoinErrorMessage(error)).toBe(
      'Could not reach the voice server. Check your network and try again.'
    );
  });

  it('coalesces duplicate joins for the same room while connecting', async () => {
    const client = createVoiceCallClient();

    const state = new VoiceCallState(client);
    await Promise.all([
      state.join('wss://livekit.example.test', 'R1'),
      state.join('wss://livekit.example.test', 'R1')
    ]);

    expect(client.joinCall).toHaveBeenCalledTimes(1);
    expect(client.getCallToken).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call === 'connect')).toHaveLength(1);
  });

  it('coalesces duplicate leave actions while the leave intent is in flight', async () => {
    const client = createVoiceCallClient();

    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    soundMocks.playCallSound.mockClear();

    await Promise.all([state.leave(), state.leave()]);

    expect(client.joinCall).toHaveBeenCalledTimes(1);
    expect(client.leaveCall).toHaveBeenCalledTimes(1);
    expect(lastRoom?.disconnect).toHaveBeenCalledOnce();
    expect(state.isInAnyCall).toBe(false);
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();
  });

  describe('push-to-talk', () => {
    async function joinMuted(): Promise<VoiceCallState> {
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');
      await state.toggleMute();
      lastRoom?.localParticipant.setMicrophoneEnabled.mockClear();
      return state;
    }

    it('temporarily unmutes on press and restores mute on release', async () => {
      const state = await joinMuted();

      await state.setPushToTalkPressed(true);
      expect(state.isMuted).toBe(false);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);

      await state.setPushToTalkPressed(false);
      expect(state.isMuted).toBe(true);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    });

    it('does not take ownership of a microphone that was already unmuted', async () => {
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');
      lastRoom?.localParticipant.setMicrophoneEnabled.mockClear();

      await state.setPushToTalkPressed(true);
      await state.setPushToTalkPressed(false);

      expect(state.isMuted).toBe(false);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    });

    it('never undeafens or enables the microphone while deafened', async () => {
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');
      await state.toggleDeafen();
      lastRoom?.localParticipant.setMicrophoneEnabled.mockClear();

      await state.setPushToTalkPressed(true);
      await state.setPushToTalkPressed(false);

      expect(state.isDeafened).toBe(true);
      expect(state.isMuted).toBe(true);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    });

    it('coalesces duplicate press and release events', async () => {
      const state = await joinMuted();

      await state.setPushToTalkPressed(true);
      await state.setPushToTalkPressed(true);
      await state.setPushToTalkPressed(false);
      await state.setPushToTalkPressed(false);

      expect(lastRoom?.localParticipant.setMicrophoneEnabled.mock.calls).toEqual([[true], [false]]);
    });

    it('restores mute when release arrives while microphone enable is pending', async () => {
      const state = await joinMuted();
      microphoneGate = deferredVoid();

      const press = state.setPushToTalkPressed(true);
      await flushPromises();
      const release = state.setPushToTalkPressed(false);

      expect(state.isMuted).toBe(true);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled.mock.calls).toEqual([[true]]);

      microphoneGate.resolve();
      await Promise.all([press, release]);

      expect(state.isMuted).toBe(true);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled.mock.calls).toEqual([[true], [false]]);
    });

    it('stays muted if push-to-talk cannot enable the microphone', async () => {
      const state = await joinMuted();
      microphoneFailure = new Error('microphone unavailable');

      await state.setPushToTalkPressed(true);
      await state.setPushToTalkPressed(false);

      expect(state.isMuted).toBe(true);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled.mock.calls).toEqual([[true]]);
      expect(toastMocks.error).toHaveBeenCalled();
    });

    it('ignores a late push-to-talk completion after leaving', async () => {
      const state = await joinMuted();
      microphoneGate = deferredVoid();
      const press = state.setPushToTalkPressed(true);
      await flushPromises();

      await state.leave();
      microphoneGate.resolve();
      await press;
      await state.setPushToTalkPressed(false);

      expect(state.isInAnyCall).toBe(false);
      expect(lastRoom?.disconnect).toHaveBeenCalledOnce();
      expect(lastRoom?.localParticipant.setMicrophoneEnabled.mock.calls).toEqual([[true]]);
    });
  });

  it('records a compensating leave when LiveKit connect fails after join intent', async () => {
    connectFailure = new Error('connect failed');
    const client = createVoiceCallClient();

    const state = new VoiceCallState(client);

    await expect(state.join('wss://livekit.example.test', 'R1')).rejects.toThrow('connect failed');

    expect(client.joinCall).toHaveBeenCalledTimes(1);
    expect(client.leaveCall).toHaveBeenCalledWith('R1');
    expect(state.isInAnyCall).toBe(false);
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();
  });

  it('disconnects without recording leave when the backend ends the current call', async () => {
    const client = createVoiceCallClient();

    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    soundMocks.playCallSound.mockClear();

    state.handleCallEndedEvent('R1', 'old-call');
    expect(lastRoom?.disconnect).not.toHaveBeenCalled();
    expect(state.isInAnyCall).toBe(true);
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();

    state.handleCallEndedEvent('R1', 'call-1');

    expect(lastRoom?.disconnect).toHaveBeenCalledOnce();
    expect(client.joinCall).toHaveBeenCalledTimes(1);
    expect(client.leaveCall).not.toHaveBeenCalled();
    expect(state.isInAnyCall).toBe(false);
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();
  });

  it('disconnects only for the current user participant leave event', async () => {
    const client = createVoiceCallClient();

    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    soundMocks.playCallSound.mockClear();

    state.handleParticipantLeftEvent('R1', 'call-1', 'remote-user', 'local-user');
    expect(lastRoom?.disconnect).not.toHaveBeenCalled();
    expect(state.isInAnyCall).toBe(true);
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();

    state.handleParticipantLeftEvent('R1', 'old-call', 'local-user', 'local-user');
    expect(lastRoom?.disconnect).not.toHaveBeenCalled();
    expect(state.isInAnyCall).toBe(true);
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();

    state.handleParticipantLeftEvent('R1', 'call-1', 'local-user', 'local-user');
    expect(lastRoom?.disconnect).toHaveBeenCalledOnce();
    expect(client.joinCall).toHaveBeenCalledTimes(1);
    expect(client.leaveCall).not.toHaveBeenCalled();
    expect(state.isInAnyCall).toBe(false);
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();
    expect(state.callTransitionSoundDecision('leave', 'R1', 'call-1', true)).toBe('play');
  });

  it('matches only the currently connected call', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');

    expect(state.matchesActiveCall('R1', 'call-1')).toBe(true);
    expect(state.matchesActiveCall('R1', 'old-call')).toBe(false);
    expect(state.matchesActiveCall('R2', 'call-1')).toBe(false);
    expect(state.matchesActiveCall('R1', null)).toBe(false);
  });

  it('toggles video-only screen sharing through LiveKit', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');

    await state.toggleScreenShare();

    // Must be `screenShareEncoding`: LiveKit's computeVideoEncodings() discards `videoEncoding` on
    // screen-share tracks, silently falling back to ScreenSharePresets.h1080fps15 (15fps @ 2.5Mbps).
    expect(lastRoom?.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(
      true,
      EXPECTED_SCREEN_SHARE_CAPTURE,
      EXPECTED_SCREEN_SHARE_PUBLISH
    );
    const publishOptions = vi.mocked(lastRoom!.localParticipant.setScreenShareEnabled).mock
      .calls[0][2];
    expect(publishOptions).not.toHaveProperty('videoEncoding');
    expect(state.isScreenShareEnabled).toBe(true);
    expect(state.participants[0]).toMatchObject({
      identity: 'local-user',
      isCameraEnabled: false,
      isScreenShareEnabled: true
    });
    expect(state.participants[0].videoTrack).toBeNull();
    expect(state.participants[0].screenShareTrack).toMatchObject(localTrackPublications[0].track);

    await state.toggleScreenShare();

    expect(lastRoom?.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(false);
    expect(state.isScreenShareEnabled).toBe(false);
    expect(state.participants[0].screenShareTrack).toBeNull();
  });

  it('retunes a live screen share in place instead of republishing it', async () => {
    const applyConstraints = vi.fn(async () => {});
    const setParameters = vi.fn(async () => {});
    const params: RTCRtpSendParameters = {
      encodings: [{}],
      transactionId: 't',
      codecs: [],
      headerExtensions: [],
      rtcp: {}
    };
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    lastRoom!.localParticipant.getTrackPublication = vi.fn(() => ({
      track: {
        mediaStreamTrack: { applyConstraints },
        sender: { getParameters: () => params, setParameters }
      }
    }));
    await state.toggleScreenShare();
    const publishCallsBefore = vi.mocked(lastRoom!.localParticipant.setScreenShareEnabled).mock
      .calls.length;

    await state.setScreenShareQuality({ resolution: '720p', framerate: 30, shareAudio: false });

    // The share must NOT be republished: that would call getDisplayMedia() again and force the
    // user to re-pick their window every time they changed the frame rate.
    expect(vi.mocked(lastRoom!.localParticipant.setScreenShareEnabled).mock.calls.length).toBe(
      publishCallsBefore
    );
    expect(applyConstraints).toHaveBeenCalledWith({ width: 1280, height: 720, frameRate: 30 });
    expect(setParameters).toHaveBeenCalledTimes(1);
    // 720p30 -> 2.5 Mbps on Discord's ladder.
    expect(params.encodings[0]).toMatchObject({ maxBitrate: 2_500_000, maxFramerate: 30 });
    expect(params.degradationPreference).toBe('maintain-framerate');
    expect(state.screenShareQuality).toEqual({
      resolution: '720p',
      framerate: 30,
      shareAudio: false
    });
    expect(state.screenShareRetuneFailed).toBe(false);
  });

  it('keeps the quality preference and flags it when a live share cannot be retuned', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    // No sender attached — e.g. LiveKit has not negotiated the track yet.
    lastRoom!.localParticipant.getTrackPublication = vi.fn(() => ({
      track: { mediaStreamTrack: { applyConstraints: vi.fn(async () => {}) }, sender: undefined }
    }));
    await state.toggleScreenShare();

    await state.setScreenShareQuality({ resolution: '720p', framerate: 30, shareAudio: false });

    // Saved for next time, and the UI is told rather than silently doing nothing.
    expect(state.screenShareQuality.resolution).toBe('720p');
    expect(state.screenShareRetuneFailed).toBe(true);
    expect(state.isScreenShareEnabled).toBe(true);
  });

  it('clamps a quality choice the server ceiling forbids', async () => {
    const client = createVoiceCallClient();
    // Self-hoster capped screen sharing at 720p30.
    const state = new VoiceCallState(client, () => ({
      maxWidth: 1280,
      maxHeight: 720,
      maxFramerate: 30,
      maxBitrate: 3_000_000
    }));
    await state.join('wss://livekit.example.test', 'R1');

    await state.setScreenShareQuality({ resolution: '1080p', framerate: 60, shareAudio: false });

    expect(state.screenShareQuality).toEqual({
      resolution: '720p',
      framerate: 30,
      shareAudio: false
    });
  });

  it('keeps microphone pending until LiveKit applies the toggle', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    microphoneGate = deferredVoid();

    const toggle = state.toggleMute();
    await flushPromises();

    expect(state.isMicrophonePending).toBe(true);
    expect(state.isMuted).toBe(false);
    expect(lastRoom?.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    microphoneGate.resolve();
    await toggle;

    expect(state.isMicrophonePending).toBe(false);
    expect(state.isMuted).toBe(true);
  });

  it('keeps camera pending until LiveKit applies the toggle', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    cameraGate = deferredVoid();

    const toggle = state.toggleCamera();
    await flushPromises();

    expect(state.isCameraPending).toBe(true);
    expect(state.isCameraEnabled).toBe(false);
    expect(lastRoom?.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(true);

    cameraGate.resolve();
    await toggle;

    expect(state.isCameraPending).toBe(false);
    expect(state.isCameraEnabled).toBe(true);
  });

  it('refreshes devices without camera permission until camera is explicitly enabled', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    vi.mocked(Room.getLocalDevices).mockClear();

    await state.refreshDevices();
    roomEventHandlers.get('MediaDevicesChanged')?.();
    await flushPromises();

    expect(Room.getLocalDevices).toHaveBeenCalledWith('videoinput', false);
    expect(Room.getLocalDevices).not.toHaveBeenCalledWith('videoinput', true);

    vi.mocked(Room.getLocalDevices).mockClear();
    await state.toggleCamera();

    expect(lastRoom?.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(Room.getLocalDevices).toHaveBeenCalledWith('videoinput', true);
  });

  it('keeps screen share pending until LiveKit applies the toggle', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    screenShareGate = deferredVoid();

    const toggle = state.toggleScreenShare();
    await flushPromises();

    expect(state.isScreenSharePending).toBe(true);
    expect(state.isScreenShareEnabled).toBe(false);
    expect(lastRoom?.localParticipant.setScreenShareEnabled).toHaveBeenLastCalledWith(
      true,
      EXPECTED_SCREEN_SHARE_CAPTURE,
      EXPECTED_SCREEN_SHARE_PUBLISH
    );

    screenShareGate.resolve();
    await toggle;

    expect(state.isScreenSharePending).toBe(false);
    expect(state.isScreenShareEnabled).toBe(true);
  });

  it('keeps the call connected when screen capture fails', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    screenShareFailure = new Error('permission denied');

    await state.toggleScreenShare();

    expect(lastRoom?.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(
      true,
      EXPECTED_SCREEN_SHARE_CAPTURE,
      EXPECTED_SCREEN_SHARE_PUBLISH
    );
    expect(state.isScreenShareEnabled).toBe(false);
    expect(state.isInAnyCall).toBe(true);
    expect(state.roomId).toBe('R1');
    expect(toastMocks.error).toHaveBeenCalledWith('Screen sharing was cancelled or blocked.');
    expect(toastMocks.error).toHaveBeenCalledOnce();
  });

  it('reports permission failures when enabling media devices', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    toastMocks.error.mockClear();

    microphoneFailure = Object.assign(new Error('Permission denied'), {
      name: 'NotAllowedError'
    });
    await state.toggleMute();
    expect(state.isMuted).toBe(true);
    expect(toastMocks.error).not.toHaveBeenCalled();

    await state.toggleMute();
    expect(state.isMuted).toBe(true);
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Microphone access was denied. Check your browser permissions and try again.'
    );
    expect(toastMocks.error).toHaveBeenCalledOnce();

    cameraFailure = Object.assign(new Error('Device unavailable'), {
      name: 'NotReadableError'
    });
    toastMocks.error.mockClear();
    await state.toggleCamera();
    expect(state.isCameraEnabled).toBe(false);
    expect(toastMocks.error).toHaveBeenCalledWith('Your camera is already in use by another app.');
    expect(toastMocks.error).toHaveBeenCalledOnce();
  });

  it('reports LiveKit media device errors without disconnecting', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    toastMocks.error.mockClear();

    roomEventHandlers.get('MediaDevicesError')?.();

    expect(toastMocks.error).toHaveBeenCalledWith('Could not access a media device.');
    expect(toastMocks.error).toHaveBeenCalledOnce();
    expect(state.isInAnyCall).toBe(true);
  });

  it('keeps selected devices unchanged when device switching fails', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    toastMocks.error.mockClear();
    switchActiveDeviceFailure = Object.assign(new Error('device not found'), {
      name: 'NotFoundError'
    });

    await state.setAudioDevice('missing-mic');
    await state.setAudioOutputDevice('missing-speaker');
    await state.setVideoDevice('missing-camera');

    expect(state.selectedDeviceId).toBe('audio-input-1');
    expect(state.selectedOutputDeviceId).toBe('audio-output-1');
    expect(state.selectedVideoDeviceId).toBe('video-input-1');
    expect(toastMocks.error).toHaveBeenCalledWith(
      'No microphone was found. Choose another input device and try again.'
    );
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Could not switch speakers. This browser or device may not support speaker selection.'
    );
    expect(toastMocks.error).toHaveBeenCalledWith(
      'No camera was found. Choose another camera and try again.'
    );
    expect(toastMocks.error).toHaveBeenCalledTimes(3);
    expect(toastMocks.error).not.toHaveBeenCalledWith('Could not access a media device.');
  });

  it('maps media device failures to specific user-facing messages', () => {
    expect(
      getVoiceCallMediaDeviceErrorMessage(
        'screen',
        Object.assign(new Error('permission denied'), { name: 'NotAllowedError' }),
        'enable'
      )
    ).toBe('Screen sharing was cancelled or blocked.');
    expect(
      getVoiceCallMediaDeviceErrorMessage(
        'microphone',
        Object.assign(new Error('already in use'), { name: 'NotReadableError' }),
        'join'
      )
    ).toBe('Your microphone is already in use by another app. You joined muted.');
  });

  it('keeps camera and screen-share tracks separate', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');

    await state.toggleCamera();
    const cameraTrack = localTrackPublications.find((pub) => pub.track.source === 'camera')!.track;
    await state.toggleScreenShare();
    const screenShareTrack = localTrackPublications.find(
      (pub) => pub.track.source === 'screen_share'
    )!.track;

    expect(state.participants[0]).toMatchObject({
      isCameraEnabled: true,
      isScreenShareEnabled: true
    });
    expect(state.participants[0].videoTrack).toMatchObject(cameraTrack);
    expect(state.participants[0].screenShareTrack).toMatchObject(screenShareTrack);
    expect(cameraTrack).not.toBe(screenShareTrack);
  });

  it('clears screen-share state on leave', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    await state.toggleScreenShare();

    await state.leave();

    expect(state.isScreenShareEnabled).toBe(false);
    expect(state.participants).toEqual([]);
  });

  it('updates screen-share state when LiveKit reports local unpublish', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    await state.toggleScreenShare();
    expect(state.isScreenShareEnabled).toBe(true);

    localTrackPublications = [];
    roomEventHandlers.get('LocalTrackUnpublished')?.();

    expect(state.isScreenShareEnabled).toBe(false);
    expect(state.participants[0].screenShareTrack).toBeNull();
  });

  it('locally mutes and unmutes remote participant audio for the current session only', async () => {
    const setVolume = vi.fn();
    mockRemoteParticipants.set('remote-user', {
      identity: 'remote-user',
      name: 'Remote User',
      metadata: '',
      connectionQuality: 'good',
      isSpeaking: false,
      audioLevel: 0,
      setVolume,
      trackPublications: new Map(),
      getTrackPublications: vi.fn(() => [{ isMuted: false, track: { source: 'microphone' } }])
    });
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);

    await state.join('wss://livekit.example.test', 'R1');
    setVolume.mockClear();

    state.toggleParticipantLocalMute('remote-user');

    expect(state.isParticipantLocallyMuted('remote-user')).toBe(true);
    expect(setVolume).toHaveBeenLastCalledWith(0);
    expect(state.participants.find((p) => p.identity === 'remote-user')).toMatchObject({
      isLocallyMuted: true
    });

    state.toggleParticipantLocalMute('remote-user');

    expect(state.isParticipantLocallyMuted('remote-user')).toBe(false);
    expect(setVolume).toHaveBeenLastCalledWith(1);

    state.toggleParticipantLocalMute('local-user');
    expect(state.isParticipantLocallyMuted('local-user')).toBe(false);

    state.toggleParticipantLocalMute('remote-user');
    expect(state.isParticipantLocallyMuted('remote-user')).toBe(true);

    await state.leave();

    expect(state.isParticipantLocallyMuted('remote-user')).toBe(false);
    expect(state.locallyMutedParticipantIds).toEqual({});
  });

  it('applies per-participant volume as gain and lets local mute override it', async () => {
    const setVolume = vi.fn();
    mockRemoteParticipants.set('remote-user', {
      identity: 'remote-user',
      name: 'Remote User',
      metadata: '',
      connectionQuality: 'good',
      isSpeaking: false,
      audioLevel: 0,
      setVolume,
      trackPublications: new Map(),
      getTrackPublications: vi.fn(() => [{ isMuted: false, track: { source: 'microphone' } }])
    });
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');
    setVolume.mockClear();

    // Default is 100% => unity gain.
    expect(state.getParticipantVolume('remote-user')).toBe(100);

    state.setParticipantVolume('remote-user', 50);
    expect(state.getParticipantVolume('remote-user')).toBe(50);
    expect(setVolume).toHaveBeenLastCalledWith(0.5);
    expect(state.participants.find((p) => p.identity === 'remote-user')).toMatchObject({
      localVolume: 50
    });

    // Clamping + rounding.
    state.setParticipantVolume('remote-user', 150);
    expect(state.getParticipantVolume('remote-user')).toBe(100);
    expect(setVolume).toHaveBeenLastCalledWith(1);

    state.setParticipantVolume('remote-user', 80);
    setVolume.mockClear();

    // Mute overrides stored volume (gain 0) but does not clear it.
    state.toggleParticipantLocalMute('remote-user');
    expect(setVolume).toHaveBeenLastCalledWith(0);
    expect(state.getParticipantVolume('remote-user')).toBe(80);

    // Unmute restores the stored 80% => 0.8.
    state.toggleParticipantLocalMute('remote-user');
    expect(setVolume).toHaveBeenLastCalledWith(0.8);
  });

  it('ignores setParticipantVolume for the local participant', async () => {
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');
    state.setParticipantVolume('local-user', 20);
    expect(state.getParticipantVolume('local-user')).toBe(100);
  });

  it('persists participant volume per server across re-instantiation', async () => {
    mockRemoteParticipants.set('remote-user', {
      identity: 'remote-user',
      name: 'Remote User',
      metadata: '',
      connectionQuality: 'good',
      isSpeaking: false,
      audioLevel: 0,
      setVolume: vi.fn(),
      trackPublications: new Map(),
      getTrackPublications: vi.fn(() => [{ isMuted: false, track: { source: 'microphone' } }])
    });
    localStorage.removeItem('chatto:i:server-1:callParticipantVolumes');
    localStorage.removeItem('chatto:i:server-2:callParticipantVolumes');

    const state1 = new VoiceCallState(createVoiceCallClient(), undefined, 'server-1');
    await state1.join('wss://livekit.example.test', 'R1');
    state1.setParticipantVolume('remote-user', 30);

    const state2 = new VoiceCallState(createVoiceCallClient(), undefined, 'server-1');
    expect(state2.getParticipantVolume('remote-user')).toBe(30);

    const other = new VoiceCallState(createVoiceCallClient(), undefined, 'server-2');
    expect(other.getParticipantVolume('remote-user')).toBe(100);
  });

  describe('deafen', () => {
    function addRemoteParticipant(
      identity: string,
      setVolume: ReturnType<typeof vi.fn>,
      attributes: Record<string, string> = {}
    ): void {
      mockRemoteParticipants.set(identity, {
        identity,
        name: identity,
        metadata: '',
        attributes,
        connectionQuality: 'good',
        isSpeaking: false,
        audioLevel: 0,
        setVolume,
        trackPublications: new Map(),
        getTrackPublications: vi.fn(() => [{ isMuted: false, track: { source: 'microphone' } }])
      });
    }

    it('deafening force-mutes the mic and silences all incoming audio', async () => {
      const setVolume = vi.fn();
      addRemoteParticipant('remote-user', setVolume);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');
      setVolume.mockClear();
      expect(state.isMuted).toBe(false);

      await state.toggleDeafen();

      expect(state.isDeafened).toBe(true);
      expect(state.isMuted).toBe(true);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
      expect(setVolume).toHaveBeenLastCalledWith(0);
    });

    it('undeafening restores the mic and incoming audio', async () => {
      const setVolume = vi.fn();
      addRemoteParticipant('remote-user', setVolume);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleDeafen();
      setVolume.mockClear();

      await state.toggleDeafen();

      expect(state.isDeafened).toBe(false);
      expect(state.isMuted).toBe(false);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
      expect(setVolume).toHaveBeenLastCalledWith(1);
    });

    it('stays muted after undeafen when already muted before deafening', async () => {
      const setVolume = vi.fn();
      addRemoteParticipant('remote-user', setVolume);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleMute();
      expect(state.isMuted).toBe(true);

      await state.toggleDeafen();
      expect(state.isDeafened).toBe(true);
      expect(state.isMuted).toBe(true);

      lastRoom?.localParticipant.setMicrophoneEnabled.mockClear();

      await state.toggleDeafen();

      expect(state.isDeafened).toBe(false);
      expect(state.isMuted).toBe(true);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    });

    it('unmuting via toggleMute while deafened clears deafen and restores audio', async () => {
      const setVolume = vi.fn();
      addRemoteParticipant('remote-user', setVolume);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleDeafen();
      expect(state.isDeafened).toBe(true);
      expect(state.isMuted).toBe(true);
      setVolume.mockClear();

      await state.toggleMute();

      expect(state.isMuted).toBe(false);
      expect(state.isDeafened).toBe(false);
      expect(setVolume).toHaveBeenLastCalledWith(1);
    });

    it('broadcasts deafen state via the LiveKit participant attribute', async () => {
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleDeafen();
      expect(lastRoom?.localParticipant.setAttributes).toHaveBeenLastCalledWith({ deafened: '1' });

      await state.toggleDeafen();
      expect(lastRoom?.localParticipant.setAttributes).toHaveBeenLastCalledWith({ deafened: '' });
    });

    it('clears the deafen attribute when unmuting via toggleMute clears deafen', async () => {
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleDeafen();
      await state.toggleMute();

      expect(state.isDeafened).toBe(false);
      expect(lastRoom?.localParticipant.setAttributes).toHaveBeenLastCalledWith({ deafened: '' });
    });

    it('reflects the local deafen state on the local participant tile', async () => {
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      expect(state.participants.find((p) => p.isLocal)?.isDeafened).toBe(false);

      await state.toggleDeafen();

      expect(state.participants.find((p) => p.isLocal)?.isDeafened).toBe(true);
    });

    it('surfaces a remote participant deafen attribute on their tile', async () => {
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      addRemoteParticipant('remote-user', vi.fn(), { deafened: '1' });
      roomEventHandlers.get('ParticipantAttributesChanged')?.();

      const remote = state.participants.find((p) => p.identity === 'remote-user');
      expect(remote?.isDeafened).toBe(true);
    });

    it('silences a remote participant that joins while deafened', async () => {
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleDeafen();

      const setVolume = vi.fn();
      addRemoteParticipant('late-user', setVolume);
      roomEventHandlers.get('ParticipantConnected')?.();

      expect(setVolume).toHaveBeenLastCalledWith(0);
    });

    it('resets deafen state on leave', async () => {
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');
      await state.toggleDeafen();
      expect(state.isDeafened).toBe(true);

      await state.leave();

      expect(state.isDeafened).toBe(false);
      expect(state.isDeafenPending).toBe(false);
    });

    it('silences incoming audio immediately, before the mic mute is applied', async () => {
      const setVolume = vi.fn();
      addRemoteParticipant('remote-user', setVolume);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');
      setVolume.mockClear();

      microphoneGate = deferredVoid();
      const deafen = state.toggleDeafen();
      await flushPromises();

      // Incoming audio is already muted even though the mic operation is pending.
      expect(state.isDeafened).toBe(true);
      expect(setVolume).toHaveBeenLastCalledWith(0);
      expect(state.isMuted).toBe(false);
      expect(state.isDeafenPending).toBe(true);

      microphoneGate.resolve();
      await deafen;

      expect(state.isMuted).toBe(true);
      expect(state.isDeafenPending).toBe(false);
    });

    it('keeps you muted and reports an error if the mic fails to re-enable on undeafen', async () => {
      const setVolume = vi.fn();
      addRemoteParticipant('remote-user', setVolume);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleDeafen();
      expect(state.isMuted).toBe(true);
      setVolume.mockClear();
      toastMocks.error.mockClear();

      microphoneFailure = new Error('microphone unavailable');
      await state.toggleDeafen();

      // Deafen cleared and incoming audio restored, but the mic could not return —
      // isMuted must stay true rather than falsely claiming the mic is live.
      expect(state.isDeafened).toBe(false);
      expect(state.isMuted).toBe(true);
      expect(setVolume).toHaveBeenLastCalledWith(1);
      expect(toastMocks.error).toHaveBeenCalled();
    });

    it('serializes with an in-flight mute so deafen captures committed mic state', async () => {
      const setVolume = vi.fn();
      addRemoteParticipant('remote-user', setVolume);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');
      lastRoom?.localParticipant.setMicrophoneEnabled.mockClear();

      microphoneGate = deferredVoid();
      const mute = state.toggleMute();
      await flushPromises();
      expect(state.isMuted).toBe(false); // mute not committed while the gate is held

      const deafen = state.toggleDeafen();
      await flushPromises();

      // Incoming audio is silenced immediately, but deafen must not start its own
      // mic operation while the mute is still in flight.
      expect(state.isDeafened).toBe(true);
      expect(setVolume).toHaveBeenLastCalledWith(0);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1);

      microphoneGate.resolve();
      await Promise.all([mute, deafen]);

      expect(state.isMuted).toBe(true);
      expect(state.isDeafened).toBe(true);

      // Undeafen keeps the user muted, proving mutedBeforeDeafen captured the
      // committed muted state rather than the stale pre-mute value.
      lastRoom?.localParticipant.setMicrophoneEnabled.mockClear();
      await state.toggleDeafen();
      expect(state.isMuted).toBe(true);
      expect(lastRoom?.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    });
  });
});
