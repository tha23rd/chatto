import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceCallAPI } from '$lib/api-client/voiceCalls';
import { browserNativeHost } from '$lib/native/browserHost';
import { installNativeHost, resetNativeHostForTests } from '$lib/native/host';

const { popOutMocks, soundMocks, toastMocks } = vi.hoisted(() => ({
  popOutMocks: {
    closeActiveVideoPopOut: vi.fn()
  },
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

vi.mock('$lib/voice/pictureInPicture', () => ({
  closeActiveVideoPopOut: popOutMocks.closeActiveVideoPopOut
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
    publishTrack: ReturnType<typeof vi.fn>;
    unpublishTrack: ReturnType<typeof vi.fn>;
    publishData: ReturnType<typeof vi.fn>;
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
// `source` sits on the publication as well as the track, mirroring LiveKit: the
// publication knows its source even while unsubscribed, which is what the store reads.
let localTrackPublications: Array<{
  isMuted: boolean;
  source?: string;
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
            track: { source: 'camera' },
            source: 'camera'
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
            track: { source: 'screen_share' },
            source: 'screen_share'
          });
        }
      }),
      getTrackPublication: vi.fn(),
      setAttributes: vi.fn(async (attrs: Record<string, string>) => {
        calls.push(`setAttributes:${JSON.stringify(attrs)}`);
      }),
      publishTrack: vi.fn(async (track: MediaStreamTrack, options?: { name?: string }) => {
        calls.push(`publishTrack:${options?.name ?? ''}:${track.id}`);
      }),
      unpublishTrack: vi.fn(async (track: MediaStreamTrack) => {
        calls.push(`unpublishTrack:${track.id}`);
      }),
      publishData: vi.fn(async () => {}),
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
      Reconnecting: 'Reconnecting',
      Reconnected: 'Reconnected',
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
      Source: {
        Microphone: 'microphone',
        Camera: 'camera',
        ScreenShare: 'screen_share',
        ScreenShareAudio: 'screen_share_audio',
        Unknown: 'unknown'
      }
    },
    AudioPresets: {
      speech: { maxBitrate: 24_000 },
      musicStereo: { maxBitrate: 64_000 }
    },
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
const EXPECTED_SCREEN_SHARE_PUBLISH = {
  ...resolveScreenShareOptions(DEFAULT_SCREEN_SHARE_QUALITY, DEFAULT_SCREEN_SHARE_CEILING).publish,
  audioPreset: { maxBitrate: 64_000 },
  forceStereo: true,
  dtx: false,
  red: false
};

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

// Minimal Web Audio doubles for soundboard playback. Each buffer source records
// whether it was started and released so a superseded clip is observable, and
// the published MediaStreamTrack ids let publish/unpublish be paired up.
type FakeSoundSource = {
  id: string;
  started: boolean;
  disconnected: boolean;
  onended: (() => void) | null;
};
let fakeSources: FakeSoundSource[] = [];
let stoppedTrackIds: string[] = [];
let nextNodeId = 0;
// Clock the soundboard rate limiter reads through Date.now().
let soundboardNow = 0;

class MockAudioContext {
  state = 'running';
  destination = { kind: 'destination' };
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  decodeAudioData = vi.fn(async () => ({ duration: 1 }));
  createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn()
  }));
  createBufferSource = vi.fn(() => {
    const source: FakeSoundSource = {
      id: `source-${++nextNodeId}`,
      started: false,
      disconnected: false,
      onended: null
    };
    fakeSources.push(source);
    return {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(() => {
        source.disconnected = true;
      }),
      start: vi.fn(() => {
        source.started = true;
      }),
      get onended() {
        return source.onended;
      },
      set onended(handler: (() => void) | null) {
        source.onended = handler;
      }
    };
  });
  createMediaStreamDestination = vi.fn(() => {
    const id = `track-${++nextNodeId}`;
    return {
      stream: {
        getAudioTracks: () => [
          {
            id,
            stop: vi.fn(() => {
              stoppedTrackIds.push(id);
            })
          }
        ]
      }
    };
  });
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
    popOutMocks.closeActiveVideoPopOut.mockClear();
    vi.mocked(Room.getLocalDevices).mockClear();
  });

  afterEach(() => {
    resetNativeHostForTests();
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
    expect(popOutMocks.closeActiveVideoPopOut).toHaveBeenCalledWith(state);
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
    expect(popOutMocks.closeActiveVideoPopOut).toHaveBeenCalledWith(state);
    expect(state.isInAnyCall).toBe(false);
    expect(soundMocks.playCallSound).not.toHaveBeenCalled();
  });

  it('disconnects local media without recording leave when room access is revoked', async () => {
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    soundMocks.playCallSound.mockClear();

    state.handleRoomAccessRevoked('R2');
    expect(state.isInAnyCall).toBe(true);

    state.handleRoomAccessRevoked('R1');

    expect(lastRoom?.disconnect).toHaveBeenCalledOnce();
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

  it('toggles screen sharing with configured capture and publish options', async () => {
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

    expect(lastRoom?.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(
      false,
      undefined,
      undefined
    );
    expect(state.isScreenShareEnabled).toBe(false);
    expect(state.participants[0].screenShareTrack).toBeNull();
  });

  it('publishes native display tracks through LiveKit when window system audio is available', async () => {
    const videoTrack = {
      id: 'native-screen-video',
      kind: 'video',
      contentHint: '',
      stop: vi.fn()
    } as unknown as MediaStreamTrack;
    const audioTrack = {
      id: 'native-screen-audio',
      kind: 'audio',
      contentHint: '',
      stop: vi.fn()
    } as unknown as MediaStreamTrack;
    const captureDisplayMedia = vi.fn(async () => {
      return {
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [audioTrack],
        getTracks: () => [videoTrack, audioTrack]
      } as unknown as MediaStream;
    });
    installNativeHost({
      ...browserNativeHost,
      kind: 'tauri',
      capabilities: {
        ...browserNativeHost.capabilities,
        windowSystemAudio: true
      },
      captureDisplayMedia
    });
    const state = new VoiceCallState(createVoiceCallClient());
    await state.setScreenShareQuality({
      ...DEFAULT_SCREEN_SHARE_QUALITY,
      shareAudio: true
    });
    await state.join('wss://livekit.example.test', 'R1');

    await state.toggleScreenShare();

    expect(captureDisplayMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        restrictOwnAudio: true
      },
      systemAudio: 'include',
      video: {
        frameRate: 60,
        height: { ideal: 1080 },
        width: { ideal: 1920 }
      }
    });
    expect(lastRoom?.localParticipant.setScreenShareEnabled).not.toHaveBeenCalled();
    expect(lastRoom?.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      1,
      videoTrack,
      expect.objectContaining({ source: 'screen_share' })
    );
    expect(lastRoom?.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      2,
      audioTrack,
      expect.objectContaining({
        audioPreset: { maxBitrate: 64_000 },
        dtx: false,
        forceStereo: true,
        red: false,
        source: 'screen_share_audio'
      })
    );
    expect(videoTrack.contentHint).toBe('motion');
    expect(audioTrack.contentHint).toBe('music');
  });

  it('collects diagnostics from the published local screen-share track', async () => {
    const getRTCStatsReport = vi.fn(
      async () =>
        new Map([
          [
            'outbound-video',
            {
              id: 'outbound-video',
              type: 'outbound-rtp',
              kind: 'video',
              timestamp: 1_000,
              bytesSent: 2_000,
              framesEncoded: 30,
              packetsSent: 20,
              qualityLimitationReason: 'none'
            }
          ]
        ]) as unknown as RTCStatsReport
    );
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');
    lastRoom!.localParticipant.getTrackPublication = vi.fn(() => ({
      track: { getRTCStatsReport }
    }));

    await state.toggleScreenShare();
    await vi.waitFor(() => expect(getRTCStatsReport).toHaveBeenCalledOnce());

    expect(state.screenShareDiagnostics.latest).toMatchObject({
      bytesSent: 2_000,
      bitrateBps: null,
      framesEncoded: 30,
      packetsSent: 20,
      qualityLimitationReason: 'none'
    });

    await state.toggleScreenShare();
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

  it('moves the content hint with the degradation preference when retuning', async () => {
    // The hint and the degradation preference are two halves of one decision
    // (see resolveScreenShareOptions). Retuning applied only the latter, so a
    // live share dropped to 15 fps kept asking the encoder to favour motion
    // while the sender was told to preserve resolution.
    const params: RTCRtpSendParameters = {
      encodings: [{}],
      transactionId: 't',
      codecs: [],
      headerExtensions: [],
      rtcp: {}
    };
    const mediaStreamTrack = { applyConstraints: vi.fn(async () => {}), contentHint: '' };
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    lastRoom!.localParticipant.getTrackPublication = vi.fn(() => ({
      track: {
        mediaStreamTrack,
        sender: { getParameters: () => params, setParameters: vi.fn(async () => {}) }
      }
    }));
    await state.toggleScreenShare();

    await state.setScreenShareQuality({ resolution: '1080p', framerate: 15, shareAudio: false });

    expect(mediaStreamTrack.contentHint).toBe('detail');
    expect(params.degradationPreference).toBe('maintain-resolution');

    // Back up to a motion-oriented rate and both halves move together again.
    await state.setScreenShareQuality({ resolution: '1080p', framerate: 60, shareAudio: false });

    expect(mediaStreamTrack.contentHint).toBe('motion');
    expect(params.degradationPreference).toBe('maintain-framerate');
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

  it('plays stream start and stop cues for participants in the connected call', async () => {
    const publications = [
      { isMuted: false, track: { source: 'microphone' }, source: 'microphone' }
    ];
    mockRemoteParticipants.set('remote-user', {
      identity: 'remote-user',
      name: 'Remote User',
      metadata: '',
      attributes: {},
      connectionQuality: 'good',
      isSpeaking: false,
      audioLevel: 0,
      setVolume: vi.fn(),
      trackPublications: new Map(),
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => publications)
    });
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');

    publications.push({
      isMuted: false,
      track: { source: 'screen_share' },
      source: 'screen_share'
    });
    roomEventHandlers.get('TrackPublished')?.();

    expect(soundMocks.playCallSound).toHaveBeenCalledOnce();
    expect(soundMocks.playCallSound).toHaveBeenLastCalledWith('stream-start');

    publications.splice(
      publications.findIndex((publication) => publication.source === 'screen_share'),
      1
    );
    roomEventHandlers.get('TrackUnpublished')?.();

    expect(soundMocks.playCallSound).toHaveBeenCalledTimes(2);
    expect(soundMocks.playCallSound).toHaveBeenLastCalledWith('stream-stop');

    await state.leave();
    publications.push({
      isMuted: false,
      track: { source: 'screen_share' },
      source: 'screen_share'
    });
    roomEventHandlers.get('TrackPublished')?.();

    expect(soundMocks.playCallSound).toHaveBeenCalledTimes(2);
  });

  it('does not announce streams already active when joining or restored during reconnect', async () => {
    const publications = [
      { isMuted: false, track: { source: 'microphone' }, source: 'microphone' },
      { isMuted: false, track: { source: 'screen_share' }, source: 'screen_share' }
    ];
    mockRemoteParticipants.set('remote-user', {
      identity: 'remote-user',
      name: 'Remote User',
      metadata: '',
      attributes: {},
      connectionQuality: 'good',
      isSpeaking: false,
      audioLevel: 0,
      setVolume: vi.fn(),
      trackPublications: new Map(),
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => publications)
    });
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');

    expect(soundMocks.playCallSound).not.toHaveBeenCalled();

    roomEventHandlers.get('Reconnecting')?.();
    publications.splice(
      publications.findIndex((publication) => publication.source === 'screen_share'),
      1
    );
    roomEventHandlers.get('TrackUnpublished')?.();
    publications.push({
      isMuted: false,
      track: { source: 'screen_share' },
      source: 'screen_share'
    });
    roomEventHandlers.get('TrackPublished')?.();
    roomEventHandlers.get('Reconnected')?.();

    expect(soundMocks.playCallSound).not.toHaveBeenCalled();

    publications.splice(
      publications.findIndex((publication) => publication.source === 'screen_share'),
      1
    );
    roomEventHandlers.get('TrackUnpublished')?.();

    expect(soundMocks.playCallSound).toHaveBeenCalledOnce();
    expect(soundMocks.playCallSound).toHaveBeenCalledWith('stream-stop');
  });

  it('does not treat screen-share audio publication as another stream transition', async () => {
    const publications = [
      { isMuted: false, track: { source: 'microphone' }, source: 'microphone' }
    ];
    mockRemoteParticipants.set('remote-user', {
      identity: 'remote-user',
      name: 'Remote User',
      metadata: '',
      attributes: {},
      connectionQuality: 'good',
      isSpeaking: false,
      audioLevel: 0,
      setVolume: vi.fn(),
      trackPublications: new Map(),
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => publications)
    });
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');

    publications.push({
      isMuted: false,
      track: { source: 'screen_share_audio' },
      source: 'screen_share_audio'
    });
    roomEventHandlers.get('TrackPublished')?.();

    expect(soundMocks.playCallSound).not.toHaveBeenCalled();
  });

  it('announces a local stream once even when LiveKit also reports its publication', async () => {
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');

    await state.toggleScreenShare();
    roomEventHandlers.get('LocalTrackPublished')?.();

    expect(soundMocks.playCallSound).toHaveBeenCalledOnce();
    expect(soundMocks.playCallSound).toHaveBeenLastCalledWith('stream-start');

    await state.toggleScreenShare();
    roomEventHandlers.get('LocalTrackUnpublished')?.();

    expect(soundMocks.playCallSound).toHaveBeenCalledTimes(2);
    expect(soundMocks.playCallSound).toHaveBeenLastCalledWith('stream-stop');
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

  it('attaches and detaches subscribed screen-share audio', async () => {
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
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => [
        { isMuted: false, track: { source: 'microphone' }, source: 'microphone' }
      ])
    });
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);
    await state.join('wss://livekit.example.test', 'R1');
    state.toggleParticipantLocalMute('remote-user');
    setVolume.mockClear();
    const screenShareAudio = {
      kind: 'audio',
      source: 'screen_share_audio',
      attach: vi.fn(),
      detach: vi.fn()
    };

    roomEventHandlers.get('TrackSubscribed')?.(screenShareAudio, {});

    expect(screenShareAudio.attach).toHaveBeenCalledOnce();
    expect(setVolume).toHaveBeenCalledWith(0, 'microphone');
    expect(setVolume).toHaveBeenCalledWith(0, 'screen_share_audio');

    roomEventHandlers.get('TrackUnsubscribed')?.(screenShareAudio, {});

    expect(screenShareAudio.detach).toHaveBeenCalledOnce();
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
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => [
        { isMuted: false, track: { source: 'microphone' }, source: 'microphone' }
      ])
    });
    const client = createVoiceCallClient();
    const state = new VoiceCallState(client);

    await state.join('wss://livekit.example.test', 'R1');
    setVolume.mockClear();

    state.toggleParticipantLocalMute('remote-user');

    expect(state.isParticipantLocallyMuted('remote-user')).toBe(true);
    expect(setVolume).toHaveBeenCalledWith(0, 'microphone');
    expect(setVolume).toHaveBeenCalledWith(0, 'screen_share_audio');
    expect(state.participants.find((p) => p.identity === 'remote-user')).toMatchObject({
      isLocallyMuted: true
    });

    state.toggleParticipantLocalMute('remote-user');

    expect(state.isParticipantLocallyMuted('remote-user')).toBe(false);
    expect(setVolume).toHaveBeenCalledWith(1, 'microphone');
    expect(setVolume).toHaveBeenCalledWith(1, 'screen_share_audio');

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
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => [
        { isMuted: false, track: { source: 'microphone' }, source: 'microphone' }
      ])
    });
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');
    setVolume.mockClear();

    // Default is 100% => unity gain.
    expect(state.getParticipantVolume('remote-user')).toBe(100);

    state.setParticipantVolume('remote-user', 50);
    expect(state.getParticipantVolume('remote-user')).toBe(50);
    expect(setVolume).toHaveBeenCalledWith(0.5, 'microphone');
    // This fader is the participant's voice only. Screen-share audio has its own
    // (see the independent-fader test) and stays at its own level here.
    expect(setVolume).toHaveBeenCalledWith(1, 'screen_share_audio');
    expect(state.participants.find((p) => p.identity === 'remote-user')).toMatchObject({
      localVolume: 50
    });

    // Clamping + rounding.
    state.setParticipantVolume('remote-user', 150);
    expect(state.getParticipantVolume('remote-user')).toBe(100);
    expect(setVolume).toHaveBeenCalledWith(1, 'microphone');

    state.setParticipantVolume('remote-user', 80);
    setVolume.mockClear();

    // Mute overrides stored volume (gain 0) but does not clear it.
    state.toggleParticipantLocalMute('remote-user');
    expect(setVolume).toHaveBeenCalledWith(0, 'microphone');
    expect(setVolume).toHaveBeenCalledWith(0, 'screen_share_audio');
    expect(state.getParticipantVolume('remote-user')).toBe(80);

    // Unmute restores the stored 80% => 0.8 for the voice, and the untouched stream level.
    state.toggleParticipantLocalMute('remote-user');
    expect(setVolume).toHaveBeenCalledWith(0.8, 'microphone');
    expect(setVolume).toHaveBeenCalledWith(1, 'screen_share_audio');
  });

  it('gives screen-share audio a fader independent of the participant voice fader', async () => {
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
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => [
        { isMuted: false, track: { source: 'microphone' }, source: 'microphone' },
        { isMuted: false, track: { source: 'screen_share_audio' }, source: 'screen_share_audio' }
      ])
    });
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');
    setVolume.mockClear();

    expect(state.getParticipantScreenShareVolume('remote-user')).toBe(100);
    expect(state.participants.find((p) => p.identity === 'remote-user')).toMatchObject({
      hasScreenShareAudio: true,
      localScreenShareVolume: 100
    });

    // Turning a loud stream down must leave the sharer's voice at full volume.
    state.setParticipantScreenShareVolume('remote-user', 20);

    expect(state.getParticipantScreenShareVolume('remote-user')).toBe(20);
    expect(state.getParticipantVolume('remote-user')).toBe(100);
    expect(setVolume).toHaveBeenCalledWith(1, 'microphone');
    expect(setVolume).toHaveBeenCalledWith(0.2, 'screen_share_audio');
    expect(state.participants.find((p) => p.identity === 'remote-user')).toMatchObject({
      localVolume: 100,
      localScreenShareVolume: 20
    });

    // And the voice fader must not drag the stream with it.
    setVolume.mockClear();
    state.setParticipantVolume('remote-user', 60);

    expect(setVolume).toHaveBeenCalledWith(0.6, 'microphone');
    expect(setVolume).toHaveBeenCalledWith(0.2, 'screen_share_audio');

    // One mute, both faders: local mute still silences everything from this participant.
    setVolume.mockClear();
    state.toggleParticipantLocalMute('remote-user');

    expect(setVolume).toHaveBeenCalledWith(0, 'microphone');
    expect(setVolume).toHaveBeenCalledWith(0, 'screen_share_audio');
    expect(state.getParticipantScreenShareVolume('remote-user')).toBe(20);

    setVolume.mockClear();
    state.toggleParticipantLocalMute('remote-user');

    expect(setVolume).toHaveBeenCalledWith(0.6, 'microphone');
    expect(setVolume).toHaveBeenCalledWith(0.2, 'screen_share_audio');
  });

  it('reports no screen-share audio when the sharer publishes none', async () => {
    mockRemoteParticipants.set('remote-user', {
      identity: 'remote-user',
      name: 'Remote User',
      metadata: '',
      connectionQuality: 'good',
      isSpeaking: false,
      audioLevel: 0,
      setVolume: vi.fn(),
      trackPublications: new Map(),
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => [
        { isMuted: false, track: { source: 'microphone' }, source: 'microphone' },
        { isMuted: false, track: { source: 'screen_share' }, source: 'screen_share' }
      ])
    });
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');

    expect(state.participants.find((p) => p.identity === 'remote-user')).toMatchObject({
      isScreenShareEnabled: true,
      hasScreenShareAudio: false
    });
  });

  it('unsubscribes a feed the viewer stops watching, and its stream audio with it', async () => {
    const camera = {
      isMuted: false,
      source: 'camera',
      track: { source: 'camera' },
      isSubscribed: true,
      setSubscribed: vi.fn()
    };
    const screen = {
      isMuted: false,
      source: 'screen_share',
      track: { source: 'screen_share' },
      isSubscribed: true,
      setSubscribed: vi.fn()
    };
    const screenAudio = {
      isMuted: false,
      source: 'screen_share_audio',
      track: { source: 'screen_share_audio' },
      isSubscribed: true,
      setSubscribed: vi.fn()
    };
    const mic = {
      isMuted: false,
      source: 'microphone',
      track: { source: 'microphone' },
      isSubscribed: true,
      setSubscribed: vi.fn()
    };
    mockRemoteParticipants.set('remote-user', {
      identity: 'remote-user',
      name: 'Remote User',
      metadata: '',
      connectionQuality: 'good',
      isSpeaking: false,
      audioLevel: 0,
      setVolume: vi.fn(),
      trackPublications: new Map(),
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => [mic, camera, screen, screenAudio])
    });
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');

    state.toggleFeedWatched('remote-user', 'screen');

    // The picture and the sound that belongs to it both stop; the voice is untouched,
    // because silencing someone is what a local mute is for.
    expect(screen.setSubscribed).toHaveBeenCalledWith(false);
    expect(screenAudio.setSubscribed).toHaveBeenCalledWith(false);
    expect(camera.setSubscribed).not.toHaveBeenCalled();
    expect(mic.setSubscribed).not.toHaveBeenCalled();
    expect(state.isFeedWatched('remote-user', 'screen')).toBe(false);
    expect(state.isFeedWatched('remote-user', 'camera')).toBe(true);

    screen.isSubscribed = false;
    screenAudio.isSubscribed = false;
    state.toggleFeedWatched('remote-user', 'screen');

    expect(screen.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(screenAudio.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(state.isFeedWatched('remote-user', 'screen')).toBe(true);
  });

  it('persists screen-share volume per server, separately from voice volume', async () => {
    mockRemoteParticipants.set('remote-user', {
      identity: 'remote-user',
      name: 'Remote User',
      metadata: '',
      connectionQuality: 'good',
      isSpeaking: false,
      audioLevel: 0,
      setVolume: vi.fn(),
      trackPublications: new Map(),
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => [
        { isMuted: false, track: { source: 'microphone' }, source: 'microphone' }
      ])
    });
    localStorage.removeItem('chatto:i:server-1:callScreenShareVolumes');
    localStorage.removeItem('chatto:i:server-2:callScreenShareVolumes');

    const state1 = new VoiceCallState(createVoiceCallClient(), undefined, 'server-1');
    await state1.join('wss://livekit.example.test', 'R1');
    state1.setParticipantScreenShareVolume('remote-user', 35);

    const state2 = new VoiceCallState(createVoiceCallClient(), undefined, 'server-1');
    expect(state2.getParticipantScreenShareVolume('remote-user')).toBe(35);
    expect(state2.getParticipantVolume('remote-user')).toBe(100);

    const other = new VoiceCallState(createVoiceCallClient(), undefined, 'server-2');
    expect(other.getParticipantScreenShareVolume('remote-user')).toBe(100);
  });

  it('ignores setParticipantScreenShareVolume for the local participant', async () => {
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');
    state.setParticipantScreenShareVolume('local-user', 20);
    expect(state.getParticipantScreenShareVolume('local-user')).toBe(100);
  });

  it('shares audio without voice DSP and marks the published track as music', async () => {
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');
    await state.setScreenShareQuality({ ...DEFAULT_SCREEN_SHARE_QUALITY, shareAudio: true });
    const screenAudioMediaStreamTrack = { contentHint: '' };
    lastRoom!.localParticipant.getTrackPublication = vi.fn((source: string) =>
      source === 'screen_share_audio'
        ? { track: { mediaStreamTrack: screenAudioMediaStreamTrack } }
        : undefined
    );

    await state.toggleScreenShare();

    // Speech processing is what makes game and music audio sound like a broken radio.
    const capture = vi.mocked(lastRoom!.localParticipant.setScreenShareEnabled).mock.calls[0][1];
    expect(capture).toMatchObject({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true
      },
      systemAudio: 'include'
    });
    // The mic keeps its own DSP; only shared audio opts out.
    expect(lastRoomOptions?.audioCaptureDefaults).toMatchObject({
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true
    });
    // livekit-client only hints the screen-share *video* track, so we hint the audio one.
    expect(screenAudioMediaStreamTrack.contentHint).toBe('music');
  });

  it('leaves shared audio out of the capture request when Share audio is off', async () => {
    const state = new VoiceCallState(createVoiceCallClient());
    await state.join('wss://livekit.example.test', 'R1');

    await state.toggleScreenShare();

    expect(
      vi.mocked(lastRoom!.localParticipant.setScreenShareEnabled).mock.calls[0][1]
    ).toMatchObject({ audio: false, systemAudio: 'exclude' });
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
      audioTrackPublications: new Map(),
      getTrackPublications: vi.fn(() => [
        { isMuted: false, track: { source: 'microphone' }, source: 'microphone' }
      ])
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
        audioTrackPublications: new Map(),
        getTrackPublications: vi.fn(() => [
          { isMuted: false, track: { source: 'microphone' }, source: 'microphone' }
        ])
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
      expect(setVolume).toHaveBeenCalledWith(0, 'microphone');
      expect(setVolume).toHaveBeenCalledWith(0, 'screen_share_audio');
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
      expect(setVolume).toHaveBeenCalledWith(1, 'microphone');
      expect(setVolume).toHaveBeenCalledWith(1, 'screen_share_audio');
    });

    // A remote participant whose microphone publication is gate-capable
    // (exposes setEnabled), so deafen-gate behavior can be asserted.
    function addRemoteParticipantWithAudio(
      identity: string,
      setEnabled: ReturnType<typeof vi.fn>,
      setVolume: ReturnType<typeof vi.fn> = vi.fn()
    ): Record<string, unknown> {
      const micPublication = { setEnabled, track: { source: 'microphone' }, source: 'microphone' };
      mockRemoteParticipants.set(identity, {
        identity,
        name: identity,
        metadata: '',
        attributes: {},
        connectionQuality: 'good',
        isSpeaking: false,
        audioLevel: 0,
        setVolume,
        trackPublications: new Map(),
        audioTrackPublications: new Map([['pub-1', micPublication]]),
        getTrackPublications: vi.fn(() => [micPublication])
      });
      return micPublication;
    }

    it('keeps a track that resubscribes while deafened silent, so undeafening is not audible to a deafened listener', async () => {
      const setEnabled = vi.fn();
      const micPublication = addRemoteParticipantWithAudio('remote-user', setEnabled);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleDeafen();
      expect(setEnabled).toHaveBeenLastCalledWith(false);
      setEnabled.mockClear();

      // The remote undeafens, so their microphone resubscribes here.
      const micTrack = { kind: 'audio', source: 'microphone', attach: vi.fn(), detach: vi.fn() };
      roomEventHandlers.get('TrackSubscribed')?.(micTrack, micPublication);

      expect(setEnabled).toHaveBeenLastCalledWith(false);
    });

    it('still silences a deafened listener when attaching a subscribed track throws', async () => {
      const setEnabled = vi.fn();
      const setVolume = vi.fn();
      const micPublication = addRemoteParticipantWithAudio('remote-user', setEnabled, setVolume);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleDeafen();
      setEnabled.mockClear();
      setVolume.mockClear();

      const failingTrack = {
        kind: 'audio',
        source: 'microphone',
        attach: vi.fn(() => {
          throw new Error('sink failure');
        }),
        detach: vi.fn()
      };
      roomEventHandlers.get('TrackSubscribed')?.(failingTrack, micPublication);

      expect(failingTrack.attach).toHaveBeenCalledOnce();
      expect(setVolume).toHaveBeenCalledWith(0, 'microphone');
      expect(setEnabled).toHaveBeenLastCalledWith(false);
    });

    it('resumes incoming audio delivery when undeafening', async () => {
      const setEnabled = vi.fn();
      addRemoteParticipantWithAudio('remote-user', setEnabled);
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      await state.toggleDeafen();
      setEnabled.mockClear();

      await state.toggleDeafen();

      expect(state.isDeafened).toBe(false);
      expect(setEnabled).toHaveBeenLastCalledWith(true);
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
      expect(setVolume).toHaveBeenCalledWith(1, 'microphone');
      expect(setVolume).toHaveBeenCalledWith(1, 'screen_share_audio');
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

      expect(setVolume).toHaveBeenCalledWith(0, 'microphone');
      expect(setVolume).toHaveBeenCalledWith(0, 'screen_share_audio');
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
      expect(setVolume).toHaveBeenCalledWith(0, 'microphone');
      expect(setVolume).toHaveBeenCalledWith(0, 'screen_share_audio');
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
      expect(setVolume).toHaveBeenCalledWith(1, 'microphone');
      expect(setVolume).toHaveBeenCalledWith(1, 'screen_share_audio');
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
      expect(setVolume).toHaveBeenCalledWith(0, 'microphone');
      expect(setVolume).toHaveBeenCalledWith(0, 'screen_share_audio');
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

  describe('soundboard', () => {
    function stubSoundboardAudio(): void {
      fakeSources = [];
      stoppedTrackIds = [];
      nextNodeId = 0;
      vi.stubGlobal('AudioContext', MockAudioContext);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
      );
      // The rate limiter enforces a minimum gap between triggers, so drive its
      // clock explicitly instead of waiting in real time.
      soundboardNow = 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => soundboardNow);
    }

    const clip = (url: string) => ({ url, volume: 1 });

    it('stops the previous clip from the same player instead of layering a second one', async () => {
      stubSoundboardAudio();
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      expect(await state.playSoundIntoCall(clip('https://example.test/a.mp3'))).toBe('played');
      soundboardNow += 1_000;
      expect(await state.playSoundIntoCall(clip('https://example.test/b.mp3'))).toBe('played');

      // Both clips started, but the first was torn down by the second: its Web
      // Audio nodes are released and its published track was stopped, so remote
      // listeners stop hearing it too.
      expect(fakeSources).toHaveLength(2);
      expect(fakeSources[0].started).toBe(true);
      expect(fakeSources[0].disconnected).toBe(true);
      expect(fakeSources[1].started).toBe(true);
      expect(fakeSources[1].disconnected).toBe(false);
      expect(stoppedTrackIds).toHaveLength(1);
      const unpublished = vi.mocked(lastRoom!.localParticipant.unpublishTrack).mock.calls;
      expect(unpublished).toHaveLength(1);
      expect(unpublished[0][0].id).toBe(stoppedTrackIds[0]);

      // The local player never stops being "playing", so the tile highlight and
      // the remote signal do not flicker off between the two clips.
      expect(state.isSoundboardActive('local-user')).toBe(true);
      expect(vi.mocked(lastRoom!.localParticipant.publishData).mock.calls).toHaveLength(1);
    });

    it('restarts the same clip when it is triggered again', async () => {
      stubSoundboardAudio();
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      const same = clip('https://example.test/a.mp3');
      expect(await state.playSoundIntoCall(same)).toBe('played');
      soundboardNow += 1_000;
      expect(await state.playSoundIntoCall(same)).toBe('played');

      expect(fakeSources).toHaveLength(2);
      expect(fakeSources[0].disconnected).toBe(true);
      expect(fakeSources[1].started).toBe(true);
      expect(state.isSoundboardActive('local-user')).toBe(true);
    });

    it('keeps the previous clip playing when a trigger is rate limited', async () => {
      stubSoundboardAudio();
      const state = new VoiceCallState(createVoiceCallClient());
      await state.join('wss://livekit.example.test', 'R1');

      expect(await state.playSoundIntoCall(clip('https://example.test/a.mp3'))).toBe('played');
      expect(await state.playSoundIntoCall(clip('https://example.test/b.mp3'))).toBe('throttled');

      expect(fakeSources).toHaveLength(1);
      expect(fakeSources[0].disconnected).toBe(false);
      expect(stoppedTrackIds).toHaveLength(0);
    });
  });
});
