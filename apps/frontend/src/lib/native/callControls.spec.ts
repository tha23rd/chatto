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
    expect(harness.host.setCallControls).toHaveBeenLastCalledWith({
      connected: true,
      muted: false,
      deafened: true
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
    expect(harness.unsubscribePushToTalk).toHaveBeenCalledOnce();
    expect(harness.unsubscribeTray).toHaveBeenCalledOnce();
    expect(harness.host.setCallControls).toHaveBeenLastCalledWith({
      connected: false,
      muted: false,
      deafened: false
    });
  });
});
