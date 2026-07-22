import { browserNativeHost } from './browserHost';
import { registerAppBadgeHandler } from '$lib/notifications/appBadge';
import type { NativeHost, Unsubscribe } from './types';

let activeHost: NativeHost = browserNativeHost;
let initializationPromise: Promise<NativeHost> | null = null;
let unregisterAppBadgeHandler: (() => void) | null = null;

export type NativeHostLoader = () => Promise<NativeHost>;

const loadTauriNativeHost: NativeHostLoader = async () =>
  (await import('./tauriHost')).tauriNativeHost;

export function getNativeHost(): NativeHost {
  return activeHost;
}

export function selectNativeHost(desktopBuild: boolean, desktopHost: NativeHost): NativeHost {
  return desktopBuild ? desktopHost : browserNativeHost;
}

function activateNativeHost(host: NativeHost): NativeHost {
  unregisterAppBadgeHandler?.();
  unregisterAppBadgeHandler = null;
  activeHost = host;
  if (host.capabilities.appBadge) {
    unregisterAppBadgeHandler = registerAppBadgeHandler((intent) => host.setAppBadge(intent));
  }
  return activeHost;
}

/** Select the platform adapter before startup performs any server I/O. */
export function initializeNativeHost(
  desktopBuild = import.meta.env.VITE_CHATTO_DESKTOP === '1',
  loadDesktopHost: NativeHostLoader = loadTauriNativeHost
): Promise<NativeHost> {
  if (!desktopBuild) {
    return Promise.resolve(activateNativeHost(browserNativeHost));
  }
  if (activeHost.kind === 'tauri') return Promise.resolve(activeHost);

  initializationPromise ??= loadDesktopHost()
    .then((desktopHost) => {
      return activateNativeHost(selectNativeHost(true, desktopHost));
    })
    .catch((error: unknown) => {
      initializationPromise = null;
      throw error;
    });

  return initializationPromise;
}

/** Install a host and return a scoped restore function for startup and tests. */
export function installNativeHost(host: NativeHost): Unsubscribe {
  const previous = activeHost;
  activateNativeHost(host);
  return () => {
    if (activeHost === host) activateNativeHost(previous);
  };
}

export function resetNativeHostForTests(): void {
  activateNativeHost(browserNativeHost);
  initializationPromise = null;
}
