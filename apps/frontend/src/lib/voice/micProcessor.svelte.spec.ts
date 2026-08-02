import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MicProcessor,
  OVERLOAD_INTERVALS,
  OVERLOAD_MIN_UNDERRUNS,
  type DfnCore,
  type DfnCoreFactory
} from './micProcessor';
import type { DfnStats } from './dfnWorkletCore';

/**
 * Builds a MicProcessor wired to a fake DFN core, capturing the `onStats`
 * callback the processor hands to the core loader so tests can inject
 * realtime-health reports. The core's worklet node is a plain GainNode —
 * structurally sufficient for the audio graph.
 */
function makeHarness(overrides: { noiseSuppressionEnabled?: boolean } = {}) {
  let onStats: ((stats: DfnStats) => void) | undefined;
  const core: DfnCore = {
    initialize: vi.fn(async () => {}),
    createAudioWorkletNode: vi.fn(
      async (ctx: AudioContext) => ctx.createGain() as unknown as AudioWorkletNode
    ),
    setSuppressionLevel: vi.fn(),
    setNoiseSuppressionEnabled: vi.fn(),
    destroy: vi.fn()
  };
  const loadCore: DfnCoreFactory = async (opts) => {
    onStats = opts.onStats;
    return core;
  };
  const onSuppressionOverload = vi.fn();
  const processor = new MicProcessor({
    inputGain: 1,
    gateThreshold: 0,
    noiseSuppressionEnabled: overrides.noiseSuppressionEnabled ?? true,
    suppressionLevel: 30,
    assetPath: '/models/deepfilternet3',
    onSuppressionOverload,
    loadCore
  });
  return {
    processor,
    core,
    onSuppressionOverload,
    stats: (underruns: number) => onStats?.({ underruns, quanta: 750 })
  };
}

async function makeTrack(): Promise<{ track: MediaStreamTrack; cleanup: () => void }> {
  const ctx = new AudioContext();
  const destination = ctx.createMediaStreamDestination();
  const track = destination.stream.getAudioTracks()[0];
  return {
    track,
    cleanup: () => {
      track.stop();
      void ctx.close().catch(() => {});
    }
  };
}

describe('MicProcessor overload watchdog', () => {
  const cleanups: (() => void | Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function initialized(overrides: { noiseSuppressionEnabled?: boolean } = {}) {
    const harness = makeHarness(overrides);
    const { track, cleanup } = await makeTrack();
    cleanups.push(cleanup);
    cleanups.push(() => harness.processor.destroy());
    await harness.processor.init({ track });
    return harness;
  }

  it('fires once after sustained overloaded intervals', async () => {
    const { stats, onSuppressionOverload } = await initialized();
    for (let i = 0; i < OVERLOAD_INTERVALS; i++) stats(OVERLOAD_MIN_UNDERRUNS);
    expect(onSuppressionOverload).toHaveBeenCalledTimes(1);

    // Latched: further overloaded intervals do not re-fire.
    stats(OVERLOAD_MIN_UNDERRUNS);
    expect(onSuppressionOverload).toHaveBeenCalledTimes(1);
  });

  it('does not fire on an isolated spike', async () => {
    const { stats, onSuppressionOverload } = await initialized();
    stats(OVERLOAD_MIN_UNDERRUNS);
    // A healthy interval resets the consecutive counter.
    stats(0);
    stats(OVERLOAD_MIN_UNDERRUNS);
    expect(onSuppressionOverload).not.toHaveBeenCalled();
  });

  it('ignores stats while the DFN3 stage is disabled', async () => {
    const { processor, stats, onSuppressionOverload } = await initialized();
    await processor.setNoiseSuppressionEnabled(false);
    for (let i = 0; i < OVERLOAD_INTERVALS + 1; i++) stats(OVERLOAD_MIN_UNDERRUNS);
    expect(onSuppressionOverload).not.toHaveBeenCalled();
  });

  it('re-arms when the stage is re-enabled after an overload', async () => {
    const { processor, stats, onSuppressionOverload } = await initialized();
    for (let i = 0; i < OVERLOAD_INTERVALS; i++) stats(OVERLOAD_MIN_UNDERRUNS);
    expect(onSuppressionOverload).toHaveBeenCalledTimes(1);

    await processor.setNoiseSuppressionEnabled(false);
    await processor.setNoiseSuppressionEnabled(true);
    for (let i = 0; i < OVERLOAD_INTERVALS; i++) stats(OVERLOAD_MIN_UNDERRUNS);
    expect(onSuppressionOverload).toHaveBeenCalledTimes(2);
  });

  it('keeps the worklet bypass in sync with the enabled state', async () => {
    const { processor, core } = await initialized();
    expect(core.setNoiseSuppressionEnabled).toHaveBeenCalledWith(true);
    await processor.setNoiseSuppressionEnabled(false);
    expect(core.setNoiseSuppressionEnabled).toHaveBeenCalledWith(false);
  });
});
