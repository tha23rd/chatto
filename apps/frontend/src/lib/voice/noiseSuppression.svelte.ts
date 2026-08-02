/**
 * Fork-owned enhanced noise suppression for the local microphone.
 *
 * Chatto's baseline is the browser's WebRTC processing (AGC, echo
 * cancellation, noise suppression), requested in `VoiceCallState`'s
 * `audioCaptureDefaults`. Note that livekit-client's own audio defaults also
 * request `voiceIsolation: true`; the controller overrides that explicitly
 * per mode. This module adds optional, experimental processing on top of that
 * baseline:
 *
 * - `voice-isolation`: requests the experimental `voiceIsolation` media
 *   constraint (a stronger, browser-implemented suppression tier; ignored by
 *   browsers that do not support it).
 * - `enhanced`: attaches the fork's composite `MicProcessor` with its
 *   DeepFilterNet3 stage active on the outbound microphone track. Model and
 *   WASM assets are lazy-loaded only when suppression is first enabled.
 *
 * Independent of the mode, two capture knobs are applied through the same
 * composite processor whenever they are non-default: an **input gain** and a
 * **noise gate** ("input sensitivity"). Because the processor cannot coexist
 * with `voice-isolation` (which restarts the raw capture track), gain and gate
 * apply in `off` and `enhanced` modes only; `voice-isolation` is constraint
 * only. `off` with a non-default gain/gate still attaches the processor (with
 * its DeepFilterNet3 stage disabled), so a noise gate works without ML
 * suppression.
 *
 * Design constraints (see .context/voice-noise-suppression-review.md):
 * - The preference is per client (localStorage), not per server account.
 * - Any failure falls back to baseline browser processing without
 *   disconnecting the call; the UI must never show an active state after
 *   the processor failed.
 * - Only the outbound microphone track is processed.
 *
 * Concurrency model: all track mutations run through a per-controller
 * promise chain (`applyChain`), so a mode change never races an in-flight
 * attach/detach — LiveKit serializes `setProcessor`/`stopProcessor` on an
 * internal mutex, which makes unserialized check-then-stop patterns
 * TOCTOU-unsafe. Each queued apply re-reads the latest mode, so rapid
 * toggling converges on the final selection without applying intermediate
 * states.
 *
 * Kept out of `voiceCall.svelte.ts` as far as possible so upstream merges
 * touch a minimal diff there.
 */

import { Track, type LocalAudioTrack, type Room, type TrackProcessor } from 'livekit-client';
import { SvelteSet } from 'svelte/reactivity';
import { globalSlot, type Codec } from '$lib/storage/slot';
import { toast } from '$lib/ui/toast';
import * as m from '$lib/i18n/messages';
import { MicProcessor, type MicProcessorOptions } from './micProcessor';

export type NoiseSuppressionMode = 'off' | 'voice-isolation' | 'enhanced';

/**
 * UI-facing lifecycle state for the currently selected mode.
 * `unavailable` covers unsupported browsers and load/attach failures alike;
 * the call keeps running on baseline browser processing in that state.
 */
export type NoiseSuppressionStatus = 'off' | 'loading' | 'active' | 'unavailable';

const MODES: readonly NoiseSuppressionMode[] = ['off', 'voice-isolation', 'enhanced'];

/**
 * Storage codec for the persisted mode. Exported for tests: the module-load
 * read (`modeSlot.get()` into the shared preference below) cannot be
 * re-executed in browser-mode tests, so the parse contract is verified
 * directly instead.
 */
export const modeCodec: Codec<NoiseSuppressionMode> = {
  serialize: (v) => v,
  parse: (raw) =>
    MODES.includes(raw as NoiseSuppressionMode) ? (raw as NoiseSuppressionMode) : undefined
};

const modeSlot = globalSlot<NoiseSuppressionMode>('voiceNoiseSuppressionMode', 'off', modeCodec);

/**
 * DeepFilterNet3 suppression strength, shared with the benchmark harness
 * (`.context/noise-suppression-bench/bench.js` hardcodes the same value —
 * keep them in sync). The value is the model's attenuation limit in dB: it
 * caps how far noise is reduced while the raw signal is mixed back in
 * proportionally, masking processing artifacts.
 *
 * 30 was chosen from the 2026-08-01 level sweep: steady-noise separation is
 * flat across 20–100 (SI-SDR ≈ 19 dB white / 14.5 dB fan), while clean-speech
 * and transient fidelity strictly improve as the limit drops (clean 3.3 →
 * 4.0 dB, clicks 2.9 → 3.4 dB at 30) and a −30 dB residual floor avoids the
 * gated-to-silence pumping users hear at the package default of 80. The core
 * class defaults to 50, so always pass this explicitly.
 */
export const NOISE_REDUCTION_LEVEL = 30;

export const MIN_STRENGTH = 0;
export const MAX_STRENGTH = 100;

const clampStrength = (n: number): number =>
  Math.round(
    Math.min(MAX_STRENGTH, Math.max(MIN_STRENGTH, Number.isFinite(n) ? n : NOISE_REDUCTION_LEVEL))
  );

/** localStorage codec for the 0..100 integer strength (atten_lim, dB). */
export const strengthCodec: Codec<number> = {
  serialize: (v) => String(v),
  parse: (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? clampStrength(n) : undefined;
  }
};

const strengthSlot = globalSlot<number>(
  'voiceNoiseSuppressionStrength',
  NOISE_REDUCTION_LEVEL,
  strengthCodec
);

/**
 * Input gain applied before suppression, as a percentage where 100 is unity
 * (0 dB). Independent of the suppression mode.
 */
export const DEFAULT_INPUT_GAIN = 100;
export const MIN_INPUT_GAIN = 0;
export const MAX_INPUT_GAIN = 200;

const clampInputGain = (n: number): number =>
  Math.round(
    Math.min(MAX_INPUT_GAIN, Math.max(MIN_INPUT_GAIN, Number.isFinite(n) ? n : DEFAULT_INPUT_GAIN))
  );

export const inputGainCodec: Codec<number> = {
  serialize: (v) => String(v),
  parse: (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? clampInputGain(n) : undefined;
  }
};

const inputGainSlot = globalSlot<number>('voiceInputGain', DEFAULT_INPUT_GAIN, inputGainCodec);

/**
 * Noise-gate "input sensitivity": the peak level (0..100, same scale as the
 * mic-test meter) below which the microphone is gated shut. 0 disables the
 * gate. Independent of the suppression mode.
 */
export const DEFAULT_SENSITIVITY = 0;
export const MIN_SENSITIVITY = 0;
export const MAX_SENSITIVITY = 100;

const clampSensitivity = (n: number): number =>
  Math.round(
    Math.min(
      MAX_SENSITIVITY,
      Math.max(MIN_SENSITIVITY, Number.isFinite(n) ? n : DEFAULT_SENSITIVITY)
    )
  );

export const sensitivityCodec: Codec<number> = {
  serialize: (v) => String(v),
  parse: (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? clampSensitivity(n) : undefined;
  }
};

const sensitivitySlot = globalSlot<number>(
  'voiceGateSensitivity',
  DEFAULT_SENSITIVITY,
  sensitivityCodec
);

/**
 * The client-wide preference, shared by every controller instance. Server
 * stores are created eagerly (one `VoiceCallState` per registered server),
 * so a per-instance snapshot would go stale on other servers whenever the
 * mode changes on one of them.
 */
const preference = $state<{
  mode: NoiseSuppressionMode;
  strength: number;
  inputGain: number;
  sensitivity: number;
}>({
  mode: modeSlot.get(),
  strength: strengthSlot.get(),
  inputGain: inputGainSlot.get(),
  sensitivity: sensitivitySlot.get()
});

/**
 * Controllers currently attached to an active call (registered in
 * `applyToCall`, removed in `handleCallEnded`), so a mode change made on one
 * server's UI is applied to any other server's live call, not just displayed
 * by it.
 */
const activeControllers = new SvelteSet<NoiseSuppressionController>();

/**
 * Composite mic processor plus the lifecycle bits this controller relies on.
 * The real implementation is `MicProcessor`; tests inject a fake.
 */
type AudioTrackProcessor = TrackProcessor<Track.Kind.Audio> & {
  setSuppressionLevel?(level: number): void;
  setInputGain?(gain: number): void;
  setGateThreshold?(threshold: number): void;
  setNoiseSuppressionEnabled?(enabled: boolean): void | Promise<void>;
};

/**
 * Creates the composite mic processor. Injectable so tests can avoid pulling
 * in the real WASM/model pipeline.
 */
export type MicProcessorFactory = (options: MicProcessorOptions) => AudioTrackProcessor;

/**
 * The one same-origin path for the DeepFilterNet3 WASM/model assets. Fixed
 * (a constant, never configuration) so there is no URL parsing to get wrong:
 * a configurable value checked with `startsWith('/')` would still admit
 * protocol-relative (`//host`), backslash (`/\host`), and query/fragment
 * variants that resolve cross-origin or to a different fetch target than the
 * browser requests. The build script (`scripts/fetch-noise-models.mjs`)
 * writes the checksum-pinned files to the matching `static/` path on every
 * build, so the assets are always present here. The fork-owned loader
 * (`DfnWorkletCore`) only ever fetches from this path, so users' browsers
 * never touch third-party hosts.
 */
export const NOISE_SUPPRESSION_ASSETS_PATH = '/models/deepfilternet3';

const defaultMicProcessorFactory: MicProcessorFactory = (options) => new MicProcessor(options);

function supportsVoiceIsolationConstraint(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return false;
  const supported = navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>;
  return supported.voiceIsolation === true;
}

/**
 * Whether this browser implements the experimental `voiceIsolation` capture
 * constraint (effectively Safari today). Exposed so the preferences UI can
 * flag the voice-isolation mode as unavailable up front, before any call
 * exists to apply it — the standalone settings controller has no room, so it
 * never reaches the in-call unavailability path.
 */
export function isVoiceIsolationSupported(): boolean {
  return supportsVoiceIsolationConstraint();
}

/**
 * Whether the reported capture settings already satisfy the requested
 * baseline. Voice isolation compares strictly (`undefined` reads as "not
 * isolated", which is correct for the unsupported-browser case). Browser
 * noise suppression is only verified where the browser reports the setting
 * as a boolean: absence is not evidence the constraint was ignored, and
 * treating it as failure would flag healthy baselines `unavailable` on
 * engines that do not surface it (e.g. WebKit-based views).
 */
function baselineApplied(
  settings: Record<string, unknown>,
  want: { noiseSuppression: boolean; voiceIsolation: boolean }
): boolean {
  if ((settings.voiceIsolation === true) !== want.voiceIsolation) return false;
  const ns = settings.noiseSuppression;
  return typeof ns !== 'boolean' || ns === want.noiseSuppression;
}

function getLocalMicrophoneTrack(room: Room): LocalAudioTrack | null {
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track;
  if (!track || track.kind !== Track.Kind.Audio) return null;
  return track as LocalAudioTrack;
}

/**
 * Owns the noise-suppression preference (mode, strength, input gain, gate
 * sensitivity) and applies it to the active call's microphone track. One
 * instance per `VoiceCallState`.
 *
 * LiveKit already restarts an attached processor on microphone device
 * switches and destroys it when the local track stops, so this controller
 * only handles explicit preference changes and call join/leave.
 */
export class NoiseSuppressionController {
  /**
   * Persisted client-wide preference; survives across calls and reloads and
   * is shared reactively by all controllers (one exists per server store).
   */
  get mode(): NoiseSuppressionMode {
    return preference.mode;
  }

  /** DeepFilterNet3 attenuation limit (dB, 0..100), shared client-wide. */
  get strength(): number {
    return preference.strength;
  }

  /** Input gain percentage (100 = unity), shared client-wide. */
  get inputGain(): number {
    return preference.inputGain;
  }

  /** Noise-gate sensitivity threshold (0..100; 0 = off), shared client-wide. */
  get sensitivity(): number {
    return preference.sensitivity;
  }

  /** Lifecycle of the selected mode within the current call. */
  status = $state<NoiseSuppressionStatus>('off');

  /** Notifies the owner that the effective outbound track changed. */
  private readonly onProcessedTrackChanged: () => void;
  private readonly createProcessor: MicProcessorFactory;
  private readonly isSupported: () => boolean;

  private room: Room | null = null;
  private processor: AudioTrackProcessor | null = null;
  /**
   * Serializes every apply: LiveKit's setProcessor/stopProcessor each take
   * the track mutex separately, so concurrent applies from this controller
   * could interleave check-then-stop with a queued attach.
   */
  private applyChain: Promise<void> = Promise.resolve();
  /** Bumped when the call ends so queued applies become no-ops. */
  private generation = 0;

  constructor(
    onProcessedTrackChanged: () => void,
    createProcessor: MicProcessorFactory = defaultMicProcessorFactory,
    isSupported: () => boolean = () => MicProcessor.isSupported()
  ) {
    this.onProcessedTrackChanged = onProcessedTrackChanged;
    this.createProcessor = createProcessor;
    this.isSupported = isSupported;
  }

  /**
   * Extra microphone capture constraints for room construction.
   *
   * livekit-client's own `audioDefaults` request `voiceIsolation: true` and
   * are merged into every Room, so the constraint must be stated explicitly
   * for every mode — returning `{}` for `off` would silently inherit
   * LiveKit's voice isolation, and the user-selected mode is the single
   * source of truth for it.
   *
   * Browser noise suppression is disabled while the DeepFilterNet3 stage is
   * selected: two suppressors stacked degrade good input (the browser stage
   * spectrally distorts the signal, and the model was trained on unprocessed
   * noisy speech), so `enhanced` captures with the browser suppressor off.
   * Echo cancellation and auto gain stay on in every mode.
   */
  captureConstraints(): {
    voiceIsolation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  } {
    return {
      voiceIsolation: this.mode === 'voice-isolation',
      noiseSuppression: this.mode !== 'enhanced',
      autoGainControl: true
    };
  }

  /**
   * The full baseline constraint set for every `restartTrack` issued by this
   * controller. `restartTrack` replaces the stored constraints wholesale, so
   * every restart must restate AGC/echo plus the mode-derived suppression
   * pair from `captureConstraints`.
   */
  private baselineConstraints(
    voiceIsolation: boolean,
    track?: LocalAudioTrack
  ): {
    autoGainControl: boolean;
    echoCancellation: boolean;
    noiseSuppression: boolean;
    voiceIsolation: boolean;
    deviceId?: ConstrainDOMString;
  } {
    // `restartTrack` replaces the stored constraints wholesale; without the
    // current deviceId a restart would silently fall back to the default
    // microphone for users on an explicitly selected device. Known narrow
    // race (accepted): a user device switch issued while this restart is in
    // flight can be reverted to the pre-switch device, because both writers
    // replace LiveKit's stored constraints; the user's next device selection
    // corrects it.
    const deviceId = track ? (track.constraints as MediaTrackConstraints).deviceId : undefined;
    return {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: this.mode !== 'enhanced',
      voiceIsolation,
      ...(deviceId !== undefined ? { deviceId } : {})
    };
  }

  /** Called by `VoiceCallState` once the microphone is live in a call. */
  async applyToCall(room: Room): Promise<void> {
    this.room = room;
    activeControllers.add(this);
    await this.apply();
  }

  /** Called by `VoiceCallState.cleanup()`; the preference itself persists. */
  handleCallEnded(): void {
    activeControllers.delete(this);
    this.generation += 1;
    this.room = null;
    this.processor = null;
    this.status = 'off';
  }

  /**
   * Persist a new mode and apply it to every controller with an active call
   * (the preference is client-wide, so other servers' calls must reconcile,
   * not merely display the new mode). Re-selecting the current mode
   * re-applies it, which doubles as a manual retry after a failure.
   */
  async setMode(mode: NoiseSuppressionMode): Promise<void> {
    preference.mode = mode;
    modeSlot.set(mode);
    const targets = this.fanoutTargets();
    await Promise.all(targets.map((c) => c.apply()));
    // User-initiated change that ended in a fallback deserves feedback; the
    // silent path is reserved for automatic apply on join/unmute.
    if (this.status === 'unavailable' && this.mode === mode) {
      toast.error(m['voice.noise_suppression_unavailable']());
    }
  }

  /**
   * Persist a new strength and apply it live to every controller with an
   * attached processor (no rebuild — the worklet retunes in place).
   */
  async setStrength(value: number): Promise<void> {
    const next = clampStrength(value);
    preference.strength = next;
    strengthSlot.set(next);
    for (const c of this.fanoutTargets()) c.processor?.setSuppressionLevel?.(next);
  }

  /**
   * Persist a new input gain and apply it. Live-updates an attached processor
   * without a rebuild; attaches or detaches the processor if the change flips
   * whether any processing is needed (e.g. gain leaving/returning to unity in
   * `off` mode).
   */
  async setInputGain(value: number): Promise<void> {
    preference.inputGain = clampInputGain(value);
    inputGainSlot.set(preference.inputGain);
    await this.reconcileCaptureKnobs((p) => p.setInputGain?.(preference.inputGain / 100));
  }

  /**
   * Persist a new gate sensitivity and apply it, with the same attach/detach
   * reconciliation as `setInputGain`.
   */
  async setSensitivity(value: number): Promise<void> {
    preference.sensitivity = clampSensitivity(value);
    sensitivitySlot.set(preference.sensitivity);
    await this.reconcileCaptureKnobs((p) => p.setGateThreshold?.(preference.sensitivity / 100));
  }

  /**
   * Whether the composite processor must be attached: `enhanced` always needs
   * it; `off` needs it only when a capture knob is non-default;
   * `voice-isolation` never uses it (it restarts the raw capture track).
   */
  private needsProcessor(): boolean {
    if (this.mode === 'voice-isolation') return false;
    return (
      this.mode === 'enhanced' ||
      this.inputGain !== DEFAULT_INPUT_GAIN ||
      this.sensitivity > DEFAULT_SENSITIVITY
    );
  }

  private fanoutTargets(): NoiseSuppressionController[] {
    // Dedup `this` when it is already an active controller (the common case);
    // otherwise include it so a standalone settings controller still persists
    // and reconciles even before joining a call.
    return activeControllers.has(this) ? [...activeControllers] : [this, ...activeControllers];
  }

  /** Live-update an attached processor, and attach/detach on a needs flip. */
  private async reconcileCaptureKnobs(update: (p: AudioTrackProcessor) => void): Promise<void> {
    const reconciles: Promise<void>[] = [];
    for (const c of this.fanoutTargets()) {
      if (c.processor) {
        update(c.processor);
        // A knob returning to default in `off` mode means the processor is no
        // longer needed; re-apply to detach it.
        if (!c.needsProcessor()) reconciles.push(c.apply());
      } else if (c.needsProcessor()) {
        reconciles.push(c.apply());
      }
    }
    await Promise.all(reconciles);
  }

  /**
   * Queue an apply of the current preference onto this controller's chain.
   * Each queued apply re-reads the latest mode when it runs, so a rapid
   * off→enhanced→off sequence settles on the final mode without attaching
   * and detaching intermediates.
   */
  private apply(): Promise<void> {
    const run = this.applyChain.then(() => this.doApply());
    // Failures surface through `status`; keep the chain itself unbroken.
    this.applyChain = run.catch(() => {});
    return run;
  }

  private async doApply(): Promise<void> {
    const generation = this.generation;
    const room = this.room;
    if (!room) {
      this.status = 'off';
      return;
    }

    // Voice isolation is capture-level and cannot coexist with the composite
    // processor (it restarts the raw track), so it is handled standalone.
    if (this.mode === 'voice-isolation') {
      const detached = await this.detachProcessor(room);
      if (!supportsVoiceIsolationConstraint()) {
        if (generation !== this.generation) return;
        this.status = 'unavailable';
        return;
      }
      const applied = await this.applyCaptureBaseline(room, true);
      if (generation !== this.generation) return;
      this.status = detached && applied ? 'active' : 'unavailable';
      return;
    }

    // off / enhanced: never browser-isolated; may run the composite processor.
    // For enhanced this also turns the browser's own noise suppression off so
    // the DeepFilterNet3 stage receives an unsuppressed capture.
    const disabled = await this.applyCaptureBaseline(room, false);
    if (generation !== this.generation) return;

    const wantDfn = this.mode === 'enhanced';
    if (!this.needsProcessor()) {
      const detached = await this.detachProcessor(room);
      if (generation !== this.generation) return;
      this.status = detached && disabled ? 'off' : 'unavailable';
      return;
    }

    // Enhanced must not stack on browser voice isolation or browser noise
    // suppression; a processor in `off` mode likewise wants a verified clean
    // baseline. If the baseline is not confirmed, do not claim active — and
    // never leave a live DFN3 stage behind a non-active status: it would keep
    // processing while the UI claims baseline audio, and a later overload
    // verdict would be latched away while the stage still runs.
    if (!disabled) {
      try {
        await this.processor?.setNoiseSuppressionEnabled?.(false);
      } catch {
        // Stage state unknown; unavailable remains the honest status.
      }
      if (generation !== this.generation) return;
      this.status = 'unavailable';
      return;
    }

    const ok = await this.syncProcessor(room, generation, wantDfn);
    if (generation !== this.generation) return;
    // Status reflects the selected suppression mode; the gate/gain are
    // orthogonal capture knobs and do not make `off` read as active.
    this.status = ok ? (wantDfn ? 'active' : 'off') : 'unavailable';
  }

  /**
   * Applies the mode-derived capture baseline (voice isolation plus browser
   * noise suppression) to the microphone track, restarting it only when the
   * reported settings differ. Returns whether the browser reports the
   * requested state applied — for enable AND disable, since a browser may
   * accept a constraint without honoring it either way.
   *
   * Uses LiveKit's `restartTrack` with the FULL baseline constraint set (not
   * a bare `applyConstraints`). `restartTrack` updates LiveKit's stored
   * `_constraints`, which is what a later device switch / processor stop
   * restarts from — a bare `applyConstraints` would leave the stored copy
   * stale and silently revert this setting on the next track replacement.
   * Passing the baseline constraints keeps AGC/echo intact, which
   * `restartTrack` would otherwise drop.
   *
   * Usually called with no processor attached (off/voice-isolation detach
   * first; enhanced applies the baseline before attaching). The one exception
   * is a capture-knob processor already attached in `off` mode when the mode
   * flips to `enhanced`: LiveKit's `setMediaStreamTrack` then restarts the
   * attached processor with the new capture track and keeps the sender on the
   * processed track, so restarting under it is safe.
   */
  private async applyCaptureBaseline(room: Room, enableIsolation: boolean): Promise<boolean> {
    const isolate = enableIsolation && supportsVoiceIsolationConstraint();
    const track = getLocalMicrophoneTrack(room);
    if (!track) return false;

    const want = this.baselineConstraints(isolate, track);
    const settings = track.getSourceTrackSettings() as Record<string, unknown>;
    // Restart only when needed: the stored request must already state the
    // desired browser-suppression value (LiveKit restarts tracks from its
    // stored constraints, and engines that do not report the setting would
    // otherwise never get the restart), and the reported settings must not
    // contradict the baseline.
    const requested = track.constraints as Record<string, unknown>;
    const nsRequested = requested.noiseSuppression === want.noiseSuppression;
    if (nsRequested && baselineApplied(settings, want)) return true;
    // If we cannot request voice isolation at all, we can only honor a disable
    // request; treat an impossible enable as not-applied.
    if (enableIsolation && !supportsVoiceIsolationConstraint()) return false;

    try {
      await track.restartTrack(want);
    } catch {
      return false;
    }
    // The track object is preserved across restartTrack; reconnect the
    // speaking-indicator analyser to the restarted capture track.
    this.onProcessedTrackChanged();
    const applied = track.getSourceTrackSettings() as Record<string, unknown>;
    return baselineApplied(applied, want);
  }

  /**
   * Ensure the composite processor is attached and configured for the current
   * preference, reconfiguring in place if already attached. Returns whether
   * the outbound track is known healthy afterward.
   */
  private async syncProcessor(room: Room, generation: number, wantDfn: boolean): Promise<boolean> {
    if (this.processor) {
      this.processor.setInputGain?.(this.inputGain / 100);
      this.processor.setGateThreshold?.(this.sensitivity / 100);
      this.processor.setSuppressionLevel?.(this.strength);
      try {
        await this.processor.setNoiseSuppressionEnabled?.(wantDfn);
      } catch {
        return false;
      }
      return true;
    }
    return this.attachProcessor(room, generation, wantDfn);
  }

  private async attachProcessor(
    room: Room,
    generation: number,
    wantDfn: boolean
  ): Promise<boolean> {
    // Loading is only user-visible (and only slow) for the DeepFilterNet3
    // stage; a gate/gain-only attach is instant.
    if (wantDfn) this.status = 'loading';
    try {
      if (!this.isSupported()) return false;

      const track = getLocalMicrophoneTrack(room);
      if (!track) return false;

      const processor = this.createProcessor({
        inputGain: this.inputGain / 100,
        gateThreshold: this.sensitivity / 100,
        noiseSuppressionEnabled: wantDfn,
        suppressionLevel: this.strength,
        assetPath: NOISE_SUPPRESSION_ASSETS_PATH,
        onSuppressionOverload: () => this.handleSuppressionOverload()
      });
      try {
        await track.setProcessor(processor);
      } catch (err) {
        // LiveKit assigns its processor reference before awaiting sender
        // track replacement, so a rejected setProcessor may still have been
        // adopted. Unwind through stopProcessor in that case (it restores
        // the original track and destroys the processor); otherwise destroy
        // the orphan directly.
        if (track.getProcessor() === processor) {
          await track.stopProcessor().catch(() => {});
        } else {
          await Promise.resolve(processor.destroy()).catch(() => {});
        }
        throw err;
      }
      if (generation !== this.generation) {
        // The call ended while attaching. LiveKit destroys processors when
        // the local track stops; only stop explicitly if the track still
        // holds ours.
        if (track.getProcessor() === processor) {
          await track.stopProcessor().catch(() => {});
        }
        return false;
      }
      this.processor = processor;
      this.onProcessedTrackChanged();
      return true;
    } catch {
      if (generation !== this.generation) return false;
      this.processor = null;
      return false;
    }
  }

  /**
   * The device sustained realtime underruns while the DeepFilterNet3 stage
   * was active (see `MicProcessor`'s overload watchdog): keep the call and
   * the gate/gain stages, but turn the suppression stage off in place and
   * say why. The persisted preference stays `enhanced`, so re-selecting the
   * mode — or the next call — retries with a fresh watchdog.
   */
  private handleSuppressionOverload(): void {
    const processor = this.processor;
    // Deliberately no status guard: an overload verdict only fires while the
    // stage was enabled, and gating on `active` could swallow the one-shot
    // verdict if a transient status change raced it — leaving the stage
    // running with a disarmed watchdog.
    if (!processor || this.mode !== 'enhanced') return;
    void Promise.resolve(processor.setNoiseSuppressionEnabled?.(false)).catch(() => {});
    if (this.status !== 'unavailable') {
      this.status = 'unavailable';
      toast.error(m['voice.noise_suppression_overloaded']());
    }
  }

  /**
   * Stops the composite processor. Returns whether the outbound track is known
   * to be healthy afterward.
   *
   * `stopProcessor` stops the processed track before awaiting operations that
   * can reject (destroy, constraint re-apply, sender re-set), so a rejection
   * can leave the sender pointing at a stopped track. In that case we attempt
   * to restart the raw capture track — which re-acquires live audio and
   * re-sets it on the sender — and only report success if that recovery
   * itself succeeds. Failing that, the caller surfaces `unavailable` so the
   * UI does not claim a clean baseline over dead audio.
   */
  private async detachProcessor(room: Room): Promise<boolean> {
    if (!this.processor) return true;
    this.processor = null;
    const track = getLocalMicrophoneTrack(room);
    if (!track) return false;
    try {
      await track.stopProcessor();
      this.onProcessedTrackChanged();
      return true;
    } catch {
      // Recover the raw sender before advancing status. Uses the mode-derived
      // baseline: detach happens when leaving `enhanced`, so this restores
      // browser noise suppression along with the rest of the baseline.
      let recovered = false;
      try {
        await track.restartTrack(this.baselineConstraints(false, track));
        recovered = true;
      } catch {
        recovered = false;
      }
      this.onProcessedTrackChanged();
      return recovered;
    }
  }
}
