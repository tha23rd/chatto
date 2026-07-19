import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { browserNativeHost } from './browserHost';
import {
  getNativeHost,
  initializeNativeHost,
  installNativeHost,
  resetNativeHostForTests,
  selectNativeHost
} from './host';
import type {
  DesktopUpdateChannel,
  DesktopUpdatePhase,
  DesktopUpdateSnapshot,
  NativeHost
} from './types';

function desktopHost(): NativeHost {
  return {
    ...browserNativeHost,
    kind: 'tauri',
    capabilities: {
      nativeOAuth: true,
      nativeHttp: true,
      nativeRealtime: true,
      globalPushToTalk: true,
      tray: true,
      desktopUpdates: true
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
    expect(browserNativeHost.apiVersion).toBe(2);
    expect(browserNativeHost.kind).toBe('browser');
    expect(Object.values(browserNativeHost.capabilities)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false
    ]);
  });

  it('exposes the exact desktop update channel and phase contract', () => {
    expectTypeOf<DesktopUpdateChannel>().toEqualTypeOf<'stable' | 'nightly'>();
    expectTypeOf<DesktopUpdatePhase>().toEqualTypeOf<
      'idle' | 'checking' | 'downloading' | 'ready' | 'failed'
    >();

    const snapshots = [
      {
        supported: true,
        channel: 'stable',
        phase: 'idle',
        currentVersion: '0.1.0'
      },
      {
        supported: true,
        channel: 'nightly',
        phase: 'checking',
        currentVersion: '0.2.0-nightly.20260719.1',
        lastCheckedAt: '2026-07-19T12:00:00Z'
      },
      {
        supported: true,
        channel: 'stable',
        phase: 'downloading',
        currentVersion: '0.1.0',
        candidateVersion: '0.2.0',
        downloadedBytes: 1024,
        totalBytes: 4096
      },
      {
        supported: true,
        channel: 'stable',
        phase: 'ready',
        currentVersion: '0.1.0',
        candidateVersion: '0.2.0'
      },
      {
        supported: true,
        channel: 'stable',
        phase: 'failed',
        currentVersion: '0.1.0',
        errorCode: 'signature'
      }
    ] satisfies readonly DesktopUpdateSnapshot[];

    expect(snapshots.map(({ phase }) => phase)).toEqual([
      'idle',
      'checking',
      'downloading',
      'ready',
      'failed'
    ]);
    expectTypeOf<DesktopUpdateSnapshot['errorCode']>().toEqualTypeOf<
      'network' | 'metadata' | 'signature' | 'download' | 'install' | 'unavailable' | undefined
    >();
  });

  it('reports unsupported desktop updates and rejects browser update mutations', async () => {
    expect(browserNativeHost.capabilities.desktopUpdates).toBe(false);
    await expect(browserNativeHost.getDesktopUpdateState()).resolves.toEqual({
      supported: false,
      channel: 'stable',
      phase: 'idle',
      currentVersion: ''
    });

    const listener = vi.fn();
    const unsubscribe = await browserNativeHost.onDesktopUpdateState(listener);
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();

    await expect(browserNativeHost.setDesktopUpdateChannel('nightly')).rejects.toThrow(
      'Desktop updates is unavailable in this client.'
    );
    await expect(browserNativeHost.checkForDesktopUpdate()).rejects.toThrow(
      'Desktop updates is unavailable in this client.'
    );
    await expect(browserNativeHost.installDesktopUpdate()).rejects.toThrow(
      'Desktop updates is unavailable in this client.'
    );
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
