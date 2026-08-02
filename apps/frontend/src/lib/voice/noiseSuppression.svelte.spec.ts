import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Track, type Room, type TrackProcessor } from 'livekit-client';
import {
  NoiseSuppressionController,
  modeCodec,
  MIN_STRENGTH,
  MAX_STRENGTH,
  DEFAULT_INPUT_GAIN,
  DEFAULT_SENSITIVITY,
  MIN_INPUT_GAIN,
  MAX_INPUT_GAIN,
  NOISE_REDUCTION_LEVEL,
  type MicProcessorFactory
} from './noiseSuppression.svelte';

const MODE_STORAGE_KEY = 'chatto:voiceNoiseSuppressionMode';
const STRENGTH_STORAGE_KEY = 'chatto:voiceNoiseSuppressionStrength';
const INPUT_GAIN_STORAGE_KEY = 'chatto:voiceInputGain';
const SENSITIVITY_STORAGE_KEY = 'chatto:voiceGateSensitivity';

type FakeProcessor = TrackProcessor<Track.Kind.Audio> & {
  destroy: ReturnType<typeof vi.fn>;
  setSuppressionLevel: ReturnType<typeof vi.fn>;
  setInputGain: ReturnType<typeof vi.fn>;
  setGateThreshold: ReturnType<typeof vi.fn>;
  setNoiseSuppressionEnabled: ReturnType<typeof vi.fn>;
};

type FakeMicTrack = {
  kind: Track.Kind;
  sourceSettings: Record<string, unknown>;
  constraints: Record<string, unknown>;
  getSourceTrackSettings: ReturnType<typeof vi.fn>;
  restartTrack: ReturnType<typeof vi.fn>;
  setProcessor: ReturnType<typeof vi.fn>;
  stopProcessor: ReturnType<typeof vi.fn>;
  getProcessor: ReturnType<typeof vi.fn>;
  currentProcessor: FakeProcessor | null;
};

/**
 * Fake LocalAudioTrack. `restartTrack` records the requested constraints
 * (mirroring LiveKit's wholesale replacement of the stored constraints) and,
 * by default, reflects the voiceIsolation and noiseSuppression requests into
 * the source settings — modeling a browser that honors the constraints.
 * Tests override this to model a browser that ignores them.
 */
function makeFakeMicTrack(): FakeMicTrack {
  const track: FakeMicTrack = {
    kind: Track.Kind.Audio,
    sourceSettings: {},
    // Real capture tracks always carry the room's audio capture defaults;
    // an empty object would make every initial apply look restart-worthy.
    constraints: {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: false
    },
    getSourceTrackSettings: vi.fn(() => track.sourceSettings),
    restartTrack: vi.fn(async (opts: Record<string, unknown>) => {
      track.constraints = { ...opts };
      if ('voiceIsolation' in opts) {
        track.sourceSettings = { ...track.sourceSettings, voiceIsolation: opts.voiceIsolation };
      }
      if ('noiseSuppression' in opts) {
        track.sourceSettings = { ...track.sourceSettings, noiseSuppression: opts.noiseSuppression };
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

/**
 * Builds a fake composite-processor factory. `create` records the options each
 * attach was constructed with; `processor` is the single fake instance
 * returned. Errors are simulated by throwing from `create`.
 */
function makeProcessorFactory(
  overrides: {
    supported?: boolean;
    createError?: Error;
  } = {}
) {
  const processor = {
    name: 'fake-processor',
    destroy: vi.fn(async () => {}),
    setSuppressionLevel: vi.fn(),
    setInputGain: vi.fn(),
    setGateThreshold: vi.fn(),
    setNoiseSuppressionEnabled: vi.fn(async () => {})
  } as unknown as FakeProcessor;
  const create = vi.fn((_options: unknown) => {
    if (overrides.createError) throw overrides.createError;
    return processor;
  });
  const factory: MicProcessorFactory = (options) =>
    create(options) as unknown as ReturnType<MicProcessorFactory>;
  const isSupported = () => overrides.supported ?? true;
  return { factory, processor, create, isSupported };
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
    bundle?: { factory: MicProcessorFactory; isSupported: () => boolean }
  ): NoiseSuppressionController {
    const controller = bundle
      ? new NoiseSuppressionController(onChanged, bundle.factory, bundle.isSupported)
      : new NoiseSuppressionController(onChanged);
    made.push(controller);
    return controller;
  }

  async function resetPreference() {
    const reset = new NoiseSuppressionController(() => {});
    await reset.setMode('off');
    await reset.setStrength(NOISE_REDUCTION_LEVEL);
    await reset.setInputGain(DEFAULT_INPUT_GAIN);
    await reset.setSensitivity(DEFAULT_SENSITIVITY);
  }

  beforeEach(async () => {
    localStorage.clear();
    stubVoiceIsolationSupport(true);
    await resetPreference();
  });

  afterEach(() => {
    for (const controller of made) controller.handleCallEnded();
    made.length = 0;
    vi.unstubAllGlobals();
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
    expect(b.captureConstraints()).toEqual({
      voiceIsolation: false,
      noiseSuppression: false,
      autoGainControl: true
    });

    await b.setMode('voice-isolation');
    expect(a.mode).toBe('voice-isolation');
  });

  it('reconciles other controllers with active calls on mode change', async () => {
    const factoryA = makeProcessorFactory();
    const factoryB = makeProcessorFactory();
    const a = makeController(() => {}, factoryA);
    const b = makeController(() => {}, factoryB);
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

  it('states voiceIsolation and noiseSuppression explicitly for every mode', async () => {
    const controller = makeController();
    expect(controller.captureConstraints()).toEqual({
      voiceIsolation: false,
      noiseSuppression: true,
      autoGainControl: true
    });
    await controller.setMode('voice-isolation');
    expect(controller.captureConstraints()).toEqual({
      voiceIsolation: true,
      noiseSuppression: true,
      autoGainControl: true
    });
    // Enhanced must not stack on the browser's own suppressor: DFN3 wants an
    // unsuppressed capture.
    await controller.setMode('enhanced');
    expect(controller.captureConstraints()).toEqual({
      voiceIsolation: false,
      noiseSuppression: false,
      autoGainControl: true
    });
  });

  it('attaches the composite processor with DFN3 on and reports active', async () => {
    const onChanged = vi.fn();
    const bundle = makeProcessorFactory();
    const controller = makeController(onChanged, bundle);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(track.setProcessor).toHaveBeenCalledWith(bundle.processor);
    expect(bundle.create).toHaveBeenCalledWith(
      expect.objectContaining({ noiseSuppressionEnabled: true })
    );
    expect(controller.status).toBe('active');
    expect(onChanged).toHaveBeenCalled();
  });

  it('reports unavailable and keeps the call usable when the processor fails to create', async () => {
    const bundle = makeProcessorFactory({ createError: new Error('network down') });
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(controller.status).toBe('unavailable');
    expect(track.setProcessor).not.toHaveBeenCalled();
  });

  it('reports unavailable when the processor is unsupported', async () => {
    const bundle = makeProcessorFactory({ supported: false });
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(controller.status).toBe('unavailable');
    expect(track.setProcessor).not.toHaveBeenCalled();
  });

  it('destroys an unadopted processor when attachment fails', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    // Rejection without adoption: getProcessor never returns ours.
    track.setProcessor.mockRejectedValue(new Error('worklet failed'));
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(bundle.processor.destroy).toHaveBeenCalled();
    expect(track.stopProcessor).not.toHaveBeenCalled();
    expect(controller.status).toBe('unavailable');
  });

  it('unwinds through stopProcessor when a failed attach was already adopted', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
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
    expect(bundle.processor.destroy).not.toHaveBeenCalled();
    expect(controller.status).toBe('unavailable');
  });

  it('stops the processor when switching back to off', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    await controller.setMode('off');
    expect(track.stopProcessor).toHaveBeenCalled();
    expect(controller.status).toBe('off');
  });

  it('reports unavailable on off when detach recovery also fails', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
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
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
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
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    const first = controller.setMode('enhanced');
    const second = controller.setMode('off');
    const third = controller.setMode('enhanced');
    await Promise.all([first, second, third]);

    expect(controller.status).toBe('active');
    expect(track.currentProcessor).toBe(bundle.processor);
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
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
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

  it('disables browser noise suppression before attaching the enhanced processor', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    // Model a capture that started on the browser-suppressed baseline.
    track.constraints = { noiseSuppression: true };
    track.sourceSettings = { noiseSuppression: true };
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(track.restartTrack).toHaveBeenCalledWith(
      expect.objectContaining({ noiseSuppression: false, voiceIsolation: false })
    );
    // The restart happened before the processor attach, so DFN3 never sees a
    // browser-suppressed capture.
    expect(track.restartTrack.mock.invocationCallOrder[0]).toBeLessThan(
      track.setProcessor.mock.invocationCallOrder[0]
    );
    expect(controller.status).toBe('active');
  });

  it('restores browser noise suppression when leaving enhanced', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    track.constraints = { noiseSuppression: true };
    track.sourceSettings = { noiseSuppression: true };
    await controller.applyToCall(makeFakeRoom(track));
    await controller.setMode('enhanced');
    expect(track.sourceSettings.noiseSuppression).toBe(false);

    await controller.setMode('off');
    expect(track.restartTrack).toHaveBeenLastCalledWith(
      expect.objectContaining({ noiseSuppression: true })
    );
    expect(controller.status).toBe('off');
  });

  it('does not attach the enhanced processor when browser suppression cannot be disabled', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    track.constraints = { noiseSuppression: true };
    track.sourceSettings = { noiseSuppression: true };
    // Browser accepts the restart but keeps reporting suppression on.
    track.restartTrack.mockImplementation(async () => {});
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(track.setProcessor).not.toHaveBeenCalled();
    expect(controller.status).toBe('unavailable');
  });

  it('treats an unreported noiseSuppression setting as best-effort applied', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    // Engine that never reports the setting (e.g. WebKit views): the restart
    // updates the stored constraints but settings stay silent.
    track.restartTrack.mockImplementation(async (opts: Record<string, unknown>) => {
      track.constraints = { ...opts };
    });
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(track.restartTrack).toHaveBeenCalledWith(
      expect.objectContaining({ noiseSuppression: false })
    );
    expect(track.setProcessor).toHaveBeenCalledWith(bundle.processor);
    expect(controller.status).toBe('active');
  });

  it('preserves the selected microphone deviceId across baseline restarts', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    track.constraints = { deviceId: { exact: 'usb-mic' }, noiseSuppression: true };
    track.sourceSettings = { noiseSuppression: true };
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    expect(track.restartTrack).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: { exact: 'usb-mic' }, noiseSuppression: false })
    );
  });

  it('disables the DFN3 stage when a baseline re-apply fails while attached', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    await controller.setMode('enhanced');
    expect(controller.status).toBe('active');

    // The browser reverts to its own suppression (e.g. after an OS-level
    // device event) and the corrective restart fails: the live stage must
    // not keep running behind a non-active status — that would also latch
    // away a later overload verdict.
    track.sourceSettings = { ...track.sourceSettings, noiseSuppression: true };
    track.restartTrack.mockRejectedValue(new Error('device busy'));
    await controller.setMode('enhanced');
    expect(controller.status).toBe('unavailable');
    expect(bundle.processor.setNoiseSuppressionEnabled).toHaveBeenLastCalledWith(false);
  });

  it('falls back to browser processing on sustained suppression overload', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    await controller.setMode('enhanced');
    expect(controller.status).toBe('active');

    const options = bundle.create.mock.calls[0][0] as {
      onSuppressionOverload?: () => void;
    };
    options.onSuppressionOverload?.();
    // The DFN3 stage is disabled in place; gate/gain (and the call) survive.
    expect(bundle.processor.setNoiseSuppressionEnabled).toHaveBeenLastCalledWith(false);
    expect(controller.status).toBe('unavailable');
    expect(track.stopProcessor).not.toHaveBeenCalled();
  });

  it('ignores a late overload signal after leaving enhanced', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    await controller.setMode('enhanced');
    const options = bundle.create.mock.calls[0][0] as {
      onSuppressionOverload?: () => void;
    };

    await controller.setMode('off');
    const callsBefore = bundle.processor.setNoiseSuppressionEnabled.mock.calls.length;
    options.onSuppressionOverload?.();
    expect(controller.status).toBe('off');
    expect(bundle.processor.setNoiseSuppressionEnabled.mock.calls.length).toBe(callsBefore);
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
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);
    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));

    await controller.setMode('enhanced');
    controller.handleCallEnded();
    expect(controller.status).toBe('off');
    expect(controller.mode).toBe('enhanced');
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('enhanced');
  });

  it('stays off with no active call and applies once a call starts', async () => {
    const bundle = makeProcessorFactory();
    const controller = makeController(() => {}, bundle);

    await controller.setMode('enhanced');
    expect(controller.status).toBe('off');

    const track = makeFakeMicTrack();
    await controller.applyToCall(makeFakeRoom(track));
    expect(track.setProcessor).toHaveBeenCalledWith(bundle.processor);
    expect(controller.status).toBe('active');
  });
});

describe('noise suppression strength', () => {
  const made: NoiseSuppressionController[] = [];

  beforeEach(async () => {
    localStorage.clear();
    stubVoiceIsolationSupport(true);
    const reset = new NoiseSuppressionController(() => {});
    await reset.setMode('off');
    await reset.setStrength(NOISE_REDUCTION_LEVEL);
    await reset.setInputGain(DEFAULT_INPUT_GAIN);
    await reset.setSensitivity(DEFAULT_SENSITIVITY);
  });

  afterEach(() => {
    for (const controller of made) controller.handleCallEnded();
    made.length = 0;
    vi.unstubAllGlobals();
  });

  it('defaults strength to the benchmark-chosen attenuation limit', () => {
    const c = new NoiseSuppressionController(() => {});
    made.push(c);
    expect(c.strength).toBe(NOISE_REDUCTION_LEVEL);
  });

  it('persists and clamps strength to 0..100', async () => {
    const c = new NoiseSuppressionController(() => {});
    made.push(c);
    await c.setStrength(130);
    expect(c.strength).toBe(MAX_STRENGTH);
    expect(localStorage.getItem(STRENGTH_STORAGE_KEY)).toBe(String(MAX_STRENGTH));
    await c.setStrength(-5);
    expect(c.strength).toBe(MIN_STRENGTH);
  });

  it('passes the current strength to the processor factory on enhanced attach', async () => {
    const bundle = makeProcessorFactory({ supported: true });
    const c = new NoiseSuppressionController(() => {}, bundle.factory, bundle.isSupported);
    made.push(c);
    await c.setStrength(42);
    stubVoiceIsolationSupport(false);
    const track = makeFakeMicTrack();
    await c.applyToCall(makeFakeRoom(track));
    await c.setMode('enhanced');
    expect(bundle.create).toHaveBeenCalledWith(expect.objectContaining({ suppressionLevel: 42 }));
  });

  it('retunes an attached processor live via setSuppressionLevel', async () => {
    const bundle = makeProcessorFactory({ supported: true });
    const c = new NoiseSuppressionController(() => {}, bundle.factory, bundle.isSupported);
    made.push(c);
    stubVoiceIsolationSupport(false);
    await c.applyToCall(makeFakeRoom(makeFakeMicTrack()));
    await c.setMode('enhanced');
    await c.setStrength(25);
    expect(bundle.processor.setSuppressionLevel).toHaveBeenCalledWith(25);
  });
});

describe('input gain and noise gate', () => {
  const made: NoiseSuppressionController[] = [];

  beforeEach(async () => {
    localStorage.clear();
    stubVoiceIsolationSupport(true);
    const reset = new NoiseSuppressionController(() => {});
    await reset.setMode('off');
    await reset.setStrength(NOISE_REDUCTION_LEVEL);
    await reset.setInputGain(DEFAULT_INPUT_GAIN);
    await reset.setSensitivity(DEFAULT_SENSITIVITY);
  });

  afterEach(() => {
    for (const controller of made) controller.handleCallEnded();
    made.length = 0;
    vi.unstubAllGlobals();
  });

  it('persists and clamps input gain', async () => {
    const c = new NoiseSuppressionController(() => {});
    made.push(c);
    await c.setInputGain(250);
    expect(c.inputGain).toBe(MAX_INPUT_GAIN);
    expect(localStorage.getItem(INPUT_GAIN_STORAGE_KEY)).toBe(String(MAX_INPUT_GAIN));
    await c.setInputGain(-10);
    expect(c.inputGain).toBe(MIN_INPUT_GAIN);
  });

  it('persists and clamps sensitivity', async () => {
    const c = new NoiseSuppressionController(() => {});
    made.push(c);
    await c.setSensitivity(140);
    expect(c.sensitivity).toBe(100);
    expect(localStorage.getItem(SENSITIVITY_STORAGE_KEY)).toBe('100');
  });

  it('attaches the processor in off mode when input gain leaves unity', async () => {
    const bundle = makeProcessorFactory();
    const c = new NoiseSuppressionController(() => {}, bundle.factory, bundle.isSupported);
    made.push(c);
    stubVoiceIsolationSupport(false);
    const track = makeFakeMicTrack();
    await c.applyToCall(makeFakeRoom(track));
    // off + unity gain + no gate: no processor attached.
    expect(track.setProcessor).not.toHaveBeenCalled();

    await c.setInputGain(150);
    expect(track.setProcessor).toHaveBeenCalledWith(bundle.processor);
    // DFN3 stays off in `off` mode; status stays off (gate/gain are orthogonal).
    expect(bundle.create).toHaveBeenCalledWith(
      expect.objectContaining({ noiseSuppressionEnabled: false, inputGain: 1.5 })
    );
    expect(c.status).toBe('off');
  });

  it('attaches the processor in off mode when the gate is enabled', async () => {
    const bundle = makeProcessorFactory();
    const c = new NoiseSuppressionController(() => {}, bundle.factory, bundle.isSupported);
    made.push(c);
    stubVoiceIsolationSupport(false);
    const track = makeFakeMicTrack();
    await c.applyToCall(makeFakeRoom(track));

    await c.setSensitivity(30);
    expect(track.setProcessor).toHaveBeenCalledWith(bundle.processor);
    expect(bundle.create).toHaveBeenCalledWith(expect.objectContaining({ gateThreshold: 0.3 }));
  });

  it('detaches the processor when gain and gate return to default in off mode', async () => {
    const bundle = makeProcessorFactory();
    const c = new NoiseSuppressionController(() => {}, bundle.factory, bundle.isSupported);
    made.push(c);
    stubVoiceIsolationSupport(false);
    const track = makeFakeMicTrack();
    await c.applyToCall(makeFakeRoom(track));

    await c.setInputGain(150);
    expect(track.setProcessor).toHaveBeenCalledTimes(1);
    await c.setInputGain(DEFAULT_INPUT_GAIN);
    expect(track.stopProcessor).toHaveBeenCalled();
    expect(c.status).toBe('off');
  });

  it('live-updates an attached processor without reattaching', async () => {
    const bundle = makeProcessorFactory();
    const c = new NoiseSuppressionController(() => {}, bundle.factory, bundle.isSupported);
    made.push(c);
    stubVoiceIsolationSupport(false);
    const track = makeFakeMicTrack();
    await c.applyToCall(makeFakeRoom(track));
    await c.setMode('enhanced');
    expect(track.setProcessor).toHaveBeenCalledTimes(1);

    await c.setInputGain(120);
    await c.setSensitivity(40);
    expect(bundle.processor.setInputGain).toHaveBeenCalledWith(1.2);
    expect(bundle.processor.setGateThreshold).toHaveBeenCalledWith(0.4);
    // No reattach: the processor is reconfigured in place.
    expect(track.setProcessor).toHaveBeenCalledTimes(1);
  });
});
