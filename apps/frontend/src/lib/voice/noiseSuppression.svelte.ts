/**
 * Fork-owned enhanced noise suppression for the local microphone.
 *
 * Chatto's baseline is the browser's WebRTC processing (AGC, echo
 * cancellation, noise suppression), requested in `VoiceCallState`'s
 * `audioCaptureDefaults`. Note that livekit-client's own audio defaults also
 * request `voiceIsolation: true`; when this feature is enabled the
 * controller overrides that explicitly per mode. This module adds two
 * optional, experimental modes on top of that baseline:
 *
 * - `voice-isolation`: requests the experimental `voiceIsolation` media
 *   constraint (a stronger, browser-implemented suppression tier; ignored by
 *   browsers that do not support it).
 * - `enhanced`: attaches the DeepFilterNet3 LiveKit `TrackProcessor`
 *   (`deepfilternet3-noise-filter`) to the outbound microphone track. Model
 *   and WASM assets are lazy-loaded only when this mode is enabled.
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
 * The client-wide preference, shared by every controller instance. Server
 * stores are created eagerly (one `VoiceCallState` per registered server),
 * so a per-instance snapshot would go stale on other servers whenever the
 * mode changes on one of them.
 */
const preference = $state<{ mode: NoiseSuppressionMode }>({ mode: modeSlot.get() });

/**
 * Controllers currently attached to an active call (registered in
 * `applyToCall`, removed in `handleCallEnded`), so a mode change made on one
 * server's UI is applied to any other server's live call, not just displayed
 * by it.
 */
const activeControllers = new SvelteSet<NoiseSuppressionController>();

/**
 * DeepFilterNet3 suppression strength, shared with the benchmark harness
 * (`.context/noise-suppression-bench/bench.js` hardcodes the same value —
 * keep them in sync). 80 is the package's own processor default; the core
 * class defaults to 50, so always pass this explicitly.
 */
export const NOISE_REDUCTION_LEVEL = 80;

/** Audio track processor plus the lifecycle bits this controller relies on. */
type AudioTrackProcessor = TrackProcessor<Track.Kind.Audio>;

/**
 * Loads the enhanced processor implementation. Injectable so tests can avoid
 * pulling in the real WASM/model pipeline.
 */
export type EnhancedProcessorFactory = () => Promise<{
  isSupported(): boolean;
  create(): AudioTrackProcessor;
}>;

/**
 * The one accepted same-origin path for the DeepFilterNet3 WASM/model assets.
 * Fixed rather than free-form (`VITE_NOISE_SUPPRESSION_ASSETS_URL` must equal
 * this exact value) so there is no URL parsing to get wrong: `startsWith('/')`
 * would still admit protocol-relative (`//host`), backslash (`/\host`), and
 * query/fragment variants that resolve cross-origin or to a different fetch
 * target than the browser requests. The build script writes the checksum-
 * pinned files to the matching `static/` path.
 */
export const NOISE_SUPPRESSION_ASSETS_PATH = '/models/deepfilternet3';

/**
 * Whether the configured assets URL is the exact accepted same-origin path.
 * Anything else (including the package's vendor CDN fallback) is refused: the
 * enhanced mode reports `unavailable` rather than loading models from an
 * unexpected origin.
 */
function noiseSuppressionAssetsConfigured(): boolean {
  return import.meta.env.VITE_NOISE_SUPPRESSION_ASSETS_URL === NOISE_SUPPRESSION_ASSETS_PATH;
}

const defaultEnhancedProcessorFactory: EnhancedProcessorFactory = async () => {
  if (!noiseSuppressionAssetsConfigured()) {
    throw new Error(
      `noise suppression assets must be served same-origin from ` +
        `${NOISE_SUPPRESSION_ASSETS_PATH}; refusing unconfigured or non-matching assets URL`
    );
  }
  const { DeepFilterNoiseFilterProcessor } = await import('deepfilternet3-noise-filter');
  return {
    isSupported: () => DeepFilterNoiseFilterProcessor.isSupported(),
    create: () =>
      new DeepFilterNoiseFilterProcessor({
        noiseReductionLevel: NOISE_REDUCTION_LEVEL,
        assetConfig: { cdnUrl: NOISE_SUPPRESSION_ASSETS_PATH }
      }) as unknown as AudioTrackProcessor
  };
};

/**
 * Build-time feature flag for the whole noise suppression prototype.
 *
 * Set `VITE_ENABLE_NOISE_SUPPRESSION=true` when building (or in an `.env`
 * file for `vite dev`) to expose the preference UI and allow the controller
 * to act. Off by default: without the flag the menu section is hidden and
 * the controller stays inert even if a mode was persisted earlier.
 *
 * Read lazily (not as a module constant) so tests can stub the env var.
 */
export function isNoiseSuppressionFeatureEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_NOISE_SUPPRESSION === 'true';
}

function supportsVoiceIsolationConstraint(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return false;
  const supported = navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>;
  return supported.voiceIsolation === true;
}

function getLocalMicrophoneTrack(room: Room): LocalAudioTrack | null {
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track;
  if (!track || track.kind !== Track.Kind.Audio) return null;
  return track as LocalAudioTrack;
}

/**
 * Owns the enhanced-noise-suppression preference and applies it to the
 * active call's microphone track. One instance per `VoiceCallState`.
 *
 * LiveKit already restarts an attached processor on microphone device
 * switches and destroys it when the local track stops, so this controller
 * only handles explicit mode changes and call join/leave.
 */
export class NoiseSuppressionController {
  /**
   * Persisted client-wide preference; survives across calls and reloads and
   * is shared reactively by all controllers (one exists per server store).
   */
  get mode(): NoiseSuppressionMode {
    return preference.mode;
  }

  /** Lifecycle of the selected mode within the current call. */
  status = $state<NoiseSuppressionStatus>('off');

  /** Notifies the owner that the effective outbound track changed. */
  private readonly onProcessedTrackChanged: () => void;
  private readonly loadEnhancedProcessor: EnhancedProcessorFactory;

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
    loadEnhancedProcessor: EnhancedProcessorFactory = defaultEnhancedProcessorFactory
  ) {
    this.onProcessedTrackChanged = onProcessedTrackChanged;
    this.loadEnhancedProcessor = loadEnhancedProcessor;
  }

  /**
   * Extra microphone capture constraints for room construction.
   *
   * livekit-client's own `audioDefaults` request `voiceIsolation: true` and
   * are merged into every Room, so the flag-enabled build must state the
   * constraint explicitly for every mode — returning `{}` for `off` would
   * silently inherit LiveKit's voice isolation. With the feature flag off we
   * deliberately return `{}` so capture behavior stays byte-identical to
   * upstream Chatto (which inherits the LiveKit default).
   */
  captureConstraints(): { voiceIsolation?: boolean } {
    if (!isNoiseSuppressionFeatureEnabled()) return {};
    return { voiceIsolation: this.mode === 'voice-isolation' };
  }

  /** Called by `VoiceCallState` once the microphone is live in a call. */
  async applyToCall(room: Room): Promise<void> {
    if (!isNoiseSuppressionFeatureEnabled()) return;
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
    if (!isNoiseSuppressionFeatureEnabled()) return;
    preference.mode = mode;
    modeSlot.set(mode);
    const targets = activeControllers.has(this)
      ? [...activeControllers]
      : [this, ...activeControllers];
    await Promise.all(targets.map((c) => c.apply()));
    // User-initiated change that ended in a fallback deserves feedback; the
    // silent path is reserved for automatic apply on join/unmute.
    if (this.status === 'unavailable' && this.mode === mode) {
      toast.error(m['voice.noise_suppression_unavailable']());
    }
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

    switch (this.mode) {
      case 'off': {
        const detached = await this.detachProcessor(room);
        const disabled = await this.setVoiceIsolation(room, false);
        if (generation !== this.generation) return;
        // If the browser ignored the disable, isolation is still active
        // underneath the reported "off", or the enhanced processor could not
        // be removed. Report unavailable rather than a false clean baseline.
        this.status = detached && disabled ? 'off' : 'unavailable';
        break;
      }
      case 'voice-isolation': {
        const detached = await this.detachProcessor(room);
        if (!supportsVoiceIsolationConstraint()) {
          if (generation !== this.generation) return;
          this.status = 'unavailable';
          return;
        }
        const applied = await this.setVoiceIsolation(room, true);
        if (generation !== this.generation) return;
        this.status = detached && applied ? 'active' : 'unavailable';
        break;
      }
      case 'enhanced': {
        // Enhanced must not stack on top of browser voice isolation. If the
        // disable is not verified, do not claim active.
        const disabled = await this.setVoiceIsolation(room, false);
        if (!disabled) {
          if (generation !== this.generation) return;
          this.status = 'unavailable';
          return;
        }
        await this.attachProcessor(room, generation);
        break;
      }
    }
  }

  /**
   * Requests or clears the experimental `voiceIsolation` constraint on the
   * microphone track, disabling it when unsupported. Returns whether the
   * browser reports the requested state applied — for enable AND disable,
   * since a browser may accept the constraint without honoring it either way.
   *
   * Uses LiveKit's `restartTrack` with the FULL baseline constraint set (not
   * a bare `applyConstraints`). `restartTrack` updates LiveKit's stored
   * `_constraints`, which is what a later device switch / processor stop
   * restarts from — a bare `applyConstraints` would leave the stored copy
   * stale and silently revert this setting on the next track replacement.
   * Passing the baseline constraints keeps AGC/echo/noise intact, which
   * `restartTrack` would otherwise drop.
   *
   * Only ever called with no processor attached (off/voice-isolation detach
   * first; enhanced disables before attaching), so restarting the raw capture
   * track is safe here.
   */
  private async setVoiceIsolation(room: Room, enable: boolean): Promise<boolean> {
    const enabled = enable && supportsVoiceIsolationConstraint();
    const track = getLocalMicrophoneTrack(room);
    if (!track) return false;

    const settings = track.getSourceTrackSettings() as Record<string, unknown>;
    if ((settings.voiceIsolation === true) === enabled) return true;
    // If we cannot request voice isolation at all, we can only honor a disable
    // request; treat an impossible enable as not-applied.
    if (enable && !supportsVoiceIsolationConstraint()) return false;

    try {
      await track.restartTrack({
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        voiceIsolation: enabled
      });
    } catch {
      return false;
    }
    // The track object is preserved across restartTrack; reconnect the
    // speaking-indicator analyser to the restarted capture track.
    this.onProcessedTrackChanged();
    const applied = track.getSourceTrackSettings() as Record<string, unknown>;
    return (applied.voiceIsolation === true) === enabled;
  }

  private async attachProcessor(room: Room, generation: number): Promise<void> {
    if (this.processor) {
      this.status = 'active';
      return;
    }

    this.status = 'loading';
    try {
      const impl = await this.loadEnhancedProcessor();
      if (!impl.isSupported()) {
        if (generation !== this.generation) return;
        this.status = 'unavailable';
        return;
      }

      const track = getLocalMicrophoneTrack(room);
      if (!track) {
        if (generation !== this.generation) return;
        this.status = 'unavailable';
        return;
      }

      const processor = impl.create();
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
        return;
      }
      this.processor = processor;
      this.status = 'active';
      this.onProcessedTrackChanged();
    } catch {
      if (generation !== this.generation) return;
      this.processor = null;
      this.status = 'unavailable';
    }
  }

  /**
   * Stops the enhanced processor. Returns whether the outbound track is known
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
      // Recover the raw sender before advancing status.
      let recovered = false;
      try {
        await track.restartTrack({
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true
        });
        recovered = true;
      } catch {
        recovered = false;
      }
      this.onProcessedTrackChanged();
      return recovered;
    }
  }
}
