import { browserNativeHost } from './browserHost';
import type { NativeHost, Unsubscribe } from './types';

let activeHost: NativeHost = browserNativeHost;
let initializationPromise: Promise<NativeHost> | null = null;

export type NativeHostLoader = () => Promise<NativeHost>;

const loadTauriNativeHost: NativeHostLoader = async () =>
  (await import('./tauriHost')).tauriNativeHost;

export function getNativeHost(): NativeHost {
  return activeHost;
}

export function selectNativeHost(desktopBuild: boolean, desktopHost: NativeHost): NativeHost {
  return desktopBuild ? desktopHost : browserNativeHost;
}

/** Select the platform adapter before startup performs any server I/O. */
export function initializeNativeHost(
  desktopBuild = import.meta.env.VITE_CHATTO_DESKTOP === '1',
  loadDesktopHost: NativeHostLoader = loadTauriNativeHost
): Promise<NativeHost> {
  if (!desktopBuild) {
    activeHost = browserNativeHost;
    return Promise.resolve(activeHost);
  }
  if (activeHost.kind === 'tauri') return Promise.resolve(activeHost);

  initializationPromise ??= loadDesktopHost()
    .then((desktopHost) => {
      activeHost = selectNativeHost(true, desktopHost);
      return activeHost;
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
  activeHost = host;
  return () => {
    if (activeHost === host) activeHost = previous;
  };
}

export function resetNativeHostForTests(): void {
  activeHost = browserNativeHost;
  initializationPromise = null;
}
