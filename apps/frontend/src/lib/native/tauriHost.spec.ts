import { describe, expect, it, vi } from 'vitest';
import { createTauriNativeHost } from './tauriHost';

function bindings() {
  return {
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
    openUrl: vi.fn(async () => {}),
    createRealtimeSocket: vi.fn(),
    startServerOAuth: vi.fn()
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
      globalPushToTalk: false,
      tray: false
    });
  });

  it('routes allowed HTTPS and loopback requests through the Rust HTTP plugin', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);

    await host.fetch('https://chatto.example/api/connect');
    await host.fetch('http://127.0.0.1:8080/api/connect');

    expect(native.fetch).toHaveBeenNthCalledWith(
      1,
      'https://chatto.example/api/connect',
      undefined
    );
    expect(native.fetch).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8080/api/connect', undefined);
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
