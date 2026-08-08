/**
 * Per-device call keybindings shared by browser and desktop hosts.
 *
 * Accelerators use Tauri/global-hotkey's portable spelling so the same stored
 * value can be matched against browser `KeyboardEvent.code` values and
 * registered with the Windows desktop host. Modifier keys themselves (for
 * example right Alt) and international-layout keys are valid base keys; the
 * desktop host falls back to focused-window dispatch for chords its plugin
 * cannot register system-wide.
 */

export const CALL_KEYBINDING_ACTIONS = [
  'push-to-talk',
  'push-to-mute',
  'toggle-mute',
  'mute',
  'unmute',
  'toggle-deafen',
  'deafen',
  'undeafen',
  'toggle-camera',
  'camera-on',
  'camera-off',
  'toggle-screen-share',
  'start-screen-share',
  'stop-screen-share',
  'leave-call'
] as const;

export type CallKeybindingAction = (typeof CALL_KEYBINDING_ACTIONS)[number];
export type CallKeybindings = Partial<Record<CallKeybindingAction, string>>;

export const DEFAULT_CALL_KEYBINDINGS: CallKeybindings = {
  // Preserve the desktop client's original proof-of-concept shortcut.
  'push-to-talk': 'Control+Shift+Space'
};

/**
 * A modifier key may itself be the base key of an accelerator (right Alt for
 * push-to-talk is the canonical example). Its own flag is inherent to the
 * press, not a chord, so it is dropped when canonicalising the event.
 */
const MODIFIER_KEY_FLAGS: Record<string, AcceleratorModifier> = {
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ControlLeft: 'Control',
  ControlRight: 'Control',
  MetaLeft: 'Super',
  MetaRight: 'Super',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift'
};

const MODIFIERS = ['Control', 'Alt', 'Shift', 'Super'] as const;
type AcceleratorModifier = (typeof MODIFIERS)[number];

/** True when a physical key code is itself a modifier key. */
export function isCallKeybindingModifierCode(code: string): boolean {
  return code in MODIFIER_KEY_FLAGS;
}

const SUPPORTED_CODES = new Set([
  'AltLeft',
  'AltRight',
  'Backquote',
  'Backslash',
  'BracketLeft',
  'BracketRight',
  'Pause',
  'Comma',
  'ControlLeft',
  'ControlRight',
  'ContextMenu',
  'Digit0',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Equal',
  'IntlBackslash',
  'IntlHash',
  'IntlRo',
  'IntlYen',
  'KeyA',
  'KeyB',
  'KeyC',
  'KeyD',
  'KeyE',
  'KeyF',
  'KeyG',
  'KeyH',
  'KeyI',
  'KeyJ',
  'KeyK',
  'KeyL',
  'KeyM',
  'KeyN',
  'KeyO',
  'KeyP',
  'KeyQ',
  'KeyR',
  'KeyS',
  'KeyT',
  'KeyU',
  'KeyV',
  'KeyW',
  'KeyX',
  'KeyY',
  'KeyZ',
  'MetaLeft',
  'MetaRight',
  'Minus',
  'Period',
  'Quote',
  'Semicolon',
  'ShiftLeft',
  'ShiftRight',
  'Slash',
  'Backspace',
  'CapsLock',
  'Enter',
  'Space',
  'Tab',
  'Delete',
  'End',
  'Home',
  'Insert',
  'PageDown',
  'PageUp',
  'PrintScreen',
  'ScrollLock',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'NumLock',
  'Numpad0',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
  'NumpadAdd',
  'NumpadDecimal',
  'NumpadDivide',
  'NumpadEnter',
  'NumpadEqual',
  'NumpadMultiply',
  'NumpadSubtract',
  'Escape',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  'F13',
  'F14',
  'F15',
  'F16',
  'F17',
  'F18',
  'F19',
  'F20',
  'F21',
  'F22',
  'F23',
  'F24',
  'AudioVolumeDown',
  'AudioVolumeUp',
  'AudioVolumeMute',
  'MediaPlay',
  'MediaPause',
  'MediaPlayPause',
  'MediaStop',
  'MediaTrackNext',
  'MediaTrackPrevious'
]);

const KEY_LABELS: Record<string, string> = {
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  ContextMenu: 'Menu',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  Equal: '=',
  IntlBackslash: 'Intl \\',
  IntlHash: 'Intl #',
  IntlRo: 'Intl Ro',
  IntlYen: 'Intl Yen',
  MetaLeft: 'Left Meta',
  MetaRight: 'Right Meta',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  Slash: '/',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  AudioVolumeDown: 'Volume Down',
  AudioVolumeUp: 'Volume Up',
  AudioVolumeMute: 'Volume Mute',
  MediaPlay: 'Media Play',
  MediaPause: 'Media Pause',
  MediaPlayPause: 'Media Play/Pause',
  MediaStop: 'Media Stop',
  MediaTrackNext: 'Next Track',
  MediaTrackPrevious: 'Previous Track',
  NumpadAdd: 'Numpad +',
  NumpadDecimal: 'Numpad .',
  NumpadDivide: 'Numpad /',
  NumpadEnter: 'Numpad Enter',
  NumpadEqual: 'Numpad =',
  NumpadMultiply: 'Numpad *',
  NumpadSubtract: 'Numpad -',
  PageDown: 'Page Down',
  PageUp: 'Page Up',
  PrintScreen: 'Print Screen',
  ScrollLock: 'Scroll Lock'
};

type KeyboardEventLike = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>;

const changeListeners = new Set<() => void>();
let captureActive = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function canonicalAccelerator(modifiers: ReadonlySet<AcceleratorModifier>, code: string): string {
  return [...MODIFIERS.filter((modifier) => modifiers.has(modifier)), code].join('+');
}

/**
 * Validate and canonicalise an accelerator before it reaches the native host.
 */
export function normalizeCallKeybindingAccelerator(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tokens = value.split('+');
  if (tokens.length === 0) return null;

  const code = tokens.at(-1);
  if (!code || !SUPPORTED_CODES.has(code)) return null;

  const modifiers = new Set<AcceleratorModifier>();
  for (const token of tokens.slice(0, -1)) {
    if (!(MODIFIERS as readonly string[]).includes(token)) return null;
    const modifier = token as AcceleratorModifier;
    if (modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }

  // A modifier key's own flag is inherent to the press, never part of the
  // chord, so `Alt+AltRight` could never be produced by a key event.
  const ownFlag = MODIFIER_KEY_FLAGS[code];
  if (ownFlag && modifiers.has(ownFlag)) return null;

  return canonicalAccelerator(modifiers, code);
}

/**
 * Sanitize persisted bindings and keep one action per accelerator.
 *
 * Passing `undefined` means the preference did not exist yet and receives the
 * compatibility default. Passing an empty object means the user deliberately
 * cleared every binding.
 */
export function normalizeCallKeybindings(value: unknown): CallKeybindings {
  if (value === undefined) return { ...DEFAULT_CALL_KEYBINDINGS };
  if (!isRecord(value)) return {};

  const result: CallKeybindings = {};
  const claimedAccelerators = new Set<string>();
  for (const action of CALL_KEYBINDING_ACTIONS) {
    const accelerator = normalizeCallKeybindingAccelerator(value[action]);
    if (!accelerator || claimedAccelerators.has(accelerator)) continue;
    result[action] = accelerator;
    claimedAccelerators.add(accelerator);
  }
  return result;
}

/** Build the canonical physical-key accelerator for a browser key event. */
export function callKeybindingAcceleratorFromEvent(event: KeyboardEventLike): string | null {
  if (!SUPPORTED_CODES.has(event.code)) return null;
  const modifiers = new Set<AcceleratorModifier>();
  if (event.ctrlKey) modifiers.add('Control');
  if (event.altKey) modifiers.add('Alt');
  if (event.shiftKey) modifiers.add('Shift');
  if (event.metaKey) modifiers.add('Super');
  // Pressing a modifier key reports its own flag, so a bare right Alt must
  // canonicalise to `AltRight`, not `Alt+AltRight`.
  const ownFlag = MODIFIER_KEY_FLAGS[event.code];
  if (ownFlag) modifiers.delete(ownFlag);
  return canonicalAccelerator(modifiers, event.code);
}

/** Human-readable keycap text for the settings surface. */
export function formatCallKeybindingAccelerator(accelerator: string): string {
  const normalized = normalizeCallKeybindingAccelerator(accelerator);
  if (!normalized) return accelerator;

  return normalized
    .split('+')
    .map((token) => {
      if (token === 'Control') return 'Ctrl';
      if (token === 'Super') return 'Meta';
      if (token.startsWith('Key')) return token.slice(3);
      if (token.startsWith('Digit')) return token.slice(5);
      if (token.startsWith('Numpad') && /^Numpad\d$/.test(token)) {
        return `Numpad ${token.at(-1)}`;
      }
      return KEY_LABELS[token] ?? token;
    })
    .join(' + ');
}

export function callKeybindingActionForAccelerator(
  bindings: CallKeybindings,
  accelerator: string
): CallKeybindingAction | null {
  for (const action of CALL_KEYBINDING_ACTIONS) {
    if (bindings[action] === accelerator) return action;
  }
  return null;
}

export function onCallKeybindingsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function notifyCallKeybindingsChanged(): void {
  for (const listener of changeListeners) listener();
}

/** Suppress active shortcuts while the settings page is recording a new one. */
export function setCallKeybindingCaptureActive(active: boolean): void {
  captureActive = active;
}

export function isCallKeybindingCaptureActive(): boolean {
  return captureActive;
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [data-call-keybinding-recorder]'
    ) !== null
  );
}
