import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserNativeHost } from './browserHost';
import {
  getNativeHost,
  initializeNativeHost,
  installNativeHost,
  resetNativeHostForTests,
  selectNativeHost
} from './host';
import type { NativeHost } from './types';

function desktopHost(): NativeHost {
  return {
    ...browserNativeHost,
    kind: 'tauri',
    capabilities: {
      nativeOAuth: true,
      nativeHttp: true,
      nativeRealtime: true,
      globalPushToTalk: true,
      tray: true
    }
  };
}

afterEach(() => {
  resetNativeHostForTests();
  vi.unstubAllGlobals();
});

describe('NativeHost selection', () => {
  it('uses the capability-free browser host by default', () => {
    expect(getNativeHost()).toBe(browserNativeHost);
    expect(browserNativeHost.apiVersion).toBe(1);
    expect(browserNativeHost.kind).toBe('browser');
    expect(Object.values(browserNativeHost.capabilities)).toEqual([
      false,
      false,
      false,
      false,
      false
    ]);
  });

  it('selects a desktop host only for a desktop build', () => {
    const tauri = desktopHost();
    expect(selectNativeHost(false, tauri)).toBe(browserNativeHost);
    expect(selectNativeHost(true, tauri)).toBe(tauri);
  });

  it('installs and restores a host without platform globals', () => {
    const tauri = desktopHost();
    const restore = installNativeHost(tauri);
    expect(getNativeHost()).toBe(tauri);

    restore();
    expect(getNativeHost()).toBe(browserNativeHost);
  });

  it('loads and installs the desktop host before desktop startup continues', async () => {
    const tauri = desktopHost();
    const loadDesktopHost = vi.fn(async () => tauri);

    await expect(initializeNativeHost(true, loadDesktopHost)).resolves.toBe(tauri);
    expect(loadDesktopHost).toHaveBeenCalledOnce();
    expect(getNativeHost()).toBe(tauri);
  });

  it('does not load native bindings for an ordinary web build', async () => {
    const loadDesktopHost = vi.fn(async () => desktopHost());

    await expect(initializeNativeHost(false, loadDesktopHost)).resolves.toBe(browserNativeHost);
    expect(loadDesktopHost).not.toHaveBeenCalled();
  });

  it('opens HTTPS links through the browser implementation', async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('window', { open });
    await browserNativeHost.openExternal('https://chatto.example/docs');
    expect(open).toHaveBeenCalledWith(
      'https://chatto.example/docs',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
