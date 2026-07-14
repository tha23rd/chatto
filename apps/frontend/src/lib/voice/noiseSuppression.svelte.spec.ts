import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Track, type Room, type TrackProcessor } from 'livekit-client';
import {
  NoiseSuppressionController,
  modeCodec,
  type EnhancedProcessorFactory
} from './noiseSuppression.svelte';

const MODE_STORAGE_KEY = 'chatto:voiceNoiseSuppressionMode';

type FakeProcessor = TrackProcessor<Track.Kind.Audio> & { destroy: ReturnType<typeof vi.fn> };

type FakeMicTrack = {
  kind: Track.Kind;
  sourceSettings: Record<string, unknown>;
  getSourceTrackSettings: ReturnType<typeof vi.fn>;
  restartTrack: ReturnType<typeof vi.fn>;
  setProcessor: ReturnType<typeof vi.fn>;
  stopProcessor: ReturnType<typeof vi.fn>;
  getProcessor: ReturnType<typeof vi.fn>;
  currentProcessor: FakeProcessor | null;
};

/**
 * Fake LocalAudioTrack. `restartTrack` records the requested constraints and,
 * by default, reflects the voiceIsolation request into the source settings —
 * modeling a browser that honors the constraint. Tests override this to model
 * a browser that ignores it.
 */
function makeFakeMicTrack(): FakeMicTrack {
  const track: FakeMicTrack = {
    kind: Track.Kind.Audio,
    sourceSettings: {},
    getSourceTrackSettings: vi.fn(() => track.sourceSettings),
    restartTrack: vi.fn(async (opts: Record<string, unknown>) => {
      if ('voiceIsolation' in opts) {
        track.sourceSettings = { ...track.sourceSettings, voiceIsolation: opts.voiceIsolation };
      }
    }),
    setProcessor: vi.fn(async (processor: FakeProcessor) => {
      track.currentProcessor = processor;
    }),
    stopProcessor: vi.fn(async () => {
      track.currentProcessor = null;
    }),
    getProcessor: vi.fn(() => track.currentProcessor ?? undefined),
    currentProcessor: null
  };
  return track;
}

function makeFakeRoom(track: FakeMicTrack | null): Room {
  return {
    localParticipant: {
      getTrackPublication: vi.fn(() => (track ? { track } : undefined))
    }
  } as unknown as Room;
}

function makeProcessorFactory(
  overrides: {
    supported?: boolean;
    loadError?: Error;
    gate?: Promise<void>;
  } = {}
) {
  const processor = {
    name: 'fake-processor',
    destroy: vi.fn(async () => {})
  } as unknown as FakeProcessor;
  const factory: EnhancedProcessorFactory = async () => {
    if (overrides.gate) await overrides.gate;
    if (overrides.loadError) throw overrides.loadError;
    return {
      isSupported: () => overrides.supported ?? true,
      create: () => processor
    };
  };
  return { factory, processor };
}

function stubVoiceIsolationSupport(supported: boolean) {
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getSupportedConstraints: () => (supported ? { voiceIsolation: true } : {})
    }
  });
}

describe('NoiseSuppressionController', () => {
  const made: NoiseSuppressionController[] = [];
  function makeController(
    onChanged: () => void = () => {},
    factory?: EnhancedProcessorFactory
  ): NoiseSuppressionController {
    const controller = factory
      ? new NoiseSuppressionController(onChanged, factory)
      : new NoiseSuppressionController(onChanged);
    made.push(controller);
    return controller;
  }

  beforeEach(async () => {
    vi.stubEnv('VITE_ENABLE_NOISE_SUPPRESSION', 'true');
    // Shared module-level preference; reset via the public API between tests.
    await new NoiseSuppressionController(() => {}).setMode('off');
    localStorage.removeItem(MODE_STORAGE_KEY);
    stubVoiceIsolationSupport(true);
  });

  afterEach(() => {
    for (const controller of made) controller.handleCallEnded();
    made.length = 0;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('stays inert when the feature flag is not enabled', async () => {
    vi.stubEnv('VITE_ENABLE_NOISE_SUPPRESSION', '');
    const { factory } = makeProcessorFactory();
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();

    await controller.setMode('enhanced');
    expect(controller.mode).toBe('off');
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();

    await controller.applyToCall(makeFakeRoom(track));
    expect(track.setProcessor).not.toHaveBeenCalled();
    expect(controller.status).toBe('off');
    expect(controller.captureConstraints()).toEqual({});
  });

  it('keeps capture defaults untouched when the flag is off, even with a persisted mode', async () => {
    const controller = makeController();
    await controller.setMode('voice-isolation');
    vi.stubEnv('VITE_ENABLE_NOISE_SUPPRESSION', '');

    expect(controller.captureConstraints()).toEqual({});
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    expect(track.restartTrack).not.toHaveBeenCalled();
    expect(controller.status).toBe('off');
  });

  it('round-trips valid modes and rejects corrupt values in the storage codec', () => {
    expect(modeCodec.parse(modeCodec.serialize('enhanced'))).toBe('enhanced');
    expect(modeCodec.parse(modeCodec.serialize('voice-isolation'))).toBe('voice-isolation');
    expect(modeCodec.parse(modeCodec.serialize('off'))).toBe('off');
    expect(modeCodec.parse('krisp-9000')).toBeUndefined();
    expect(modeCodec.parse('')).toBeUndefined();
  });

  it('persists mode changes', async () => {
    const controller = makeController();
    await controller.setMode('enhanced');
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('enhanced');
  });

  it('shares the preference reactively across controllers', async () => {
    const a = makeController();
    const b = makeController();

    await a.setMode('enhanced');
    expect(b.mode).toBe('enhanced');
    expect(b.captureConstraints()).toEqual({ voiceIsolation: false });

    await b.setMode('voice-isolation');
    expect(a.mode).toBe('voice-isolation');
  });

  it('reconciles other controllers with active calls on mode change', async () => {
    const factoryA = makeProcessorFactory();
    const factoryB = makeProcessorFactory();
    const a = makeController(() => {}, factoryA.factory);
    const b = makeController(() => {}, factoryB.factory);
    const trackA = makeFakeMicTrack();
    const trackB = makeFakeMicTrack();
    await a.applyToCall(makeFakeRoom(trackA));
    await b.applyToCall(makeFakeRoom(trackB));

    await a.setMode('enhanced');
    expect(trackA.setProcessor).toHaveBeenCalledWith(factoryA.processor);
    expect(trackB.setProcessor).toHaveBeenCalledWith(factoryB.processor);
    expect(a.status).toBe('active');
    expect(b.status).toBe('active');

    await b.setMode('off');
    expect(trackA.stopProcessor).toHaveBeenCalled();
    expect(trackB.stopProcessor).toHaveBeenCalled();
    expect(a.status).toBe('off');
    expect(b.status).toBe('off');
  });

  it('always states voiceIsolation explicitly while the feature is enabled', async () => {
    const controller = makeController();
    expect(controller.captureConstraints()).toEqual({ voiceIsolation: false });
    await controller.setMode('voice-isolation');
    expect(controller.captureConstraints()).toEqual({ voiceIsolation: true });
    await controller.setMode('enhanced');
    expect(controller.captureConstraints()).toEqual({ voiceIsolation: false });
  });

  it('attaches the enhanced processor and reports active', async () => {
    const onChanged = vi.fn();
    const { factory, processor } = makeProcessorFactory();
    const controller = makeController(onChanged, factory);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(track.setProcessor).toHaveBeenCalledWith(processor);
    expect(controller.status).toBe('active');
    expect(onChanged).toHaveBeenCalled();
  });

  it('reports unavailable and keeps the call usable when the processor fails to load', async () => {
    const { factory } = makeProcessorFactory({ loadError: new Error('network down') });
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(controller.status).toBe('unavailable');
    expect(track.setProcessor).not.toHaveBeenCalled();
  });

  it('reports unavailable when the processor is unsupported', async () => {
    const { factory } = makeProcessorFactory({ supported: false });
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(controller.status).toBe('unavailable');
    expect(track.setProcessor).not.toHaveBeenCalled();
  });

  it('destroys an unadopted processor when attachment fails', async () => {
    const { factory, processor } = makeProcessorFactory();
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    // Rejection without adoption: getProcessor never returns ours.
    track.setProcessor.mockRejectedValue(new Error('worklet failed'));
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(processor.destroy).toHaveBeenCalled();
    expect(track.stopProcessor).not.toHaveBeenCalled();
    expect(controller.status).toBe('unavailable');
  });

  it('unwinds through stopProcessor when a failed attach was already adopted', async () => {
    const { factory, processor } = makeProcessorFactory();
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    // LiveKit assigns its processor reference before awaiting sender track
    // replacement, so a rejected setProcessor can still have been adopted.
    track.setProcessor.mockImplementation(async (p: FakeProcessor) => {
      track.currentProcessor = p;
      throw new Error('replaceTrack failed');
    });
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(track.stopProcessor).toHaveBeenCalled();
    expect(processor.destroy).not.toHaveBeenCalled();
    expect(controller.status).toBe('unavailable');
  });

  it('stops the processor when switching back to off', async () => {
    const { factory } = makeProcessorFactory();
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    await controller.setMode('off');
    expect(track.stopProcessor).toHaveBeenCalled();
    expect(controller.status).toBe('off');
  });

  it('reports unavailable on off when detach recovery also fails', async () => {
    const { factory } = makeProcessorFactory();
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    await controller.setMode('enhanced');

    // stopProcessor rejects AND the raw-track restart recovery also fails, so
    // the outbound track is not known-healthy: off must not claim success.
    track.stopProcessor.mockRejectedValueOnce(new Error('stop failed'));
    track.restartTrack.mockRejectedValueOnce(new Error('restart failed'));
    await controller.setMode('off');
    expect(controller.status).toBe('unavailable');
  });

  it('recovers to off when detach fails but the raw track restarts', async () => {
    const { factory } = makeProcessorFactory();
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    await controller.setMode('enhanced');

    // stopProcessor rejects but the raw-track restart recovery succeeds.
    track.stopProcessor.mockRejectedValueOnce(new Error('stop failed'));
    await controller.setMode('off');
    expect(track.restartTrack).toHaveBeenCalled();
    expect(controller.status).toBe('off');
  });

  it('converges on the final mode across rapid enhanced→off→enhanced toggling', async () => {
    let releaseLoad: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const { factory, processor } = makeProcessorFactory({ gate });
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    const first = controller.setMode('enhanced');
    const second = controller.setMode('off');
    const third = controller.setMode('enhanced');
    releaseLoad();
    await Promise.all([first, second, third]);

    expect(controller.status).toBe('active');
    expect(track.currentProcessor).toBe(processor);
    expect(track.stopProcessor).not.toHaveBeenCalled();
  });

  it('activates voice isolation via restartTrack with full baseline constraints', async () => {
    const controller = makeController();
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('voice-isolation');
    expect(track.restartTrack).toHaveBeenLastCalledWith({
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true
    });
    expect(controller.status).toBe('active');
  });

  it('reports voice isolation unavailable without browser support', async () => {
    stubVoiceIsolationSupport(false);
    const controller = makeController();
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('voice-isolation');
    expect(controller.status).toBe('unavailable');
    expect(track.restartTrack).not.toHaveBeenCalled();
  });

  it('reports voice isolation unavailable when the browser ignores the enable', async () => {
    const controller = makeController();
    const track = makeFakeMicTrack();
    // Browser accepts restartTrack but never reflects the setting.
    track.restartTrack.mockImplementation(async () => {});
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('voice-isolation');
    expect(controller.status).toBe('unavailable');
  });

  it('reports off as unavailable when the browser ignores voiceIsolation disable', async () => {
    const controller = makeController();
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    await controller.setMode('voice-isolation');
    expect(controller.status).toBe('active');

    // Browser accepts the disable restart but keeps reporting isolation on.
    track.restartTrack.mockImplementation(async () => {});
    await controller.setMode('off');
    expect(track.restartTrack).toHaveBeenLastCalledWith(
      expect.objectContaining({ voiceIsolation: false })
    );
    // Isolation is still on underneath: off must not claim a clean baseline.
    expect(controller.status).toBe('unavailable');
  });

  it('does not attach the enhanced processor if voiceIsolation cannot be disabled', async () => {
    const { factory } = makeProcessorFactory();
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    await controller.setMode('voice-isolation');
    expect(controller.status).toBe('active');

    // Enhanced must not stack on top of isolation: if disable is unverified,
    // do not attach and report unavailable.
    track.restartTrack.mockImplementation(async () => {});
    await controller.setMode('enhanced');
    expect(track.setProcessor).not.toHaveBeenCalled();
    expect(controller.status).toBe('unavailable');
  });

  it('reapplies the mode after a device switch (applyToCall while active)', async () => {
    const controller = makeController();
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    await controller.setMode('voice-isolation');
    expect(controller.status).toBe('active');

    // Simulate a device switch: the new capture track starts without
    // voiceIsolation, and VoiceCallState calls applyToCall again. The
    // controller must re-request isolation on the new track.
    const newTrack = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(newTrack));
    expect(newTrack.restartTrack).toHaveBeenCalledWith(
      expect.objectContaining({ voiceIsolation: true })
    );
    expect(controller.status).toBe('active');
  });

  it('resets status but keeps the preference when the call ends', async () => {
    const { factory } = makeProcessorFactory();
    const controller = makeController(() => {}, factory);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    controller.handleCallEnded();
    expect(controller.status).toBe('off');
    expect(controller.mode).toBe('enhanced');
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('enhanced');
  });

  it('stays off with no active call and applies once a call starts', async () => {
    const { factory, processor } = makeProcessorFactory();
    const controller = makeController(() => {}, factory);

    await controller.setMode('enhanced');
    expect(controller.status).toBe('off');

    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    expect(track.setProcessor).toHaveBeenCalledWith(processor);
    expect(controller.status).toBe('active');
  });
});
