import { assertAllowedExternalUrl } from './urlPolicy';
import {
  NATIVE_HOST_API_VERSION,
  type NativeHost,
  type RealtimeSocketLike
} from './types';

const unsupported = (capability: string): Error =>
  new Error(`${capability} is unavailable in this client.`);

export const browserNativeHost: NativeHost = {
  apiVersion: NATIVE_HOST_API_VERSION,
  kind: 'browser',
  capabilities: {
    nativeOAuth: false,
    nativeHttp: false,
    nativeRealtime: false,
    globalPushToTalk: false,
    tray: false
  },

  registerServerOrigin() {
    return () => {};
  },

  fetch(input, init) {
    return globalThis.fetch(input, init);
  },

  createRealtimeSocket(url) {
    return new WebSocket(url) as RealtimeSocketLike;
  },

  async startServerOAuth() {
    throw unsupported('Native OAuth');
  },

  async openExternal(url) {
    const allowedUrl = assertAllowedExternalUrl(url);
    window.open(allowedUrl, '_blank', 'noopener,noreferrer');
  },

  async registerPushToTalk() {
    throw unsupported('Global push-to-talk');
  },

  async onTrayAction() {
    return () => {};
  },

  async setCallControls() {},

  async quit() {}
};
