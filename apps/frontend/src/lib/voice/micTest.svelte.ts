/**
 * Self-contained loopback mic test for the preferences page.
 *
 * Runs the fork's composite `MicProcessor` — the exact same processor the
 * outbound call path uses — on a local `getUserMedia` stream in monitor mode,
 * so its own AudioContext plays the processed audio straight to the speakers
 * and the user hears the true effect of the mode, suppression strength, input
 * gain, and noise gate, and can tune them live. Monitoring from the graph
 * (rather than routing the processed track back out through an `<audio>`
 * element) avoids the crackle that round-trip introduces. Independent of any
 * voice call; the processor owns its own AudioContext and releases the
 * microphone on `stop()`.
 *
 * Headphones are recommended: playback is intentionally audible so the user
 * hears the real output, which can feed back through open speakers.
 */
import {
  NOISE_SUPPRESSION_ASSETS_PATH,
  NOISE_REDUCTION_LEVEL,
  DEFAULT_INPUT_GAIN,
  DEFAULT_SENSITIVITY,
  MIN_STRENGTH,
  MAX_STRENGTH,
  MIN_INPUT_GAIN,
  MAX_INPUT_GAIN,
  MIN_SENSITIVITY,
  MAX_SENSITIVITY
} from './noiseSuppression.svelte';
import { MicProcessor, type MicProcessorOptions } from './micProcessor';

export type MicTestStatus = 'idle' | 'loading' | 'running' | 'error';

/** The subset of `MicProcessor` the mic test drives; fakeable in tests. */
export type MicTestProcessor = {
  init(opts: { track: MediaStreamTrack }): Promise<void>;
  destroy(): Promise<void> | void;
  setInputGain(gain: number): void;
  setGateThreshold(threshold: number): void;
  setSuppressionLevel(level: number): void;
  setNoiseSuppressionEnabled(enabled: boolean): void | Promise<void>;
  getInputLevel(): number;
};

export type MicTestProcessorFactory = (options: MicProcessorOptions) => MicTestProcessor;

/** Live starting values, mirroring the current noise-suppression preference. */
export type MicTestConfig = {
  /** DeepFilterNet3 attenuation limit (0..100). */
  strength?: number;
  /** Input gain percentage (100 = unity). */
  inputGain?: number;
  /** Gate sensitivity threshold (0..100; 0 = off). */
  sensitivity?: number;
  /**
   * Whether the DeepFilterNet3 stage runs, following the selected mode
   * (Enhanced on, otherwise off). The preview mirrors what would be sent, so
   * switching modes is the A/B comparison. Defaults off.
   */
  noiseSuppressionEnabled?: boolean;
};

const clamp = (n: number, lo: number, hi: number, fallback: number) =>
  Math.round(Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : fallback)));

const defaultCreateProcessor: MicTestProcessorFactory = (options) => new MicProcessor(options);

/**
 * Runs a local loopback: microphone → `MicProcessor` → monitor playback, plus
 * a peak-level meter. One instance per mic-test UI session; call `stop()` to
 * release the microphone and tear down the audio graph.
 */
export class MicTest {
  status = $state<MicTestStatus>('idle');
  /** Peak level (0..1) of the gained pre-gate signal, for the meter. */
  inputLevel = $state(0);

  private readonly createProcessor: MicTestProcessorFactory;
  private strength = NOISE_REDUCTION_LEVEL;
  private inputGain = DEFAULT_INPUT_GAIN;
  private sensitivity = DEFAULT_SENSITIVITY;
  /** DeepFilterNet3 stage on/off, following the selected mode. */
  private suppressionEnabled = false;

  private processor: MicTestProcessor | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  /**
   * Bumped by every `start()` and by `stop()`. `start()` re-checks it after
   * each await and bails (releasing anything acquired) if it changed, so a
   * `stop()` issued while `getUserMedia`/model-load is still pending cannot be
   * resurrected into a live microphone the caller believes was stopped.
   */
  private generation = 0;

  constructor(createProcessor: MicTestProcessorFactory = defaultCreateProcessor) {
    this.createProcessor = createProcessor;
  }

  async start(config: MicTestConfig = {}): Promise<void> {
    if (this.status === 'running' || this.status === 'loading') return;
    const gen = ++this.generation;
    this.strength = clamp(
      config.strength ?? NOISE_REDUCTION_LEVEL,
      MIN_STRENGTH,
      MAX_STRENGTH,
      NOISE_REDUCTION_LEVEL
    );
    this.inputGain = clamp(
      config.inputGain ?? DEFAULT_INPUT_GAIN,
      MIN_INPUT_GAIN,
      MAX_INPUT_GAIN,
      DEFAULT_INPUT_GAIN
    );
    this.sensitivity = clamp(
      config.sensitivity ?? DEFAULT_SENSITIVITY,
      MIN_SENSITIVITY,
      MAX_SENSITIVITY,
      DEFAULT_SENSITIVITY
    );
    this.suppressionEnabled = config.noiseSuppressionEnabled ?? false;
    this.status = 'loading';

    // Acquire into locals; only commit to instance fields once we know this
    // start() was not superseded, so a cancelled attempt leaks nothing.
    let stream: MediaStream | null = null;
    let processor: MicTestProcessor | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (gen !== this.generation) throw new Error('cancelled');
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('no microphone track');

      // `monitor: true` plays the processed audio through the processor's own
      // AudioContext.destination — no `<audio>` element round-trip.
      processor = this.createProcessor({
        inputGain: this.inputGain / 100,
        gateThreshold: this.sensitivity / 100,
        noiseSuppressionEnabled: this.suppressionEnabled,
        suppressionLevel: this.strength,
        assetPath: NOISE_SUPPRESSION_ASSETS_PATH,
        monitor: true
      });
      await processor.init({ track });
      if (gen !== this.generation) throw new Error('cancelled');

      this.stream = stream;
      this.processor = processor;
      this.status = 'running';
      this.pumpLevel();
    } catch {
      // Release whatever this attempt acquired but never committed.
      if (processor) await Promise.resolve(processor.destroy()).catch(() => {});
      stream?.getTracks().forEach((t) => t.stop());
      // Only report an error for a genuine failure. If a newer generation
      // superseded us (start() again, or stop()), leave its status intact.
      if (gen === this.generation) this.status = 'error';
    }
  }

  setStrength(value: number): void {
    this.strength = clamp(value, MIN_STRENGTH, MAX_STRENGTH, NOISE_REDUCTION_LEVEL);
    this.processor?.setSuppressionLevel(this.strength);
  }

  setInputGain(value: number): void {
    this.inputGain = clamp(value, MIN_INPUT_GAIN, MAX_INPUT_GAIN, DEFAULT_INPUT_GAIN);
    this.processor?.setInputGain(this.inputGain / 100);
  }

  setSensitivity(value: number): void {
    this.sensitivity = clamp(value, MIN_SENSITIVITY, MAX_SENSITIVITY, DEFAULT_SENSITIVITY);
    this.processor?.setGateThreshold(this.sensitivity / 100);
  }

  /** Follows the selected mode: Enhanced enables the DFN stage, others disable it. */
  setNoiseSuppressionEnabled(enabled: boolean): void {
    this.suppressionEnabled = enabled;
    void Promise.resolve(this.processor?.setNoiseSuppressionEnabled(enabled)).catch(() => {});
  }

  stop(): void {
    // Supersede any in-flight start() so it releases its resources and does
    // not commit a live graph after teardown.
    this.generation++;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.processor) void Promise.resolve(this.processor.destroy()).catch(() => {});
    this.processor = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.inputLevel = 0;
    if (this.status !== 'error') this.status = 'idle';
  }

  private pumpLevel(): void {
    const tick = () => {
      if (!this.processor) return;
      this.inputLevel = this.processor.getInputLevel();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
