import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CALL_KEYBINDINGS } from '$lib/callKeybindings';
import { userPreferences } from '$lib/state/userPreferences.svelte';
import { browserNativeHost } from './browserHost';
import { NativeCallControlsController, type NativeCallControlTarget } from './callControls';
import type {
  NativeCallControls,
  NativeHost,
  NativeShortcutState,
  NativeTrayAction
} from './types';

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

function createHarness() {
  let controls: NativeCallControls = { connected: true, muted: true, deafened: false };
  const shortcutListeners = new Map<string, (state: NativeShortcutState) => void>();
  let trayListener: ((action: NativeTrayAction) => void) | null = null;
  const shortcutUnsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
  const unsubscribeTray = vi.fn();
  const host: NativeHost = {
    ...browserNativeHost,
    kind: 'tauri',
    capabilities: {
      ...browserNativeHost.capabilities,
      globalCallKeybindings: true,
      tray: true
    },
    registerGlobalShortcut: vi.fn(async (accelerator, listener) => {
      shortcutListeners.set(accelerator, listener);
      const unsubscribe = vi.fn(() => {
        shortcutListeners.delete(accelerator);
      });
      shortcutUnsubscribes.set(accelerator, unsubscribe);
      return unsubscribe;
    }),
    onTrayAction: vi.fn(async (listener) => {
      trayListener = listener;
      return unsubscribeTray;
    }),
    setCallControls: vi.fn(async () => {})
  };
  const target = createTarget();
  target.snapshot = () => controls;

  return {
    host,
    target,
    shortcutUnsubscribes,
    unsubscribeTray,
    setControls(next: NativeCallControls) {
      controls = next;
    },
    emitShortcut(accelerator: string, state: NativeShortcutState) {
      shortcutListeners.get(accelerator)?.(state);
    },
    emitTray(action: NativeTrayAction) {
      trayListener?.(action);
    }
  };
}

beforeEach(() => {
  userPreferences.resetCallKeybindings();
});

describe('NativeCallControlsController', () => {
  it('registers configured native controls only for an active call and mirrors tray state', async () => {
    const harness = createHarness();
    const controller = new NativeCallControlsController(harness.host, harness.target);

    controller.start();
    await vi.waitFor(() => {
      expect(harness.host.registerGlobalShortcut).toHaveBeenCalledWith(
        DEFAULT_CALL_KEYBINDINGS['push-to-talk'],
        expect.any(Function)
      );
      expect(harness.host.onTrayAction).toHaveBeenCalledOnce();
    });
    expect(harness.host.setCallControls).toHaveBeenCalledWith({
      connected: true,
      muted: true,
      deafened: false
    });

    harness.setControls({ connected: true, muted: false, deafened: true });
    controller.sync();
    await vi.waitFor(() => {
      expect(harness.host.setCallControls).toHaveBeenLastCalledWith({
        connected: true,
        muted: false,
        deafened: true
      });
    });
    controller.stop();
  });

  it('dispatches momentary, toggle, explicit-state, streaming, and leave actions', async () => {
    userPreferences.setCallKeybinding('push-to-talk', 'Alt+KeyT');
    userPreferences.setCallKeybinding('push-to-mute', 'Alt+KeyM');
    userPreferences.setCallKeybinding('toggle-deafen', 'Control+KeyD');
    userPreferences.setCallKeybinding('camera-on', 'Control+KeyC');
    userPreferences.setCallKeybinding('start-screen-share', 'Control+KeyS');
    userPreferences.setCallKeybinding('leave-call', 'Control+KeyL');
    const harness = createHarness();
    const controller = new NativeCallControlsController(harness.host, harness.target);
    controller.start();
    await vi.waitFor(() =>
      expect(harness.host.registerGlobalShortcut).toHaveBeenCalledTimes(6)
    );

    harness.emitShortcut('Alt+KeyT', 'pressed');
    harness.emitShortcut('Alt+KeyT', 'pressed');
    harness.emitShortcut('Alt+KeyT', 'released');
    harness.emitShortcut('Alt+KeyM', 'pressed');
    harness.emitShortcut('Alt+KeyM', 'released');
    harness.emitShortcut('Control+KeyD', 'pressed');
    harness.emitShortcut('Control+KeyD', 'released');
    harness.emitShortcut('Control+KeyC', 'pressed');
    harness.emitShortcut('Control+KeyS', 'pressed');
    harness.emitShortcut('Control+KeyL', 'pressed');

    expect(harness.target.setPushToTalkPressed).toHaveBeenNthCalledWith(1, true);
    expect(harness.target.setPushToTalkPressed).toHaveBeenNthCalledWith(2, false);
    expect(harness.target.setPushToMutePressed).toHaveBeenNthCalledWith(1, true);
    expect(harness.target.setPushToMutePressed).toHaveBeenNthCalledWith(2, false);
    expect(harness.target.toggleDeafen).toHaveBeenCalledOnce();
    expect(harness.target.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(harness.target.setScreenShareEnabled).toHaveBeenCalledWith(true);
    expect(harness.target.leave).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('re-registers native shortcuts when preferences change during a call', async () => {
    const harness = createHarness();
    const controller = new NativeCallControlsController(harness.host, harness.target);
    controller.start();
    await vi.waitFor(() =>
      expect(harness.host.registerGlobalShortcut).toHaveBeenCalledWith(
        'Control+Shift+Space',
        expect.any(Function)
      )
    );

    userPreferences.setCallKeybinding('push-to-talk', 'F8');

    await vi.waitFor(() =>
      expect(harness.host.registerGlobalShortcut).toHaveBeenCalledWith(
        'F8',
        expect.any(Function)
      )
    );
    expect(harness.shortcutUnsubscribes.get('Control+Shift+Space')).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('forwards call-relevant tray actions', async () => {
    const harness = createHarness();
    const controller = new NativeCallControlsController(harness.host, harness.target);
    controller.start();
    await vi.waitFor(() => expect(harness.host.onTrayAction).toHaveBeenCalledOnce());

    harness.emitTray('toggle-mute');
    harness.emitTray('toggle-deafen');
    harness.emitTray('show');

    expect(harness.target.toggleMute).toHaveBeenCalledOnce();
    expect(harness.target.toggleDeafen).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('releases held actions and listeners when the call stops', async () => {
    userPreferences.setCallKeybinding('push-to-mute', 'F9');
    const harness = createHarness();
    const controller = new NativeCallControlsController(harness.host, harness.target);
    controller.start();
    await vi.waitFor(() => expect(harness.host.onTrayAction).toHaveBeenCalledOnce());
    harness.emitShortcut('F9', 'pressed');
    harness.setControls({ connected: false, muted: false, deafened: false });

    controller.stop();

    expect(harness.target.setPushToMutePressed).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => {
      expect(harness.shortcutUnsubscribes.get('F9')).toHaveBeenCalledOnce();
      expect(harness.unsubscribeTray).toHaveBeenCalledOnce();
      expect(harness.host.setCallControls).toHaveBeenLastCalledWith({
        connected: false,
        muted: false,
        deafened: false
      });
    });
  });

  it('attempts every cleanup when one native unsubscription fails', async () => {
    userPreferences.setCallKeybinding('toggle-mute', 'F7');
    const harness = createHarness();
    const controller = new NativeCallControlsController(harness.host, harness.target);
    controller.start();
    await vi.waitFor(() =>
      expect(harness.host.registerGlobalShortcut).toHaveBeenCalledTimes(2)
    );
    harness.shortcutUnsubscribes
      .get('Control+Shift+Space')
      ?.mockRejectedValueOnce(new Error('shortcut cleanup failed'));

    controller.stop();

    await vi.waitFor(() => {
      expect(
        harness.shortcutUnsubscribes.get('Control+Shift+Space')
      ).toHaveBeenCalledTimes(2);
      expect(harness.shortcutUnsubscribes.get('F7')).toHaveBeenCalledOnce();
      expect(harness.unsubscribeTray).toHaveBeenCalledOnce();
    });
  });

  it('keeps other bindings active when one system shortcut is unavailable', async () => {
    userPreferences.setCallKeybinding('toggle-mute', 'F7');
    const harness = createHarness();
    vi.mocked(harness.host.registerGlobalShortcut).mockImplementation(
      async (accelerator, listener) => {
        if (accelerator === 'Control+Shift+Space') throw new Error('already registered');
        return async () => {
          void listener;
        };
      }
    );
    const controller = new NativeCallControlsController(harness.host, harness.target);

    controller.start();

    await vi.waitFor(() =>
      expect(harness.host.registerGlobalShortcut).toHaveBeenCalledWith(
        'F7',
        expect.any(Function)
      )
    );
    controller.stop();
  });

  it('dispatches unregisterable chords from focused-window keys without double-firing global ones', async () => {
    const originalWindow = globalThis.window;
    const originalElement = globalThis.Element;
    // Node lacks DOM globals; `isEditableShortcutTarget` only needs the
    // instanceof check to reject non-element targets.
    class FakeElement {}
    globalThis.Element = FakeElement as unknown as typeof Element;
    const listeners = new Map<string, Set<(event: KeyboardEvent) => void>>();
    const fakeWindow = {
      addEventListener: (type: string, fn: (event: KeyboardEvent) => void) => {
        let typed = listeners.get(type);
        if (!typed) {
          typed = new Set();
          listeners.set(type, typed);
        }
        typed.add(fn);
      },
      removeEventListener: (type: string, fn: (event: KeyboardEvent) => void) => {
        listeners.get(type)?.delete(fn);
      }
    } as unknown as Window & typeof globalThis;
    globalThis.window = fakeWindow;

    try {
      const shortcutListeners = new Map<string, (state: NativeShortcutState) => void>();
      const host: NativeHost = {
        ...browserNativeHost,
        kind: 'tauri',
        capabilities: {
          ...browserNativeHost.capabilities,
          globalCallKeybindings: true
        },
        registerGlobalShortcut: vi.fn(async (accelerator, listener) => {
          if (accelerator === 'AltRight') throw new Error('unsupported key');
          shortcutListeners.set(accelerator, listener);
          return () => {
            shortcutListeners.delete(accelerator);
          };
        })
      };
      userPreferences.setCallKeybinding('toggle-mute', 'Control+KeyM');
      userPreferences.setCallKeybinding('push-to-talk', 'AltRight');
      const target = createTarget();
      const controller = new NativeCallControlsController(host, target);

      controller.start();
      await vi.waitFor(() =>
        expect(host.registerGlobalShortcut).toHaveBeenCalledWith(
          'AltRight',
          expect.any(Function)
        )
      );

      const keydown = [...(listeners.get('keydown') ?? [])];
      expect(keydown).toHaveLength(1);

      const press = (event: KeyboardEvent) => keydown[0]?.(event);
      // The same window key event must not duplicate the registered chord.
      press({
        code: 'KeyM',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        target: null
      } as unknown as KeyboardEvent);
      expect(target.toggleMute).not.toHaveBeenCalled();
      shortcutListeners.get('Control+KeyM')?.('pressed');
      expect(target.toggleMute).toHaveBeenCalledOnce();

      // A bare right Alt the system cannot register dispatches while focused.
      press({
        code: 'AltRight',
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        target: null
      } as unknown as KeyboardEvent);
      expect(target.setPushToTalkPressed).toHaveBeenLastCalledWith(true);
      [...(listeners.get('keyup') ?? [])][0]?.({
        code: 'AltRight',
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        target: null
      } as unknown as KeyboardEvent);
      expect(target.setPushToTalkPressed).toHaveBeenLastCalledWith(false);

      controller.stop();
      await vi.waitFor(() => expect(listeners.get('keydown')?.size).toBe(0));
      expect(listeners.get('keyup')?.size).toBe(0);
    } finally {
      globalThis.window = originalWindow;
      globalThis.Element = originalElement;
    }
  });

  it('gives shortcut ownership to the most recently started call', async () => {
    const harness = createHarness();
    const firstTarget = createTarget();
    const secondTarget = createTarget();
    const first = new NativeCallControlsController(harness.host, firstTarget);
    const second = new NativeCallControlsController(harness.host, secondTarget);

    first.start();
    second.start();
    await vi.waitFor(() => expect(harness.host.onTrayAction).toHaveBeenCalledOnce());

    harness.emitShortcut('Control+Shift+Space', 'pressed');
    harness.emitShortcut('Control+Shift+Space', 'released');
    harness.emitTray('toggle-mute');
    expect(firstTarget.setPushToTalkPressed).not.toHaveBeenCalledWith(true);
    expect(firstTarget.toggleMute).not.toHaveBeenCalled();
    expect(secondTarget.setPushToTalkPressed).toHaveBeenCalledWith(true);
    expect(secondTarget.toggleMute).toHaveBeenCalledOnce();
    expect(harness.host.registerGlobalShortcut).toHaveBeenCalledOnce();

    second.stop();
    harness.emitTray('toggle-deafen');
    expect(firstTarget.toggleDeafen).toHaveBeenCalledOnce();
    expect(secondTarget.toggleDeafen).not.toHaveBeenCalled();
    first.stop();
  });

  it('does not release a held action when an inactive call stops', async () => {
    const harness = createHarness();
    const firstTarget = createTarget();
    const secondTarget = createTarget();
    const first = new NativeCallControlsController(harness.host, firstTarget);
    const second = new NativeCallControlsController(harness.host, secondTarget);

    first.start();
    second.start();
    await vi.waitFor(() => expect(harness.host.onTrayAction).toHaveBeenCalledOnce());
    harness.emitShortcut('Control+Shift+Space', 'pressed');

    first.stop();

    expect(secondTarget.setPushToTalkPressed).toHaveBeenCalledTimes(1);
    expect(secondTarget.setPushToTalkPressed).toHaveBeenLastCalledWith(true);
    harness.emitShortcut('Control+Shift+Space', 'released');
    expect(secondTarget.setPushToTalkPressed).toHaveBeenLastCalledWith(false);
    second.stop();
  });

  it('awaits delayed native cleanup before registering the next call', async () => {
    let finishUnregister!: () => void;
    const unregistering = new Promise<void>((resolve) => {
      finishUnregister = resolve;
    });
    const unregisterShortcut = vi.fn(() => unregistering);
    const host: NativeHost = {
      ...browserNativeHost,
      kind: 'tauri',
      capabilities: {
        ...browserNativeHost.capabilities,
        globalCallKeybindings: true,
        tray: true
      },
      registerGlobalShortcut: vi.fn(async () => unregisterShortcut),
      onTrayAction: vi.fn(async () => async () => {}),
      setCallControls: vi.fn(async () => {})
    };
    const target = createTarget();
    const first = new NativeCallControlsController(host, target);
    const second = new NativeCallControlsController(host, target);

    first.start();
    await vi.waitFor(() => expect(host.registerGlobalShortcut).toHaveBeenCalledOnce());
    first.stop();
    await vi.waitFor(() => expect(unregisterShortcut).toHaveBeenCalledOnce());
    second.start();
    expect(host.registerGlobalShortcut).toHaveBeenCalledOnce();

    finishUnregister();
    await vi.waitFor(() => expect(host.registerGlobalShortcut).toHaveBeenCalledTimes(2));
    second.stop();
  });
});
