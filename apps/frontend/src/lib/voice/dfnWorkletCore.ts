/**
 * Fork-owned loader for the DeepFilterNet3 AudioWorklet stage.
 *
 * Replaces the vendor `DeepFilterNet3Core` from `deepfilternet3-noise-filter`:
 * the worklet module is a same-origin static asset
 * (`static/worklets/dfn3-processor.js`) instead of a blob URL, which satisfies
 * the intended CSP (`worker-src 'self'`; the packaged desktop client's
 * `script-src` no longer needs a `blob:` exception), and the processor
 * protocol adds explicit ready/failure signalling plus periodic underrun
 * stats for the overload watchdog in `MicProcessor`.
 *
 * The WASM runtime and model are fetched from the same checksum-pinned
 * same-origin assets as before (`scripts/fetch-noise-models.mjs`), compiled on
 * the main thread, and handed to the worklet via `processorOptions`.
 */

/** Same-origin worklet module path. Must match the file under `static/`. */
export const DFN_WORKLET_PATH = '/worklets/dfn3-processor.js';

/** Registered processor name; must match `registerProcessor` in the worklet. */
const PROCESSOR_NAME = 'chatto-dfn3-processor';

/**
 * The worklet's model init runs synchronously in the processor constructor
 * (~100–600 ms on desktop). The timeout only guards against a worklet that
 * never reports back at all (e.g. a swallowed module error).
 */
const INIT_TIMEOUT_MS = 20_000;

/** Periodic realtime-health report from the worklet. */
export type DfnStats = {
  /** Concealed output underruns (missed render deadlines) in the interval. */
  underruns: number;
  /** Render quanta observed in the interval (~2 s at 48 kHz). */
  quanta: number;
};

const clampLevel = (value: number): number =>
  Math.max(0, Math.min(100, Math.floor(Number.isFinite(value) ? value : 0)));

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`DFN3 asset fetch failed (${response.status}): ${url}`);
  }
  return response.arrayBuffer();
}

/**
 * Loads the DeepFilterNet3 assets and creates the worklet node. One instance
 * per `MicProcessor`; assets stay cached on the instance so disabling and
 * re-enabling the stage is instant. `destroy()` releases the node reference —
 * the AudioContext owns the node's lifetime.
 */
export class DfnWorkletCore {
  private readonly assetPath: string;
  private readonly onStats?: (stats: DfnStats) => void;
  private level: number;
  private assets: { wasmModule: WebAssembly.Module; modelBytes: ArrayBuffer } | null = null;
  private node: AudioWorkletNode | null = null;

  constructor(options: {
    noiseReductionLevel: number;
    assetPath: string;
    onStats?: (stats: DfnStats) => void;
  }) {
    this.assetPath = options.assetPath;
    this.level = clampLevel(options.noiseReductionLevel);
    this.onStats = options.onStats;
  }

  /** Fetches and compiles the WASM runtime and model bytes (idempotent). */
  async initialize(): Promise<void> {
    if (this.assets) return;
    const [wasmBytes, modelBytes] = await Promise.all([
      fetchArrayBuffer(`${this.assetPath}/v3/pkg/df_bg.wasm`),
      fetchArrayBuffer(`${this.assetPath}/v3/models/DeepFilterNet3_onnx.tar.gz`)
    ]);
    const wasmModule = await WebAssembly.compile(wasmBytes);
    this.assets = { wasmModule, modelBytes };
  }

  /**
   * Adds the same-origin worklet module and constructs the processor node.
   * Resolves only after the worklet reports that model init succeeded, so an
   * in-worklet failure surfaces here (and the controller can fall back)
   * instead of silently passing audio through.
   */
  async createAudioWorkletNode(ctx: AudioContext): Promise<AudioWorkletNode> {
    if (!this.assets) throw new Error('DfnWorkletCore: initialize() must be called first');
    await ctx.audioWorklet.addModule(DFN_WORKLET_PATH);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        wasmModule: this.assets.wasmModule,
        modelBytes: this.assets.modelBytes,
        suppressionLevel: this.level
      }
    });
    await this.awaitReady(node);
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } & DfnStats;
      if (data?.type === 'stats') {
        this.onStats?.({ underruns: data.underruns, quanta: data.quanta });
      }
    };
    this.node = node;
    return node;
  }

  private awaitReady(node: AudioWorkletNode): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('DFN3 worklet did not report ready in time'));
      }, INIT_TIMEOUT_MS);
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; message?: string };
        if (data?.type === 'ready') {
          cleanup();
          resolve();
        } else if (data?.type === 'init-error') {
          cleanup();
          reject(new Error(data.message ?? 'DFN3 worklet init failed'));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        node.port.removeEventListener('message', onMessage);
      };
      node.port.addEventListener('message', onMessage);
      node.port.start();
    });
  }

  /** DeepFilterNet3 attenuation limit (0..100 dB). Applied live. */
  setSuppressionLevel(level: number): void {
    this.level = clampLevel(level);
    this.node?.port.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: this.level });
  }

  /** Toggles the worklet between processing and pass-through (bypass). */
  setNoiseSuppressionEnabled(enabled: boolean): void {
    this.node?.port.postMessage({ type: 'SET_BYPASS', value: !enabled });
  }

  destroy(): void {
    if (this.node) {
      this.node.port.close();
      this.node.disconnect();
      this.node = null;
    }
    this.assets = null;
  }
}
