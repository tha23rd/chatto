import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import { assertAllowedExternalUrl, assertAllowedHttpEndpoint } from './urlPolicy';
import { createTauriRealtimeSocket } from './tauriRealtimeSocket';
import { NATIVE_HOST_API_VERSION, type NativeHost } from './types';

type NativeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TauriHostBindings {
  readonly fetch: NativeFetch;
  readonly openUrl: (url: string) => Promise<void>;
  readonly createRealtimeSocket: NativeHost['createRealtimeSocket'];
}

const unsupported = (capability: string): Error =>
  new Error(`${capability} is unavailable in this client.`);

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
      nativeOAuth: false,
      nativeHttp: true,
      nativeRealtime: true,
      globalPushToTalk: false,
      tray: false
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

    async startServerOAuth() {
      throw unsupported('Native OAuth');
    },

    async openExternal(url) {
      await bindings.openUrl(assertAllowedExternalUrl(url));
    },

    async registerPushToTalk() {
      throw unsupported('Global push-to-talk');
    },

    async onTrayAction() {
      return () => {};
    },

    async setCallControls() {},

    async quit() {
      throw unsupported('Native quit');
    }
  };
}

export const tauriNativeHost = createTauriNativeHost({
  fetch: tauriFetch,
  openUrl,
  createRealtimeSocket: createTauriRealtimeSocket
});
