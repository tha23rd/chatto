/**
 * User preferences store.
 *
 * Stores user preferences in localStorage for persistence across sessions.
 * These are client-side preferences that don't need server sync.
 */

import {
  type NotificationSoundFilters,
  type NotificationSoundId,
  defaultNotificationSoundFilters,
  defaultSoundId,
  notificationSounds
} from '$lib/audio/notificationSounds';
import {
  type CallKeybindingAction,
  type CallKeybindings,
  DEFAULT_CALL_KEYBINDINGS,
  normalizeCallKeybindingAccelerator,
  normalizeCallKeybindings,
  notifyCallKeybindingsChanged
} from '$lib/callKeybindings';
import type { DesktopUpdateChannel } from '$lib/native/types';
import { Codecs, globalSlot } from '$lib/storage/slot';

export type DisplayTheme = 'system' | 'light' | 'dark';
type EffectiveTheme = 'light' | 'dark';

/**
 * Listener-side controls for soundboard playback. `volume` scales how loudly
 * other members' soundboard sounds are heard in a call (0–1, where 1 is the
 * sound's own configured level); `muted` silences the soundboard entirely
 * without losing the chosen level. These are per-device preferences.
 */
interface SoundboardPlaybackPreferences {
  volume: number;
  muted: boolean;
}

const defaultSoundboardPlayback: SoundboardPlaybackPreferences = {
  volume: 1,
  muted: false
};

/**
 * How the viewer wants call tiles laid out and which of them are worth screen
 * space. All four are per-device presentation choices: they change nothing for
 * other participants and publish no media state.
 *
 * `grid` lays every tile out at equal size instead of one featured feed above a
 * secondary strip. The three `show*` flags drop tiles the viewer does not want
 * to look at — their own camera, their own screen share (they are already
 * looking at the real thing), and participants with no video at all.
 *
 * `collapsedStrip` folds away the secondary strip under the featured feed, giving that
 * feed the whole stage. It has no effect in grid view, which has no strip.
 */
export interface CallViewPreferences {
  grid: boolean;
  showOwnCamera: boolean;
  showNonVideoParticipants: boolean;
  showOwnScreenShare: boolean;
  collapsedStrip: boolean;
}

export type CallViewPreferenceKey = keyof CallViewPreferences;

const defaultCallView: CallViewPreferences = {
  grid: false,
  showOwnCamera: true,
  showNonVideoParticipants: true,
  showOwnScreenShare: true,
  collapsedStrip: false
};

interface Preferences {
  displayTheme: DisplayTheme;
  desktopUpdateChannel: DesktopUpdateChannel;
  notificationSound: NotificationSoundId;
  notificationSoundFilters: NotificationSoundFilters;
  soundboardPlayback: SoundboardPlaybackPreferences;
  callView: CallViewPreferences;
  callKeybindings: CallKeybindings;
}

const defaultPreferences: Preferences = {
  displayTheme: 'system',
  desktopUpdateChannel: 'stable',
  notificationSound: defaultSoundId,
  notificationSoundFilters: defaultNotificationSoundFilters,
  soundboardPlayback: defaultSoundboardPlayback,
  callView: defaultCallView,
  callKeybindings: DEFAULT_CALL_KEYBINDINGS
};

const slot = globalSlot('preferences', defaultPreferences, Codecs.json<Preferences>());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeDesktopUpdateChannel(value: unknown): DesktopUpdateChannel {
  return value === 'nightly' ? 'nightly' : 'stable';
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function isDisplayTheme(value: unknown): value is DisplayTheme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function getLegacyDisplayTheme(): DisplayTheme | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const legacy = localStorage.getItem('theme');
    return isDisplayTheme(legacy) && legacy !== 'system' ? legacy : null;
  } catch {
    return null;
  }
}

function getStoredDisplayTheme(): DisplayTheme | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(slot.key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return isDisplayTheme(parsed.displayTheme) ? parsed.displayTheme : null;
  } catch {
    return null;
  }
}

export function resolveDisplayTheme(theme: DisplayTheme): EffectiveTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyDisplayTheme(theme: DisplayTheme): void {
  if (typeof document === 'undefined') return;
  const effective = resolveDisplayTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = effective;
  root.style.backgroundColor = effective === 'dark' ? '#171717' : '#f3f4f6';
  root.style.colorScheme = effective;
}

function normalizeNotificationSoundFilters(value: unknown): NotificationSoundFilters {
  const stored = isRecord(value) ? value : {};
  return {
    volume: clampNumber(stored.volume, 0, 2, defaultNotificationSoundFilters.volume),
    highPassHz: clampNumber(
      stored.highPassHz,
      20,
      2000,
      defaultNotificationSoundFilters.highPassHz
    ),
    lowPassHz: clampNumber(stored.lowPassHz, 800, 20000, defaultNotificationSoundFilters.lowPassHz),
    echo: clampNumber(stored.echo, 0, 100, defaultNotificationSoundFilters.echo),
    reverb: clampNumber(stored.reverb, 0, 100, defaultNotificationSoundFilters.reverb),
    crunch: clampNumber(stored.crunch, 0, 100, defaultNotificationSoundFilters.crunch)
  };
}

function normalizeSoundboardPlayback(value: unknown): SoundboardPlaybackPreferences {
  const stored = isRecord(value) ? value : {};
  return {
    volume: clampNumber(stored.volume, 0, 1, defaultSoundboardPlayback.volume),
    muted: typeof stored.muted === 'boolean' ? stored.muted : defaultSoundboardPlayback.muted
  };
}

function normalizeCallView(value: unknown): CallViewPreferences {
  const stored = isRecord(value) ? value : {};
  const flag = (key: CallViewPreferenceKey): boolean =>
    typeof stored[key] === 'boolean' ? (stored[key] as boolean) : defaultCallView[key];
  return {
    grid: flag('grid'),
    showOwnCamera: flag('showOwnCamera'),
    showNonVideoParticipants: flag('showNonVideoParticipants'),
    showOwnScreenShare: flag('showOwnScreenShare'),
    collapsedStrip: flag('collapsedStrip')
  };
}

function loadPreferences(): Preferences {
  const stored = slot.get();
  // Validate that the stored sound ID is still valid — silently fall back
  // to the default if the user migrated away from a sound we no longer ship.
  const isValidSound = notificationSounds.some((s) => s.id === stored.notificationSound);
  const displayTheme =
    getStoredDisplayTheme() ?? getLegacyDisplayTheme() ?? defaultPreferences.displayTheme;
  return {
    ...defaultPreferences,
    ...stored,
    displayTheme,
    desktopUpdateChannel: normalizeDesktopUpdateChannel(stored.desktopUpdateChannel),
    notificationSound: isValidSound ? stored.notificationSound : defaultSoundId,
    notificationSoundFilters: normalizeNotificationSoundFilters(stored.notificationSoundFilters),
    soundboardPlayback: normalizeSoundboardPlayback(stored.soundboardPlayback),
    callView: normalizeCallView(stored.callView),
    callKeybindings: normalizeCallKeybindings(stored.callKeybindings)
  };
}

export class UserPreferencesState {
  #prefs = $state<Preferences>(loadPreferences());

  get displayTheme(): DisplayTheme {
    return this.#prefs.displayTheme;
  }

  set displayTheme(value: DisplayTheme) {
    const displayTheme = isDisplayTheme(value) ? value : defaultPreferences.displayTheme;
    this.#prefs.displayTheme = displayTheme;
    slot.set(this.#prefs);
    applyDisplayTheme(displayTheme);
  }

  get effectiveDisplayTheme(): EffectiveTheme {
    return resolveDisplayTheme(this.#prefs.displayTheme);
  }

  get desktopUpdateChannel(): DesktopUpdateChannel {
    return this.#prefs.desktopUpdateChannel;
  }

  set desktopUpdateChannel(value: DesktopUpdateChannel) {
    this.#prefs.desktopUpdateChannel = normalizeDesktopUpdateChannel(value);
    slot.set(this.#prefs);
  }

  get notificationSound(): NotificationSoundId {
    return this.#prefs.notificationSound;
  }

  set notificationSound(value: NotificationSoundId) {
    this.#prefs.notificationSound = value;
    slot.set(this.#prefs);
  }

  get notificationSoundFilters(): NotificationSoundFilters {
    return this.#prefs.notificationSoundFilters;
  }

  set notificationSoundFilters(value: NotificationSoundFilters) {
    this.#prefs.notificationSoundFilters = normalizeNotificationSoundFilters(value);
    slot.set(this.#prefs);
  }

  setNotificationSoundFilter(key: keyof NotificationSoundFilters, value: number) {
    this.notificationSoundFilters = {
      ...this.#prefs.notificationSoundFilters,
      [key]: value
    };
  }

  resetNotificationSoundFilters() {
    this.notificationSoundFilters = defaultNotificationSoundFilters;
  }

  /**
   * Check if notifications are muted (sound set to silent).
   */
  get isMuted(): boolean {
    return this.#prefs.notificationSound === 'silent';
  }

  get soundboardVolume(): number {
    return this.#prefs.soundboardPlayback.volume;
  }

  set soundboardVolume(value: number) {
    this.#prefs.soundboardPlayback = normalizeSoundboardPlayback({
      ...this.#prefs.soundboardPlayback,
      volume: value
    });
    slot.set(this.#prefs);
  }

  get soundboardMuted(): boolean {
    return this.#prefs.soundboardPlayback.muted;
  }

  set soundboardMuted(value: boolean) {
    this.#prefs.soundboardPlayback = normalizeSoundboardPlayback({
      ...this.#prefs.soundboardPlayback,
      muted: value
    });
    slot.set(this.#prefs);
  }

  /**
   * Effective gain to apply to other members' soundboard audio: zero when
   * muted, otherwise the chosen volume. This is what the call layer multiplies
   * incoming soundboard tracks by.
   */
  get soundboardPlaybackGain(): number {
    return this.#prefs.soundboardPlayback.muted ? 0 : this.#prefs.soundboardPlayback.volume;
  }

  get callView(): CallViewPreferences {
    return this.#prefs.callView;
  }

  set callView(value: CallViewPreferences) {
    this.#prefs.callView = normalizeCallView(value);
    slot.set(this.#prefs);
  }

  setCallViewPreference(key: CallViewPreferenceKey, value: boolean): void {
    this.callView = { ...this.#prefs.callView, [key]: value };
  }

  toggleCallViewPreference(key: CallViewPreferenceKey): void {
    this.setCallViewPreference(key, !this.#prefs.callView[key]);
  }

  /**
   * Per-device call shortcuts. Browser clients use them while Chatto has
   * focus; desktop clients register them as system-wide shortcuts.
   */
  get callKeybindings(): CallKeybindings {
    return this.#prefs.callKeybindings;
  }

  setCallKeybinding(action: CallKeybindingAction, value: string | null): void {
    const next = { ...this.#prefs.callKeybindings };
    delete next[action];

    const accelerator = normalizeCallKeybindingAccelerator(value);
    if (accelerator) {
      // One physical chord must have one deterministic meaning. Reassigning it
      // moves the chord from the old action to the new one.
      for (const [boundAction, boundAccelerator] of Object.entries(next)) {
        if (boundAccelerator === accelerator) {
          delete next[boundAction as CallKeybindingAction];
        }
      }
      next[action] = accelerator;
    }

    this.#prefs.callKeybindings = normalizeCallKeybindings(next);
    slot.set(this.#prefs);
    notifyCallKeybindingsChanged();
  }

  resetCallKeybindings(): void {
    this.#prefs.callKeybindings = { ...DEFAULT_CALL_KEYBINDINGS };
    slot.set(this.#prefs);
    notifyCallKeybindingsChanged();
  }
}

export const userPreferences = new UserPreferencesState();
