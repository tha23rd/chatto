import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  SHARED_AUDIO_CAPTURE_CONSTRAINTS,
  availableFramerates,
  availableResolutions,
  clampQualityPrefs,
  formatBitrateMbps,
  isScreenShareQualityPrefs,
  requiredBitrate,
  resolveScreenShareOptions,
  type ScreenShareCeiling,
  type ScreenShareQualityPrefs
} from './screenShareQuality';

/** The Go default ceiling: 1440p60 @ 15 Mbps. */
const CEILING: ScreenShareCeiling = {
  maxWidth: 2560,
  maxHeight: 1440,
  maxFramerate: 60,
  maxBitrate: 15_000_000
};

function prefs(overrides: Partial<ScreenShareQualityPrefs> = {}): ScreenShareQualityPrefs {
  return { ...DEFAULT_SCREEN_SHARE_QUALITY, ...overrides };
}

describe('requiredBitrate', () => {
  // These four points are Discord's own published ladder. If they drift, the picker starts
  // advertising bitrates that do not match what the resolution actually needs.
  it.each([
    ['720p', 30, 2_500_000],
    ['720p', 60, 4_000_000],
    ['1080p', 30, 5_000_000],
    ['1080p', 60, 8_000_000]
  ] as const)('matches Discord for %sp%d', (resolution, framerate, expected) => {
    expect(requiredBitrate(resolution, framerate)).toBe(expected);
  });

  it('scales down for 15fps', () => {
    expect(requiredBitrate('1080p', 15)).toBe(3_000_000);
  });
});

describe('resolveScreenShareOptions', () => {
  it('publishes screenShareEncoding, never videoEncoding', () => {
    const { publish } = resolveScreenShareOptions(prefs(), CEILING);

    // Regression guard: LiveKit's computeVideoEncodings() discards `videoEncoding` for
    // screen-share tracks and silently falls back to 15fps. See module docs.
    expect(publish).toHaveProperty('screenShareEncoding');
    expect(publish).not.toHaveProperty('videoEncoding');
  });

  it('maps the default 1080p60 choice onto 8 Mbps at 60fps', () => {
    const { capture, publish, effectiveBitrate } = resolveScreenShareOptions(prefs(), CEILING);

    expect(capture.resolution).toEqual({ width: 1920, height: 1080, frameRate: 60 });
    expect(publish.screenShareEncoding).toEqual({ maxBitrate: 8_000_000, maxFramerate: 60 });
    expect(effectiveBitrate).toBe(8_000_000);
  });

  it('hints motion and prefers framerate over resolution under pressure', () => {
    const { capture, publish } = resolveScreenShareOptions(prefs(), CEILING);

    expect(capture.contentHint).toBe('motion');
    expect(publish.degradationPreference).toBe('maintain-framerate');
  });

  it('hints detail and maintains resolution for 15 fps shares', () => {
    // A 15 fps share is documents/code: bits go to sharp text, and frames drop
    // before resolution when the link degrades.
    const { capture, publish } = resolveScreenShareOptions(prefs({ framerate: 15 }), CEILING);

    expect(capture.contentHint).toBe('detail');
    expect(publish.degradationPreference).toBe('maintain-resolution');
  });

  it('disables simulcast to avoid paying for parallel encodes', () => {
    expect(resolveScreenShareOptions(prefs(), CEILING).publish.simulcast).toBe(false);
  });

  it('publishes VP9 with temporal-only scalability', () => {
    const { publish } = resolveScreenShareOptions(prefs(), CEILING);

    expect(publish.videoCodec).toBe('vp9');
    // L1T3 keeps one full-resolution spatial layer: the L3T3_KEY default would
    // downscale text-heavy content and add multi-layer encodings the live
    // retune path cannot handle.
    expect(publish.scalabilityMode).toBe('L1T3');
  });

  it('clamps bitrate to a lower server ceiling while keeping the requested framerate', () => {
    const stingy: ScreenShareCeiling = { ...CEILING, maxBitrate: 4_000_000 };

    const { publish, effectiveBitrate } = resolveScreenShareOptions(prefs(), stingy);

    // Still 60fps: maintain-framerate then sheds resolution rather than frames.
    expect(publish.screenShareEncoding).toEqual({ maxBitrate: 4_000_000, maxFramerate: 60 });
    expect(effectiveBitrate).toBe(4_000_000);
  });

  it('clamps framerate to a lower server ceiling', () => {
    const capped: ScreenShareCeiling = { ...CEILING, maxFramerate: 30 };

    const { capture, publish } = resolveScreenShareOptions(prefs({ framerate: 60 }), capped);

    expect(capture.resolution.frameRate).toBe(30);
    expect(publish.screenShareEncoding.maxFramerate).toBe(30);
  });

  it('requests window audio only when sharing audio is enabled', () => {
    const off = resolveScreenShareOptions(prefs({ shareAudio: false }), CEILING);
    expect(off.capture.audio).toBe(false);
    expect(off.capture.systemAudio).toBe('exclude');

    const on = resolveScreenShareOptions(prefs({ shareAudio: true }), CEILING);
    expect(on.capture.audio).toBeTruthy();
    expect(on.capture.systemAudio).toBe('include');
  });

  it('captures shared audio with speech processing off', () => {
    const { capture } = resolveScreenShareOptions(prefs({ shareAudio: true }), CEILING);

    // Left to the browser, Chromium applies mic-grade echo cancellation, noise suppression
    // and AGC to display audio, which wrecks music and game audio.
    expect(capture.audio).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      restrictOwnAudio: true
    });
    expect(capture.audio).toBe(SHARED_AUDIO_CAPTURE_CONSTRAINTS);
  });
});

describe('ceiling-aware picker options', () => {
  it('offers up to 1440p under the default ceiling, but not 4K', () => {
    expect(availableResolutions(CEILING)).toEqual(['480p', '720p', '1080p', '1440p']);
    expect(availableFramerates(CEILING)).toEqual([15, 30, 60]);
  });

  it('unlocks 4K when a self-hoster raises the ceiling', () => {
    const generous: ScreenShareCeiling = {
      maxWidth: 3840,
      maxHeight: 2160,
      maxFramerate: 60,
      maxBitrate: 32_000_000
    };

    expect(availableResolutions(generous)).toContain('2160p');
  });

  it('hides tiers a lowered ceiling forbids', () => {
    const capped: ScreenShareCeiling = { ...CEILING, maxWidth: 1920, maxHeight: 1080 };

    expect(availableResolutions(capped)).toEqual(['480p', '720p', '1080p']);
  });

  it('hides 60fps when the ceiling forbids it', () => {
    expect(availableFramerates({ ...CEILING, maxFramerate: 30 })).toEqual([15, 30]);
  });

  it('never presents an empty picker', () => {
    const absurd: ScreenShareCeiling = {
      maxWidth: 320,
      maxHeight: 240,
      maxFramerate: 5,
      maxBitrate: 100_000
    };

    expect(availableResolutions(absurd)).toEqual(['480p']);
    expect(availableFramerates(absurd)).toEqual([15]);
  });
});

describe('clampQualityPrefs', () => {
  it('degrades a stored preference the server no longer allows', () => {
    // A self-hoster lowered their ceiling to 1080p30 after the user had already picked 1440p60.
    const stored = prefs({ resolution: '1440p', framerate: 60 });
    const lowered: ScreenShareCeiling = {
      maxWidth: 1920,
      maxHeight: 1080,
      maxFramerate: 30,
      maxBitrate: 5_000_000
    };

    expect(clampQualityPrefs(stored, lowered)).toEqual({
      resolution: '1080p',
      framerate: 30,
      shareAudio: false
    });
  });

  it('keeps 1440p60 under the default ceiling, which has the bitrate for it', () => {
    const stored = prefs({ resolution: '1440p', framerate: 60 });

    expect(clampQualityPrefs(stored, CEILING)).toEqual(stored);
    // 1440p60 needs ~14.4 Mbps, which fits the 15 Mbps default ceiling without clamping.
    const { effectiveBitrate } = resolveScreenShareOptions(stored, CEILING);
    expect(effectiveBitrate).toBe(14_400_000);
  });

  it('leaves a permitted preference untouched', () => {
    const stored = prefs({ resolution: '720p', framerate: 30, shareAudio: true });

    expect(clampQualityPrefs(stored, CEILING)).toEqual(stored);
  });
});

describe('formatBitrateMbps', () => {
  it.each([
    [8_000_000, '8'],
    [4_000_000, '4'],
    [2_500_000, '2.5'],
    [15_000_000, '15']
  ])('formats %d as %s Mbps', (bits, expected) => {
    expect(formatBitrateMbps(bits)).toBe(expected);
  });
});

describe('isScreenShareQualityPrefs', () => {
  it('accepts a valid payload', () => {
    expect(isScreenShareQualityPrefs(prefs())).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an unknown resolution', { resolution: '8k', framerate: 60, shareAudio: false }],
    ['an unknown framerate', { resolution: '1080p', framerate: 144, shareAudio: false }],
    ['a missing shareAudio', { resolution: '1080p', framerate: 60 }]
  ])('rejects %s', (_label, value) => {
    expect(isScreenShareQualityPrefs(value)).toBe(false);
  });
});
