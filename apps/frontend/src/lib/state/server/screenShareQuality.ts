/**
 * Screen-share quality preferences and their mapping onto livekit-client options.
 *
 * Pure module — no Svelte, no LiveKit imports, no storage. `resolveScreenShareOptions`
 * is the single place that turns a user's Resolution/Frame Rate choice into the
 * `ScreenShareCaptureOptions` + `TrackPublishDefaults` pair handed to
 * `LocalParticipant.setScreenShareEnabled`, so the mapping stays testable and the
 * choice of encoder knobs is documented in exactly one file.
 *
 * ## Why these knobs
 *
 * - `screenShareEncoding` (NOT `videoEncoding`): LiveKit's `computeVideoEncodings()`
 *   discards `videoEncoding` for screen-share tracks. Passing the wrong key silently
 *   falls back to `ScreenSharePresets.h1080fps15` — 15fps.
 * - `contentHint: 'motion'`: tells the encoder this is moving imagery (a game), not
 *   static text, so it spends bits on temporal smoothness rather than per-frame sharpness.
 * - `degradationPreference: 'maintain-framerate'`: under CPU or bandwidth pressure, drop
 *   resolution before dropping frames. A soft-but-smooth game stream is watchable; a
 *   sharp 8fps one is not. This is the browser's equivalent of Discord's
 *   resolution-vs-framerate tradeoff.
 * - `simulcast: false`: simulcast encodes the stream two or three times in parallel, once
 *   per layer. That multiplies encoder CPU for a screen share that is almost always viewed
 *   at one size. Discord publishes a single screen-share stream too. The cost: viewers on
 *   weak links cannot drop to a smaller layer, so they buffer instead of downshifting.
 *
 * ## Bitrate is derived, not chosen
 *
 * Discord gates quality on *bitrate* (free ~1.5 Mbps, Nitro 8 Mbps) while only exposing
 * resolution and frame rate — which is why picking 1080p60 on Discord's free tier yields a
 * starved, blocky stream. We instead derive the bitrate each resolution/frame-rate pair
 * actually needs, from Discord's own published ladder, and show it in the picker:
 *
 *   720p30 -> 2.5 Mbps | 720p60 -> 4 Mbps | 1080p30 -> 5 Mbps | 1080p60 -> 8 Mbps
 *
 * 60fps costs ~1.6x the bitrate of 30fps at a fixed resolution; those four points imply the
 * `FRAMERATE_BITRATE_FACTOR` table below.
 */

/** Resolution tiers offered in the picker. Discord's ladder, minus "Source" (see below). */
export type ScreenShareResolution = '480p' | '720p' | '1080p' | '1440p' | '2160p';

/** Frame-rate tiers offered in the picker. Matches Discord's 15 / 30 / 60. */
export type ScreenShareFramerate = 15 | 30 | 60;

/**
 * A user's screen-share quality choice. Persisted per server.
 *
 * Deliberately omits bitrate: it is derived from `resolution` x `framerate` (see module
 * docs) so the user cannot select a resolution the bitrate cannot sustain.
 *
 * Note on "Source": Discord offers a Source option that streams the display's native
 * resolution. Discord's desktop app enumerates and captures displays itself, so it knows
 * the native mode. A browser does not: `getDisplayMedia()` returns whatever the picker
 * hands over, and omitting a resolution constraint makes livekit-client apply its own
 * 1080p default rather than "native". We therefore do not offer a Source tier we could not
 * honour; the highest tier the server's ceiling permits is the effective maximum.
 */
export type ScreenShareQualityPrefs = {
  resolution: ScreenShareResolution;
  framerate: ScreenShareFramerate;
  /** Capture the shared window/tab's audio alongside video (game sound). Browser support varies. */
  shareAudio: boolean;
};

/**
 * Server-configured upper bound on screen-share quality, from `ServerRuntimeConfig`.
 *
 * An advisory ceiling: it clamps what this client offers and publishes, but nothing
 * enforces it server-side (the LiveKit join token grants only `RoomJoin`, and Chatto sets
 * no `RoomConfiguration`). A modified client could exceed it.
 */
export type ScreenShareCeiling = {
  maxWidth: number;
  maxHeight: number;
  maxFramerate: number;
  maxBitrate: number;
};

/** Pixel dimensions per resolution tier. */
const RESOLUTION_DIMENSIONS: Record<ScreenShareResolution, { width: number; height: number }> = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 }
};

/**
 * Bitrate each tier needs at 30fps, in bits/sec. The 720p and 1080p rows are Discord's
 * published figures; 480p, 1440p, and 2160p extend the same curve by pixel count.
 *
 * Whether a tier is *offered* depends on the server ceiling, not this table:
 * `availableResolutions()` hides tiers the ceiling cannot fit. 2160p therefore stays hidden
 * under the default 1440p ceiling and appears only if a self-hoster raises it.
 */
const RESOLUTION_BITRATE_AT_30FPS: Record<ScreenShareResolution, number> = {
  '480p': 1_000_000,
  '720p': 2_500_000,
  '1080p': 5_000_000,
  '1440p': 9_000_000,
  '2160p': 20_000_000
};

/**
 * Bitrate multiplier per frame rate, relative to 30fps. Calibrated against Discord's ladder:
 * 720p 2.5 -> 4 Mbps and 1080p 5 -> 8 Mbps going 30 -> 60fps, i.e. 1.6x in both cases.
 */
const FRAMERATE_BITRATE_FACTOR: Record<ScreenShareFramerate, number> = {
  15: 0.6,
  30: 1,
  60: 1.6
};

export const RESOLUTION_ORDER: readonly ScreenShareResolution[] = [
  '480p',
  '720p',
  '1080p',
  '1440p',
  '2160p'
];

export const FRAMERATE_ORDER: readonly ScreenShareFramerate[] = [15, 30, 60];

/**
 * Default choice: 1080p60.
 *
 * This is Discord's *Nitro* tier, not their 720p30 default. Discord defaults to 720p30
 * because their free tier caps bitrate at ~1.5 Mbps — a paywall, not an engineering
 * conclusion. Chatto is self-hosted with no such tier, so the honest default is the
 * quality a self-hoster's own uplink can carry. Users whose upload cannot sustain 8 Mbps
 * can drop a tier; the picker shows the requirement.
 *
 * Note this *increases* CPU relative to a 15fps share: 1080p60 is ~4x the pixels/sec of
 * 1080p15. The gain is smoothness, not efficiency.
 */
export const DEFAULT_SCREEN_SHARE_QUALITY: ScreenShareQualityPrefs = {
  resolution: '1080p',
  framerate: 60,
  shareAudio: false
};

/** Bits/sec needed for a resolution/frame-rate pair, before the server ceiling is applied. */
export function requiredBitrate(
  resolution: ScreenShareResolution,
  framerate: ScreenShareFramerate
): number {
  return Math.round(RESOLUTION_BITRATE_AT_30FPS[resolution] * FRAMERATE_BITRATE_FACTOR[framerate]);
}

/**
 * Resolution tiers this server's ceiling permits. A tier is offered only if it fits the
 * ceiling in both dimensions, so the picker never advertises a quality it would silently
 * clamp away.
 */
export function availableResolutions(ceiling: ScreenShareCeiling): ScreenShareResolution[] {
  const fits = RESOLUTION_ORDER.filter((tier) => {
    const { width, height } = RESOLUTION_DIMENSIONS[tier];
    return width <= ceiling.maxWidth && height <= ceiling.maxHeight;
  });
  // Never present an empty picker: a ceiling below 480p still gets the lowest tier, clamped
  // down at publish time by resolveScreenShareOptions.
  return fits.length > 0 ? fits : ['480p'];
}

/** Frame-rate tiers this server's ceiling permits. */
export function availableFramerates(ceiling: ScreenShareCeiling): ScreenShareFramerate[] {
  const fits = FRAMERATE_ORDER.filter((fps) => fps <= ceiling.maxFramerate);
  return fits.length > 0 ? fits : [15];
}

/**
 * Clamp a stored/user preference to what this server's ceiling allows.
 *
 * Preferences persist across servers and a self-hoster can lower their ceiling at any
 * time, so a stored 1440p60 must degrade gracefully rather than be published as-is.
 */
export function clampQualityPrefs(
  prefs: ScreenShareQualityPrefs,
  ceiling: ScreenShareCeiling
): ScreenShareQualityPrefs {
  const resolutions = availableResolutions(ceiling);
  const framerates = availableFramerates(ceiling);
  return {
    resolution: resolutions.includes(prefs.resolution)
      ? prefs.resolution
      : resolutions[resolutions.length - 1],
    framerate: framerates.includes(prefs.framerate)
      ? prefs.framerate
      : framerates[framerates.length - 1],
    shareAudio: prefs.shareAudio
  };
}

/**
 * Capture constraints for shared audio.
 *
 * Voice DSP must be off. `getDisplayMedia({ audio: true })` leaves these to the browser,
 * and Chromium turns echo cancellation, noise suppression, and automatic gain control on by
 * default — the same speech-oriented processing that makes a microphone sound clean and makes
 * game and music audio sound like a broken radio: sustained tones get treated as noise, and
 * AGC pumps the level on every loud moment.
 *
 * `restrictOwnAudio` asks Chromium to remove audio produced by Chatto itself from a system-audio
 * capture. This prevents remote call audio from being sent back to the room when the Windows
 * desktop client pairs a selected window's picture with all system output. Older hosts ignore
 * the non-exact hint.
 *
 * The mic path deliberately keeps all three on (see `audioCaptureDefaults` in
 * ./voiceCall.svelte.ts); only shared audio opts out.
 *
 * Written as plain (non-`exact`) constraints on purpose: a host that does not understand one
 * of them ignores it instead of failing the whole capture request.
 */
export const SHARED_AUDIO_CAPTURE_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  restrictOwnAudio: true
} as const;

/** The capture + publish option pair for `setScreenShareEnabled`. */
export type ResolvedScreenShareOptions = {
  capture: {
    resolution: { width: number; height: number; frameRate: number };
    contentHint: 'motion' | 'detail';
    audio: false | typeof SHARED_AUDIO_CAPTURE_CONSTRAINTS;
    systemAudio: 'include' | 'exclude';
  };
  publish: {
    screenShareEncoding: { maxBitrate: number; maxFramerate: number };
    degradationPreference: 'maintain-framerate' | 'maintain-resolution';
    simulcast: false;
    videoCodec: 'vp9';
    scalabilityMode: 'L1T3';
  };
  /** The bitrate actually published, after the ceiling clamp — surfaced in the picker. */
  effectiveBitrate: number;
};

/**
 * Turn a quality preference plus the server ceiling into livekit-client options.
 *
 * The ceiling clamps every axis independently: a 1080p60 preference on a server capped at
 * 4 Mbps still publishes 1080p60, but at 4 Mbps — the encoder then honours
 * `degradationPreference: 'maintain-framerate'` and sheds resolution to stay smooth.
 * 15 fps shares invert that bias: `detail` content hint plus `maintain-resolution`,
 * so text stays sharp and frames drop first.
 */
export function resolveScreenShareOptions(
  prefs: ScreenShareQualityPrefs,
  ceiling: ScreenShareCeiling
): ResolvedScreenShareOptions {
  const clamped = clampQualityPrefs(prefs, ceiling);
  const { width, height } = RESOLUTION_DIMENSIONS[clamped.resolution];
  const frameRate = Math.min(clamped.framerate, ceiling.maxFramerate);
  const effectiveBitrate = Math.min(
    requiredBitrate(clamped.resolution, clamped.framerate),
    ceiling.maxBitrate
  );
  // A 15 fps share is documents/code, not gameplay: hint `detail` so the
  // encoder spends bits on sharp text instead of smooth motion, and shed
  // frames before resolution under pressure. Faster shares keep the motion
  // bias below and the maintain-framerate degradation.
  const isDetailContent = frameRate <= 15;

  return {
    capture: {
      resolution: {
        width: Math.min(width, ceiling.maxWidth),
        height: Math.min(height, ceiling.maxHeight),
        frameRate
      },
      contentHint: isDetailContent ? 'detail' : 'motion',
      audio: clamped.shareAudio ? SHARED_AUDIO_CAPTURE_CONSTRAINTS : false,
      systemAudio: clamped.shareAudio ? 'include' : 'exclude'
    },
    publish: {
      screenShareEncoding: { maxBitrate: effectiveBitrate, maxFramerate: frameRate },
      degradationPreference: isDetailContent ? 'maintain-resolution' : 'maintain-framerate',
      simulcast: false,
      // VP9 beats the VP8 default on quality per bit, which matters most for the
      // text-heavy content screen shares carry. If the LiveKit server does not
      // allow VP9, livekit-client falls back to the server-selected codec at
      // publish time and recomputes encodings.
      videoCodec: 'vp9',
      // Temporal-only scalability: without this, livekit-client defaults SVC
      // codecs to L3T3_KEY, whose extra spatial layers downscale exactly the
      // content this module works to keep sharp — and whose multi-layer
      // encodings would break the single-encoding retune in voiceCall.svelte.ts.
      scalabilityMode: 'L1T3'
    },
    effectiveBitrate
  };
}

/** Format a bits/sec value as the "~8 Mbps" string shown in the picker. */
export function formatBitrateMbps(bitsPerSecond: number): string {
  const mbps = bitsPerSecond / 1_000_000;
  // One decimal below 10 Mbps (2.5, 4.0 -> "4"), whole numbers above.
  const rounded = mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10;
  return String(rounded);
}

/** Runtime validator for the persisted JSON payload. */
export function isScreenShareQualityPrefs(value: unknown): value is ScreenShareQualityPrefs {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    RESOLUTION_ORDER.includes(candidate.resolution as ScreenShareResolution) &&
    FRAMERATE_ORDER.includes(candidate.framerate as ScreenShareFramerate) &&
    typeof candidate.shareAudio === 'boolean'
  );
}
