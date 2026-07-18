import { browserNativeHost } from './browserHost';
import type { NativeHost, Unsubscribe } from './types';

let activeHost: NativeHost = browserNativeHost;

export function getNativeHost(): NativeHost {
  return activeHost;
}

export function selectNativeHost(desktopBuild: boolean, desktopHost: NativeHost): NativeHost {
  return desktopBuild ? desktopHost : browserNativeHost;
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
}
