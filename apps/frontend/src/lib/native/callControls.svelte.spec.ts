import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCallKeybindingCaptureActive } from '$lib/callKeybindings';
import { userPreferences } from '$lib/state/userPreferences.svelte';
import { browserNativeHost } from './browserHost';
import { NativeCallControlsController, type NativeCallControlTarget } from './callControls';

function createTarget(): NativeCallControlTarget {
  return {
    snapshot: () => ({ connected: true, muted: true, deafened: false }),
    setPushToTalkPressed: vi.fn(async () => {}),
    setPushToMutePressed: vi.fn(async () => {}),
    toggleMute: vi.fn(async () => {}),
    setMuted: vi.fn(async () => {}),
    toggleDeafen: vi.fn(async () => {}),
    setDeafened: vi.fn(async () => {}),
    toggleCamera: vi.fn(async () => {}),
    setCameraEnabled: vi.fn(async () => {}),
    toggleScreenShare: vi.fn(async () => {}),
    setScreenShareEnabled: vi.fn(async () => {}),
    leave: vi.fn(async () => {})
  };
}

function keyboardEvent(
  type: 'keydown' | 'keyup',
  code: string,
  init: KeyboardEventInit = {}
): KeyboardEvent {
  return new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code,
    ...init
  });
}

let controller: NativeCallControlsController | null = null;

beforeEach(() => {
  localStorage.clear();
  userPreferences.resetCallKeybindings();
  setCallKeybindingCaptureActive(false);
});

afterEach(async () => {
  controller?.stop();
  controller = null;
  setCallKeybindingCaptureActive(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('browser call keybindings', () => {
  it('dispatches focused shortcuts, ignores repeats and editors, and releases held actions', async () => {
    userPreferences.setCallKeybinding('toggle-mute', 'Control+KeyM');
    userPreferences.setCallKeybinding('push-to-talk', 'F8');
    const target = createTarget();
    controller = new NativeCallControlsController(browserNativeHost, target);
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const muteDown = keyboardEvent('keydown', 'KeyM', { ctrlKey: true });
    window.dispatchEvent(muteDown);
    window.dispatchEvent(keyboardEvent('keydown', 'KeyM', { ctrlKey: true, repeat: true }));
    window.dispatchEvent(keyboardEvent('keyup', 'KeyM', { ctrlKey: true }));

    expect(muteDown.defaultPrevented).toBe(true);
    expect(target.toggleMute).toHaveBeenCalledOnce();

    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(keyboardEvent('keydown', 'KeyM', { ctrlKey: true }));
    expect(target.toggleMute).toHaveBeenCalledOnce();
    input.remove();

    window.dispatchEvent(keyboardEvent('keydown', 'F8'));
    window.dispatchEvent(keyboardEvent('keydown', 'F8', { repeat: true }));
    window.dispatchEvent(keyboardEvent('keyup', 'F8'));
    expect(target.setPushToTalkPressed).toHaveBeenNthCalledWith(1, true);
    expect(target.setPushToTalkPressed).toHaveBeenNthCalledWith(2, false);

    userPreferences.setCallKeybinding('push-to-talk', 'Control+F8');
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(keyboardEvent('keydown', 'F8', { ctrlKey: true }));
    // Releasing Control first means the F8 key-up no longer reports ctrlKey.
    window.dispatchEvent(keyboardEvent('keyup', 'F8'));
    expect(target.setPushToTalkPressed).toHaveBeenNthCalledWith(3, true);
    expect(target.setPushToTalkPressed).toHaveBeenNthCalledWith(4, false);

    window.dispatchEvent(keyboardEvent('keydown', 'F8'));
    window.dispatchEvent(new Event('blur'));
    expect(target.setPushToTalkPressed).toHaveBeenCalledTimes(4);

    window.dispatchEvent(keyboardEvent('keydown', 'F8', { ctrlKey: true }));
    window.dispatchEvent(new Event('blur'));
    expect(target.setPushToTalkPressed).toHaveBeenLastCalledWith(false);

    setCallKeybindingCaptureActive(true);
    window.dispatchEvent(keyboardEvent('keydown', 'F8', { ctrlKey: true }));
    expect(target.setPushToTalkPressed).toHaveBeenCalledTimes(6);
  });
});
