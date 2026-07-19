import { describe, expect, it, vi } from 'vitest';
import { createTauriNativeHost } from './tauriHost';

function bindings() {
  return {
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
    openUrl: vi.fn(async () => {}),
    createRealtimeSocket: vi.fn(),
    startServerOAuth: vi.fn(),
    registerPushToTalk: vi.fn(async () => () => {}),
    onTrayAction: vi.fn(async () => () => {}),
    setCallControls: vi.fn(async () => {}),
    quit: vi.fn(async () => {})
  };
}

describe('Tauri NativeHost', () => {
  it('advertises only the native capabilities implemented by the adapter', () => {
    const host = createTauriNativeHost(bindings());

    expect(host.kind).toBe('tauri');
    expect(host.capabilities).toEqual({
      nativeOAuth: true,
      nativeHttp: true,
      nativeRealtime: true,
      globalPushToTalk: true,
      tray: true
    });
  });

  it('routes global push-to-talk through the native shortcut binding', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    const listener = vi.fn();

    await host.registerPushToTalk('Control+Shift+Space', listener);

    expect(native.registerPushToTalk).toHaveBeenCalledWith('Control+Shift+Space', listener);
  });

  it('routes tray actions and lifecycle controls through typed native bindings', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    const listener = vi.fn();
    const controls = { connected: true, muted: false, deafened: true };

    await host.onTrayAction(listener);
    await host.setCallControls(controls);
    await host.quit();

    expect(native.onTrayAction).toHaveBeenCalledWith(listener);
    expect(native.setCallControls).toHaveBeenCalledWith(controls);
    expect(native.quit).toHaveBeenCalledOnce();
  });

  it('routes only registered HTTPS and loopback origins without following redirects', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    const releaseHttps = host.registerServerOrigin('https://chatto.example');
    host.registerServerOrigin('http://127.0.0.1:8080');

    await host.fetch('https://chatto.example/api/connect');
    await host.fetch('http://127.0.0.1:8080/api/connect');

    expect(native.fetch).toHaveBeenNthCalledWith(1, 'https://chatto.example/api/connect', {
      maxRedirections: 0
    });
    expect(native.fetch).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8080/api/connect', {
      maxRedirections: 0
    });

    releaseHttps();
    await expect(host.fetch('https://chatto.example/api/connect')).rejects.toThrow(
      'Server origin is not registered.'
    );
  });

  it('rejects unregistered HTTPS, WSS, and OAuth destinations', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);

    await expect(host.fetch('https://chatto.example/api/connect')).rejects.toThrow(
      'Server origin is not registered.'
    );
    expect(() => host.createRealtimeSocket('wss://chatto.example/api/realtime')).toThrow(
      'Server origin is not registered.'
    );
    await expect(
      host.startServerOAuth({
        serverUrl: 'https://chatto.example',
        authorizePath: '/oauth/authorize',
        codeChallenge: 'challenge',
        codeVerifier: 'verifier',
        state: 'state'
      })
    ).rejects.toThrow('Server origin is not registered.');
    expect(native.fetch).not.toHaveBeenCalled();
    expect(native.createRealtimeSocket).not.toHaveBeenCalled();
    expect(native.startServerOAuth).not.toHaveBeenCalled();
  });

  it('maps a registered HTTP origin to its realtime WebSocket origin', () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    host.registerServerOrigin('https://chatto.example:8443');

    host.createRealtimeSocket('wss://chatto.example:8443/api/realtime');

    expect(native.createRealtimeSocket).toHaveBeenCalledWith(
      'wss://chatto.example:8443/api/realtime'
    );
    expect(() => host.createRealtimeSocket('wss://other.example/api/realtime')).toThrow(
      'Server origin is not registered.'
    );
  });

  it('rejects unsafe HTTP destinations before invoking native code', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);

    await expect(host.fetch('http://chatto.example/private?token=secret')).rejects.toThrow(
      'HTTP endpoint is not allowed.'
    );
    expect(native.fetch).not.toHaveBeenCalled();
  });

  it('opens only allowed external URLs with the operating system', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);

    await host.openExternal('https://chatto.example/docs');
    expect(native.openUrl).toHaveBeenCalledWith('https://chatto.example/docs');

    await expect(host.openExternal('file:///C:/Windows/System32')).rejects.toThrow(
      'External URL is not allowed.'
    );
  });
});
