import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectTransport } from '@connectrpc/connect-web';
import { browserNativeHost } from '$lib/native/browserHost';
import { installNativeHost, resetNativeHostForTests } from '$lib/native/host';
import type { NativeHost } from '$lib/native/types';
import { createChattoTransport } from './connect';

vi.mock('@connectrpc/connect-web', () => ({
  createConnectTransport: vi.fn(() => ({ kind: 'transport' }))
}));

afterEach(() => {
  resetNativeHostForTests();
  vi.mocked(createConnectTransport).mockClear();
});

describe('createChattoTransport', () => {
  it('keeps browser transports on the standard fetch implementation', () => {
    createChattoTransport({ baseUrl: 'https://chatto.example/api/connect' });

    expect(createConnectTransport).toHaveBeenCalledWith({
      baseUrl: 'https://chatto.example/api/connect',
      useBinaryFormat: true
    });
  });

  it('uses the native HTTP adapter when the installed host supports it', async () => {
    const nativeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const desktopHost: NativeHost = {
      ...browserNativeHost,
      kind: 'tauri',
      capabilities: {
        ...browserNativeHost.capabilities,
        nativeHttp: true
      },
      fetch: nativeFetch
    };
    installNativeHost(desktopHost);

    createChattoTransport({ baseUrl: 'https://chatto.example/api/connect' });

    const options = vi.mocked(createConnectTransport).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      baseUrl: 'https://chatto.example/api/connect',
      useBinaryFormat: true,
      fetch: expect.any(Function)
    });

    await options?.fetch?.('https://chatto.example/api/connect/test');
    expect(nativeFetch).toHaveBeenCalledWith('https://chatto.example/api/connect/test', undefined);
  });
});
