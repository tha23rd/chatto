import { describe, expect, it, vi } from 'vitest';
import { browserNativeHost } from './browserHost';
import { NativeCallControlsController, PUSH_TO_TALK_ACCELERATOR } from './callControls';
import type {
  NativeCallControls,
  NativeHost,
  NativePushToTalkState,
  NativeTrayAction
} from './types';

function createHarness() {
  let controls: NativeCallControls = { connected: true, muted: true, deafened: false };
  let pushToTalkListener: ((state: NativePushToTalkState) => void) | null = null;
  let trayListener: ((action: NativeTrayAction) => void) | null = null;
  const unsubscribePushToTalk = vi.fn();
  const unsubscribeTray = vi.fn();
  const host: NativeHost = {
    ...browserNativeHost,
    kind: 'tauri',
    capabilities: {
      ...browserNativeHost.capabilities,
      globalPushToTalk: true,
      tray: true
    },
    registerPushToTalk: vi.fn(async (_accelerator, listener) => {
      pushToTalkListener = listener;
      return unsubscribePushToTalk;
    }),
    onTrayAction: vi.fn(async (listener) => {
      trayListener = listener;
      return unsubscribeTray;
    }),
    setCallControls: vi.fn(async () => {})
  };
  const target = {
    snapshot: () => controls,
    setPushToTalkPressed: vi.fn(async () => {}),
    toggleMute: vi.fn(async () => {}),
    toggleDeafen: vi.fn(async () => {})
  };

  return {
    host,
    target,
    unsubscribePushToTalk,
    unsubscribeTray,
    setControls(next: NativeCallControls) {
      controls = next;
    },
    emitPushToTalk(state: NativePushToTalkState) {
      pushToTalkListener?.(state);
    },
    emitTray(action: NativeTrayAction) {
      trayListener?.(action);
    }
  };
}

describe('NativeCallControlsController', () => {
  it('registers native controls only for an active call and mirrors its state', async () => {
    const harness = createHarness();
    const controller = new NativeCallControlsController(harness.host, harness.target);

    controller.start();
    await vi.waitFor(() => {
      expect(harness.host.registerPushToTalk).toHaveBeenCalledWith(
        PUSH_TO_TALK_ACCELERATOR,
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
  });

  it('forwards momentary shortcut states and call-relevant tray actions', async () => {
    const harness = createHarness();
    const controller = new NativeCallControlsController(harness.host, harness.target);
    controller.start();
    await vi.waitFor(() => expect(harness.host.onTrayAction).toHaveBeenCalledOnce());

    harness.emitPushToTalk('pressed');
    harness.emitPushToTalk('released');
    harness.emitTray('toggle-mute');
    harness.emitTray('toggle-deafen');
    harness.emitTray('show');

    expect(harness.target.setPushToTalkPressed).toHaveBeenNthCalledWith(1, true);
    expect(harness.target.setPushToTalkPressed).toHaveBeenNthCalledWith(2, false);
    expect(harness.target.toggleMute).toHaveBeenCalledOnce();
    expect(harness.target.toggleDeafen).toHaveBeenCalledOnce();
  });

  it('releases the shortcut and listeners when the call stops', async () => {
    const harness = createHarness();
    const controller = new NativeCallControlsController(harness.host, harness.target);
    controller.start();
    await vi.waitFor(() => expect(harness.host.onTrayAction).toHaveBeenCalledOnce());
    harness.setControls({ connected: false, muted: false, deafened: false });

    controller.stop();

    expect(harness.target.setPushToTalkPressed).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => {
      expect(harness.unsubscribePushToTalk).toHaveBeenCalledOnce();
      expect(harness.unsubscribeTray).toHaveBeenCalledOnce();
      expect(harness.host.setCallControls).toHaveBeenLastCalledWith({
        connected: false,
        muted: false,
        deafened: false
      });
    });
  });

  it('attempts every cleanup when one native unsubscription fails', async () => {
    const harness = createHarness();
    harness.unsubscribePushToTalk.mockRejectedValueOnce(new Error('shortcut cleanup failed'));
    const controller = new NativeCallControlsController(harness.host, harness.target);
    controller.start();
    await vi.waitFor(() => expect(harness.host.onTrayAction).toHaveBeenCalledOnce());

    controller.stop();

    await vi.waitFor(() => {
      expect(harness.unsubscribePushToTalk).toHaveBeenCalledTimes(2);
      expect(harness.unsubscribeTray).toHaveBeenCalledOnce();
      expect(harness.host.setCallControls).toHaveBeenLastCalledWith({
        connected: false,
        muted: false,
        deafened: false
      });
    });
  });

  it('gives native ownership to one active call when multiple servers are connected', async () => {
    const harness = createHarness();
    const firstTarget = {
      ...harness.target,
      setPushToTalkPressed: vi.fn(async () => {}),
      toggleMute: vi.fn(async () => {}),
      toggleDeafen: vi.fn(async () => {})
    };
    const secondTarget = {
      ...harness.target,
      setPushToTalkPressed: vi.fn(async () => {}),
      toggleMute: vi.fn(async () => {}),
      toggleDeafen: vi.fn(async () => {})
    };
    const first = new NativeCallControlsController(harness.host, firstTarget);
    const second = new NativeCallControlsController(harness.host, secondTarget);

    first.start();
    second.start();
    await vi.waitFor(() => expect(harness.host.onTrayAction).toHaveBeenCalledOnce());

    harness.emitPushToTalk('pressed');
    harness.emitTray('toggle-mute');
    expect(firstTarget.setPushToTalkPressed).not.toHaveBeenCalledWith(true);
    expect(firstTarget.toggleMute).not.toHaveBeenCalled();
    expect(secondTarget.setPushToTalkPressed).toHaveBeenCalledWith(true);
    expect(secondTarget.toggleMute).toHaveBeenCalledOnce();
    expect(harness.host.registerPushToTalk).toHaveBeenCalledOnce();

    second.stop();
    harness.emitTray('toggle-deafen');
    expect(firstTarget.toggleDeafen).toHaveBeenCalledOnce();
    expect(secondTarget.toggleDeafen).not.toHaveBeenCalled();
  });

  it('awaits delayed native cleanup before registering the next call', async () => {
    let finishUnregister!: () => void;
    const unregistering = new Promise<void>((resolve) => {
      finishUnregister = resolve;
    });
    const unregisterPushToTalk = vi.fn(() => unregistering);
    const host: NativeHost = {
      ...browserNativeHost,
      kind: 'tauri',
      capabilities: {
        ...browserNativeHost.capabilities,
        globalPushToTalk: true,
        tray: true
      },
      registerPushToTalk: vi.fn(async () => unregisterPushToTalk),
      onTrayAction: vi.fn(async () => async () => {}),
      setCallControls: vi.fn(async () => {})
    };
    const target = {
      snapshot: () => ({ connected: true, muted: true, deafened: false }),
      setPushToTalkPressed: vi.fn(async () => {}),
      toggleMute: vi.fn(async () => {}),
      toggleDeafen: vi.fn(async () => {})
    };
    const first = new NativeCallControlsController(host, target);
    const second = new NativeCallControlsController(host, target);

    first.start();
    await vi.waitFor(() => expect(host.registerPushToTalk).toHaveBeenCalledOnce());
    first.stop();
    await vi.waitFor(() => expect(unregisterPushToTalk).toHaveBeenCalledOnce());
    second.start();
    expect(host.registerPushToTalk).toHaveBeenCalledOnce();

    finishUnregister();
    await vi.waitFor(() => expect(host.registerPushToTalk).toHaveBeenCalledTimes(2));
  });
});
