import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import { PUSH_TO_TALK_ACCELERATOR } from './callControls';
import {
  assertAllowedExternalUrl,
  assertAllowedHttpEndpoint,
  assertAllowedRealtimeUrl,
  assertAllowedServerUrl
} from './urlPolicy';
import { createTauriRealtimeSocket } from './tauriRealtimeSocket';
import { NATIVE_HOST_API_VERSION, type DesktopUpdateSnapshot, type NativeHost } from './types';

type NativeFetchOptions = RequestInit & { maxRedirections?: number };

export interface TauriHostBindings {
  readonly fetch: (input: RequestInfo | URL, init?: NativeFetchOptions) => Promise<Response>;
  readonly openUrl: (url: string) => Promise<void>;
  readonly createRealtimeSocket: NativeHost['createRealtimeSocket'];
  readonly startServerOAuth: NativeHost['startServerOAuth'];
  readonly registerPushToTalk: NativeHost['registerPushToTalk'];
  readonly onTrayAction: NativeHost['onTrayAction'];
  readonly setCallControls: NativeHost['setCallControls'];
  readonly setTaskbarAttention: (active: boolean) => Promise<void>;
  readonly getDesktopUpdateState: NativeHost['getDesktopUpdateState'];
  readonly setDesktopUpdateChannel: NativeHost['setDesktopUpdateChannel'];
  readonly checkForDesktopUpdate: NativeHost['checkForDesktopUpdate'];
  readonly installDesktopUpdate: NativeHost['installDesktopUpdate'];
  readonly onDesktopUpdateState: NativeHost['onDesktopUpdateState'];
  readonly quit: NativeHost['quit'];
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function realtimeServerOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}

/** Build the desktop adapter from narrow Tauri plugin bindings. */
export function createTauriNativeHost(bindings: TauriHostBindings): NativeHost {
  const allowedOrigins = new Map<string, number>();

  const requireRegisteredOrigin = (origin: string): void => {
    if (!allowedOrigins.has(origin)) {
      throw new Error('Server origin is not registered.');
    }
  };

  return {
    apiVersion: NATIVE_HOST_API_VERSION,
    kind: 'tauri',
    capabilities: {
      nativeOAuth: true,
      nativeHttp: true,
      nativeRealtime: true,
      globalPushToTalk: true,
      tray: true,
      appBadge: true,
      desktopUpdates: true,
      managedVideoPopOut: true
    },

    registerServerOrigin(value) {
      const origin = assertAllowedServerUrl(value);
      allowedOrigins.set(origin, (allowedOrigins.get(origin) ?? 0) + 1);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const references = allowedOrigins.get(origin) ?? 0;
        if (references <= 1) allowedOrigins.delete(origin);
        else allowedOrigins.set(origin, references - 1);
      };
    },

    async fetch(input, init) {
      const endpoint = assertAllowedHttpEndpoint(requestUrl(input));
      const origin = new URL(endpoint).origin;
      requireRegisteredOrigin(origin);
      const response = await bindings.fetch(
        typeof input === 'string' || input instanceof URL ? endpoint : input,
        { ...init, maxRedirections: 0 }
      );
      if (response.url) {
        const responseEndpoint = assertAllowedHttpEndpoint(response.url);
        if (new URL(responseEndpoint).origin !== origin) {
          void response.body?.cancel().catch(() => {});
          throw new Error('HTTP redirect left the registered server origin.');
        }
      }
      return response;
    },

    createRealtimeSocket(url) {
      const endpoint = assertAllowedRealtimeUrl(url);
      requireRegisteredOrigin(realtimeServerOrigin(endpoint));
      return bindings.createRealtimeSocket(endpoint);
    },

    async startServerOAuth(request) {
      const serverUrl = assertAllowedServerUrl(request.serverUrl);
      requireRegisteredOrigin(serverUrl);
      return bindings.startServerOAuth({ ...request, serverUrl });
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

    setAppBadge(intent) {
      return bindings.setTaskbarAttention(intent.kind !== 'clear');
    },

    getDesktopUpdateState() {
      return bindings.getDesktopUpdateState();
    },

    setDesktopUpdateChannel(channel) {
      return bindings.setDesktopUpdateChannel(channel);
    },

    checkForDesktopUpdate() {
      return bindings.checkForDesktopUpdate();
    },

    installDesktopUpdate() {
      return bindings.installDesktopUpdate();
    },

    onDesktopUpdateState(listener) {
      return bindings.onDesktopUpdateState(listener);
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
    let unregistering: Promise<void> | null = null;
    return async () => {
      if (!registered) return;
      unregistering ??= unregister(accelerator);
      try {
        await unregistering;
        registered = false;
      } finally {
        unregistering = null;
      }
    };
  },
  onTrayAction: (listener) =>
    listen<string>('native://tray-action', ({ payload }) => {
      if (payload === 'show' || payload === 'toggle-mute' || payload === 'toggle-deafen') {
        listener(payload);
      }
    }),
  setCallControls: (controls) => invoke('set_call_controls', { controls }),
  setTaskbarAttention: (active) => invoke('set_taskbar_attention', { active }),
  getDesktopUpdateState: () => invoke<DesktopUpdateSnapshot>('get_desktop_update_state'),
  setDesktopUpdateChannel: (channel) =>
    invoke<DesktopUpdateSnapshot>('set_desktop_update_channel', { channel }),
  checkForDesktopUpdate: () => invoke<DesktopUpdateSnapshot>('check_for_desktop_update'),
  installDesktopUpdate: () => invoke('install_desktop_update'),
  onDesktopUpdateState: (listener) =>
    listen<DesktopUpdateSnapshot>('native://desktop-update-state', ({ payload }) => {
      listener(payload);
    }),
  quit: () => invoke('quit_desktop')
});
