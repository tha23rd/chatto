import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MicTest, type MicTestProcessor, type MicTestProcessorFactory } from './micTest.svelte';

function fakeProcessor(): MicTestProcessor & Record<string, ReturnType<typeof vi.fn>> {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    setInputGain: vi.fn(),
    setGateThreshold: vi.fn(),
    setSuppressionLevel: vi.fn(),
    setNoiseSuppressionEnabled: vi.fn().mockResolvedValue(undefined),
    getInputLevel: vi.fn(() => 0)
  } as unknown as MicTestProcessor & Record<string, ReturnType<typeof vi.fn>>;
}

describe('MicTest', () => {
  let processor: ReturnType<typeof fakeProcessor>;
  let factory: MicTestProcessorFactory;
  let track: { stop: ReturnType<typeof vi.fn> };
  let stream: { getAudioTracks: () => unknown[]; getTracks: () => unknown[] };

  beforeEach(() => {
    processor = fakeProcessor();
    factory = vi.fn(() => processor);
    track = { stop: vi.fn() };
    stream = { getAudioTracks: () => [track], getTracks: () => [track] };

    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) }
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 0)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('starts: builds the processor graph and becomes running', async () => {
    const t = new MicTest(factory);
    await t.start();
    expect(processor.init).toHaveBeenCalledWith({ track });
    expect(t.status).toBe('running');
  });

  it('passes the current config to the processor factory', async () => {
    const t = new MicTest(factory);
    await t.start({ strength: 40, inputGain: 150, sensitivity: 30, noiseSuppressionEnabled: true });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressionLevel: 40,
        inputGain: 1.5,
        gateThreshold: 0.3,
        noiseSuppressionEnabled: true,
        monitor: true
      })
    );
  });

  it('defaults suppression off (Standard) when the config omits it', async () => {
    const t = new MicTest(factory);
    await t.start({ strength: 40 });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ noiseSuppressionEnabled: false })
    );
  });

  it('forwards strength, gain, sensitivity, and live mode changes', async () => {
    const t = new MicTest(factory);
    await t.start();
    t.setStrength(30);
    expect(processor.setSuppressionLevel).toHaveBeenCalledWith(30);
    t.setInputGain(120);
    expect(processor.setInputGain).toHaveBeenCalledWith(1.2);
    t.setSensitivity(40);
    expect(processor.setGateThreshold).toHaveBeenCalledWith(0.4);
    // Selecting Enhanced while running enables the DFN stage live.
    t.setNoiseSuppressionEnabled(true);
    expect(processor.setNoiseSuppressionEnabled).toHaveBeenCalledWith(true);
  });

  it('stop() tears down the processor and releases the microphone', async () => {
    const t = new MicTest(factory);
    await t.start();
    t.stop();
    expect(processor.destroy).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(t.status).toBe('idle');
  });

  it('stop() during an in-flight start() releases the mic and never goes live', async () => {
    // getUserMedia stays pending until we resolve it, so stop() lands mid-start.
    let resolveGetUserMedia: (s: unknown) => void = () => {};
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGetUserMedia = resolve;
        })
    );

    const t = new MicTest(factory);
    const pending = t.start();
    t.stop(); // cancel while getUserMedia is still pending
    resolveGetUserMedia(stream); // now the mic resolves late
    await pending;

    expect(t.status).toBe('idle');
    expect(track.stop).toHaveBeenCalled(); // late-acquired mic is released
    expect(processor.init).not.toHaveBeenCalled(); // graph was never built
  });

  it('start() failure sets error status', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('denied')
    );
    const t = new MicTest(factory);
    await t.start();
    expect(t.status).toBe('error');
  });
});
