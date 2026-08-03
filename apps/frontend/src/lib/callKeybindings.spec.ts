import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CALL_KEYBINDINGS,
  callKeybindingAcceleratorFromEvent,
  callKeybindingActionForAccelerator,
  formatCallKeybindingAccelerator,
  isCallKeybindingCaptureActive,
  normalizeCallKeybindingAccelerator,
  normalizeCallKeybindings,
  notifyCallKeybindingsChanged,
  onCallKeybindingsChanged,
  setCallKeybindingCaptureActive
} from './callKeybindings';

describe('call keybindings', () => {
  it('preserves the original desktop push-to-talk default for new preferences', () => {
    expect(normalizeCallKeybindings(undefined)).toEqual(DEFAULT_CALL_KEYBINDINGS);
    expect(normalizeCallKeybindings({})).toEqual({});
  });

  it('normalizes valid accelerators and rejects malformed or unsupported values', () => {
    expect(normalizeCallKeybindingAccelerator('Shift+Control+KeyM')).toBe(
      'Control+Shift+KeyM'
    );
    expect(normalizeCallKeybindingAccelerator('Control+Control+KeyM')).toBeNull();
    expect(normalizeCallKeybindingAccelerator('Control')).toBeNull();
    expect(normalizeCallKeybindingAccelerator('Control+IntlYen')).toBeNull();
    expect(normalizeCallKeybindingAccelerator(42)).toBeNull();
  });

  it('drops unknown actions, invalid values, and duplicate accelerators from storage', () => {
    expect(
      normalizeCallKeybindings({
        'push-to-talk': 'Alt+KeyT',
        'push-to-mute': 'Alt+KeyT',
        'toggle-mute': 'Control+KeyM',
        'toggle-deafen': 'bad',
        'not-an-action': 'Control+KeyQ'
      })
    ).toEqual({
      'push-to-talk': 'Alt+KeyT',
      'toggle-mute': 'Control+KeyM'
    });
  });

  it('captures physical browser keys with canonical modifiers', () => {
    expect(
      callKeybindingAcceleratorFromEvent({
        altKey: true,
        code: 'KeyM',
        ctrlKey: true,
        metaKey: false,
        shiftKey: true
      })
    ).toBe('Control+Alt+Shift+KeyM');
    expect(
      callKeybindingAcceleratorFromEvent({
        altKey: false,
        code: 'ShiftLeft',
        ctrlKey: false,
        metaKey: false,
        shiftKey: true
      })
    ).toBeNull();
  });

  it('formats accelerators as readable keycaps and resolves assigned actions', () => {
    expect(formatCallKeybindingAccelerator('Control+Shift+Space')).toBe(
      'Ctrl + Shift + Space'
    );
    expect(formatCallKeybindingAccelerator('Alt+Numpad7')).toBe('Alt + Numpad 7');
    expect(
      callKeybindingActionForAccelerator(
        { 'toggle-mute': 'Control+KeyM' },
        'Control+KeyM'
      )
    ).toBe('toggle-mute');
  });

  it('notifies coordinators after preferences change and tracks capture state', () => {
    const listener = vi.fn();
    const unsubscribe = onCallKeybindingsChanged(listener);

    setCallKeybindingCaptureActive(true);
    expect(isCallKeybindingCaptureActive()).toBe(true);
    notifyCallKeybindingsChanged();
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    notifyCallKeybindingsChanged();
    expect(listener).toHaveBeenCalledOnce();
    setCallKeybindingCaptureActive(false);
  });
});
