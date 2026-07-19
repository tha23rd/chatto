import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import { PUSH_TO_TALK_ACCELERATOR } from './callControls';
import { assertAllowedExternalUrl, assertAllowedHttpEndpoint } from './urlPolicy';
import { createTauriRealtimeSocket } from './tauriRealtimeSocket';
import { NATIVE_HOST_API_VERSION, type NativeHost } from './types';

type NativeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TauriHostBindings {
  readonly fetch: NativeFetch;
  readonly openUrl: (url: string) => Promise<void>;
  readonly createRealtimeSocket: NativeHost['createRealtimeSocket'];
  readonly startServerOAuth: NativeHost['startServerOAuth'];
  readonly registerPushToTalk: NativeHost['registerPushToTalk'];
  readonly onTrayAction: NativeHost['onTrayAction'];
  readonly setCallControls: NativeHost['setCallControls'];
  readonly quit: NativeHost['quit'];
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Build the desktop adapter from narrow Tauri plugin bindings. */
export function createTauriNativeHost(bindings: TauriHostBindings): NativeHost {
  return {
    apiVersion: NATIVE_HOST_API_VERSION,
    kind: 'tauri',
    capabilities: {
      nativeOAuth: true,
      nativeHttp: true,
      nativeRealtime: true,
      globalPushToTalk: true,
      tray: true
    },

    async fetch(input, init) {
      const endpoint = assertAllowedHttpEndpoint(requestUrl(input));
      return bindings.fetch(
        typeof input === 'string' || input instanceof URL ? endpoint : input,
        init
      );
    },

    createRealtimeSocket(url) {
      return bindings.createRealtimeSocket(url);
    },

    startServerOAuth(request) {
      return bindings.startServerOAuth(request);
    },

    async openExternal(url) {
      await bindings.openUrl(assertAllowedExternalUrl(url));
    },

    registerPushToTalk(accelerator, listener) {
      return bindings.registerPushToTalk(accelerator, listener);
    },

    onTrayAction(listener) {
      return bindings.onTrayAction(listener);
    },

    setCallControls(controls) {
      return bindings.setCallControls(controls);
    },

    quit() {
      return bindings.quit();
    }
  };
}

export const tauriNativeHost = createTauriNativeHost({
  fetch: tauriFetch,
  openUrl,
  createRealtimeSocket: createTauriRealtimeSocket,
  startServerOAuth: (request) => invoke('start_server_oauth', { request }),
  registerPushToTalk: async (accelerator, listener) => {
    if (accelerator !== PUSH_TO_TALK_ACCELERATOR) {
      throw new Error('Global shortcut is not allowed.');
    }
    await register(accelerator, ({ state }) => {
      listener(state === 'Pressed' ? 'pressed' : 'released');
    });
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      void unregister(accelerator).catch(() => {});
    };
  },
  onTrayAction: (listener) =>
    listen<string>('native://tray-action', ({ payload }) => {
      if (payload === 'show' || payload === 'toggle-mute' || payload === 'toggle-deafen') {
        listener(payload);
      }
    }),
  setCallControls: (controls) => invoke('set_call_controls', { controls }),
  quit: () => invoke('quit_desktop')
});
