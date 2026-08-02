/**
 * Fork-owned composite outbound-microphone processor.
 *
 * A single LiveKit `TrackProcessor` that chains, in order:
 *
 *   mic → input gain → noise gate → [DeepFilterNet3 worklet, if enabled] → out
 *
 * All three stages are independent: input gain and the noise gate work in any
 * noise-suppression mode (including with DeepFilterNet3 off), and DeepFilterNet3
 * is an optional final stage. The DeepFilterNet3 WASM/model is lazy-loaded only
 * the first time suppression is enabled, so gate-only users never pay for it.
 *
 * The DFN3 stage runs in the fork-owned same-origin worklet
 * (`static/worklets/dfn3-processor.js`, loaded through `DfnWorkletCore`),
 * which reports periodic underrun stats; this class turns sustained underruns
 * into an `onSuppressionOverload` callback so the owner can fall back to
 * browser processing instead of letting the user sit through crackling audio.
 * `init`/`restart` (re)build the graph on the current capture track,
 * `destroy` tears it down. Kept dependency-free of Svelte runes — the
 * reactive preference lives in the controller; this class only owns the
 * audio graph.
 */
import { Track, type TrackProcessor } from 'livekit-client';
import type { DfnStats } from './dfnWorkletCore';

/** DFN3 core surface this processor depends on; fakeable in tests. */
export type DfnCore = {
  initialize(): Promise<void>;
  createAudioWorkletNode(ctx: AudioContext): Promise<AudioWorkletNode>;
  setSuppressionLevel(level: number): void;
  setNoiseSuppressionEnabled(enabled: boolean): void;
  destroy(): void;
};

/** Loads the DeepFilterNet3 core; injectable so tests avoid the real WASM. */
export type DfnCoreFactory = (opts: {
  noiseReductionLevel: number;
  assetPath: string;
  onStats?: (stats: DfnStats) => void;
}) => Promise<DfnCore>;

export type MicProcessorOptions = {
  /** Linear input-gain multiplier applied first (1 = unity/0 dB). */
  inputGain: number;
  /**
   * Noise-gate open threshold as a normalized peak level (0..1) on the
   * gained signal. 0 disables the gate (audio always passes).
   */
  gateThreshold: number;
  /** Whether the DeepFilterNet3 stage is active. */
  noiseSuppressionEnabled: boolean;
  /** DeepFilterNet3 attenuation limit (0..100). */
  suppressionLevel: number;
  /** Same-origin DeepFilterNet3 asset path. */
  assetPath: string;
  /**
   * Also play the processed output through the AudioContext's own speaker
   * output for a local monitor (the mic test). Off for the call path, where
   * the member must not hear themselves. Monitoring straight from the graph
   * avoids the crackle of routing the destination-node stream back out through
   * an `<audio>` element.
   */
  monitor?: boolean;
  /**
   * Called once when the DeepFilterNet3 stage sustains realtime underruns
   * (see the overload constants below): the device cannot keep up, and the
   * owner should disable the stage and surface the fallback. Re-enabling the
   * stage re-arms the watchdog.
   */
  onSuppressionOverload?: () => void;
  /** DFN3 core loader; defaults to the fork's `DfnWorkletCore`. */
  loadCore?: DfnCoreFactory;
};

const defaultLoadCore: DfnCoreFactory = async ({ noiseReductionLevel, assetPath, onStats }) => {
  const { DfnWorkletCore } = await import('./dfnWorkletCore');
  return new DfnWorkletCore({ noiseReductionLevel, assetPath, onStats });
};

/**
 * Overload watchdog: with stats every ~2 s, an interval counts as overloaded
 * when it concealed at least `OVERLOAD_MIN_UNDERRUNS` output gaps (8 × 2.7 ms
 * ≈ 21 ms of audio lost per 2 s — clearly audible crackle), and sustained
 * overload means `OVERLOAD_INTERVALS` such intervals in a row. Brief one-off
 * spikes (GC, tab switches) don't trip it.
 */
export const OVERLOAD_MIN_UNDERRUNS = 8;
export const OVERLOAD_INTERVALS = 2;

const clampGain = (n: number): number => (Number.isFinite(n) && n >= 0 ? n : 1);
const clampThreshold = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

// Gate smoothing time constants (seconds) for AudioParam.setTargetAtTime, plus
// a hold so brief dips below the threshold between words do not chatter it shut.
const GATE_ATTACK = 0.01;
const GATE_RELEASE = 0.12;
const GATE_HOLD_SECONDS = 0.25;

/**
 * Composite microphone processor. One instance per attached outbound track;
 * `destroy()` releases the audio graph. Config setters apply live without
 * rebuilding the graph, except enabling DeepFilterNet3 for the first time,
 * which lazy-loads its worklet and splices it in.
 */
export class MicProcessor implements TrackProcessor<Track.Kind.Audio> {
  readonly name = 'chatto-mic-processor';
  processedTrack?: MediaStreamTrack;

  private readonly loadCore: DfnCoreFactory;
  private readonly monitor: boolean;
  private readonly onSuppressionOverload?: () => void;
  private assetPath: string;
  private inputGain: number;
  private gateThreshold: number;
  private dfnEnabled: boolean;
  private suppressionLevel: number;
  /** Consecutive overloaded stats intervals; see OVERLOAD_* constants. */
  private overloadedIntervals = 0;
  /** One-shot latch so a single overload fires a single callback. */
  private overloadFired = false;

  private originalTrack: MediaStreamTrack | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private gateNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  /** Lazy DeepFilterNet3 stage, kept once loaded so re-enabling is instant. */
  private core: DfnCore | null = null;
  private worklet: AudioWorkletNode | null = null;

  private raf = 0;
  private gateOpenUntil = 0;

  constructor(options: MicProcessorOptions) {
    this.loadCore = options.loadCore ?? defaultLoadCore;
    this.monitor = options.monitor ?? false;
    this.onSuppressionOverload = options.onSuppressionOverload;
    this.assetPath = options.assetPath;
    this.inputGain = clampGain(options.inputGain);
    this.gateThreshold = clampThreshold(options.gateThreshold);
    this.dfnEnabled = options.noiseSuppressionEnabled;
    this.suppressionLevel = options.suppressionLevel;
  }

  static isSupported(): boolean {
    return typeof AudioContext !== 'undefined' && typeof WebAssembly !== 'undefined';
  }

  /**
   * Current peak level (0..1) of the gained, pre-gate signal — what the gate
   * keys off. Exposed so a loopback meter can show the level the gate reacts
   * to and align a threshold marker with it.
   */
  getInputLevel(): number {
    const analyser = this.analyser;
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 128);
  }

  async init(opts: {
    track?: MediaStreamTrack;
    mediaStreamTrack?: MediaStreamTrack;
  }): Promise<void> {
    const track = opts.track ?? opts.mediaStreamTrack;
    if (!track) throw new Error('MicProcessor.init: missing MediaStreamTrack');
    this.originalTrack = track;
    await this.ensureGraph();
  }

  async restart(opts: {
    track?: MediaStreamTrack;
    mediaStreamTrack?: MediaStreamTrack;
  }): Promise<void> {
    const track = opts.track ?? opts.mediaStreamTrack;
    if (track) this.originalTrack = track;
    await this.ensureGraph();
  }

  async destroy(): Promise<void> {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.source?.disconnect();
    this.gainNode?.disconnect();
    this.gateNode?.disconnect();
    this.analyser?.disconnect();
    this.worklet?.disconnect();
    this.destination?.disconnect();
    this.core?.destroy();
    this.core = null;
    this.worklet = null;
    this.source = this.gainNode = this.gateNode = null;
    this.analyser = null;
    this.destination = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  /** Linear input-gain multiplier (1 = unity). Applied live. */
  setInputGain(gain: number): void {
    this.inputGain = clampGain(gain);
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setTargetAtTime(this.inputGain, this.ctx.currentTime, GATE_ATTACK);
    }
  }

  /** Gate open threshold (0..1); 0 disables gating. Applied live. */
  setGateThreshold(threshold: number): void {
    this.gateThreshold = clampThreshold(threshold);
    // When disabled, force the gate fully open so audio is never held shut.
    if (this.gateThreshold === 0 && this.gateNode && this.ctx) {
      this.gateNode.gain.setTargetAtTime(1, this.ctx.currentTime, GATE_ATTACK);
    }
  }

  /** DeepFilterNet3 attenuation limit (0..100). Applied live. */
  setSuppressionLevel(level: number): void {
    this.suppressionLevel = level;
    this.core?.setSuppressionLevel(level);
  }

  /**
   * Enable/disable the DeepFilterNet3 stage. Enabling for the first time
   * lazy-loads the worklet and splices it into the graph; disabling reroutes
   * the gate straight to the output but keeps the loaded worklet for instant
   * re-enable.
   */
  async setNoiseSuppressionEnabled(enabled: boolean): Promise<void> {
    this.dfnEnabled = enabled;
    if (enabled) {
      // Re-enabling re-arms the overload watchdog for a fresh verdict.
      this.overloadedIntervals = 0;
      this.overloadFired = false;
    }
    if (!this.ctx || !this.gateNode || !this.destination) return;
    if (enabled) {
      await this.ensureWorklet();
      this.core?.setNoiseSuppressionEnabled(true);
      this.rewireDfn();
    } else if (this.worklet) {
      this.core?.setNoiseSuppressionEnabled(false);
      this.rewireDfn();
    }
  }

  private async ensureGraph(): Promise<void> {
    if (!this.originalTrack) throw new Error('MicProcessor: no source track');
    this.ctx ??= new AudioContext({ sampleRate: 48000 });
    // Resume without awaiting: on a suspended context (no user gesture yet,
    // or environments without an audio backend) resume() can stay pending
    // indefinitely, which would wedge the attach chain in `loading`. The
    // graph builds fine on a suspended context; audio flows once it starts.
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});

    this.gainNode ??= this.ctx.createGain();
    this.gateNode ??= this.ctx.createGain();
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
    }
    if (!this.destination) {
      this.destination = this.ctx.createMediaStreamDestination();
      this.processedTrack = this.destination.stream.getAudioTracks()[0];
    }
    this.gainNode.gain.value = this.inputGain;
    this.gateNode.gain.value = this.gateThreshold === 0 ? 1 : 0;

    if (this.dfnEnabled) await this.ensureWorklet();

    // (Re)connect the source; leave the persistent nodes wired.
    this.source?.disconnect();
    this.source = this.ctx.createMediaStreamSource(new MediaStream([this.originalTrack]));
    this.source.connect(this.gainNode);
    this.gainNode.disconnect();
    this.gainNode.connect(this.gateNode);
    this.gainNode.connect(this.analyser);
    this.rewireDfn();
    this.startGateLoop();
  }

  private async ensureWorklet(): Promise<void> {
    if (this.worklet || !this.ctx) return;
    this.core ??= await this.loadCore({
      noiseReductionLevel: this.suppressionLevel,
      assetPath: this.assetPath,
      onStats: (stats) => this.handleSuppressionStats(stats)
    });
    await this.core.initialize();
    this.worklet = await this.core.createAudioWorkletNode(this.ctx);
    this.core.setNoiseSuppressionEnabled(true);
    this.core.setSuppressionLevel(this.suppressionLevel);
  }

  /**
   * Watchdog over the worklet's periodic underrun stats: sustained missed
   * deadlines mean the device cannot run DFN3 in realtime, and continuing
   * produces exactly the crackling the feature is meant to remove.
   */
  private handleSuppressionStats(stats: DfnStats): void {
    if (!this.dfnEnabled || this.overloadFired) return;
    if (stats.underruns >= OVERLOAD_MIN_UNDERRUNS) {
      this.overloadedIntervals++;
      if (this.overloadedIntervals >= OVERLOAD_INTERVALS) {
        this.overloadFired = true;
        this.onSuppressionOverload?.();
      }
    } else {
      this.overloadedIntervals = 0;
    }
  }

  /** Route the gate either through the DFN3 worklet or straight to output. */
  private rewireDfn(): void {
    if (!this.gateNode || !this.destination) return;
    this.gateNode.disconnect();
    this.worklet?.disconnect();
    const terminal = this.dfnEnabled && this.worklet ? this.worklet : this.gateNode;
    if (terminal === this.worklet) this.gateNode.connect(this.worklet);
    terminal.connect(this.destination);
    // Local monitor (mic test): play straight from the graph, not via an
    // `<audio>` element fed by the destination-node stream, which crackles.
    if (this.monitor && this.ctx) terminal.connect(this.ctx.destination);
  }

  private startGateLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    const analyser = this.analyser;
    const gate = this.gateNode;
    const ctx = this.ctx;
    if (!analyser || !gate || !ctx) return;
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!this.analyser || !this.gateNode || !this.ctx) return;
      if (this.gateThreshold > 0) {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        const level = peak / 128;
        const now = this.ctx.currentTime;
        if (level >= this.gateThreshold) this.gateOpenUntil = now + GATE_HOLD_SECONDS;
        const open = now < this.gateOpenUntil;
        this.gateNode.gain.setTargetAtTime(open ? 1 : 0, now, open ? GATE_ATTACK : GATE_RELEASE);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
