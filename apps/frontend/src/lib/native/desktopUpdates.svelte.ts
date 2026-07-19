import { getNativeHost } from './host';
import type { DesktopUpdateChannel, DesktopUpdateSnapshot, NativeHost, Unsubscribe } from './types';
import { userPreferences } from '$lib/state/userPreferences.svelte';

export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface DesktopUpdatePreferences {
  desktopUpdateChannel: DesktopUpdateChannel;
}

const initialSnapshot: DesktopUpdateSnapshot = {
  supported: false,
  channel: 'stable',
  phase: 'idle',
  currentVersion: ''
};

/** Coordinates update presentation and scheduling across the native host boundary. */
export class DesktopUpdatesCoordinator {
  snapshot = $state.raw<DesktopUpdateSnapshot>(initialSnapshot);

  readonly #getHost: () => NativeHost;
  readonly #preferences: DesktopUpdatePreferences;
  #host: NativeHost | null = null;
  #initialized = false;
  #initializing: Promise<void> | null = null;
  #unsubscribe: Unsubscribe | null = null;
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkPromise: Promise<DesktopUpdateSnapshot> | null = null;
  #lifecycle = 0;

  constructor(
    getHost: () => NativeHost = getNativeHost,
    preferences: DesktopUpdatePreferences = userPreferences
  ) {
    this.#getHost = getHost;
    this.#preferences = preferences;
  }

  /** Subscribe and start background checks once the root layout is mounted. */
  initialize(): Promise<void> {
    if (this.#initialized) return Promise.resolve();
    if (this.#initializing) return this.#initializing;

    const lifecycle = ++this.#lifecycle;
    const initializing = this.#initialize(lifecycle).finally(() => {
      if (this.#initializing === initializing) this.#initializing = null;
    });
    this.#initializing = initializing;
    return initializing;
  }

  async #initialize(lifecycle: number): Promise<void> {
    const host = this.#getHost();
    this.#host = host;

    if (!host.capabilities.desktopUpdates) {
      this.snapshot = {
        ...initialSnapshot,
        channel: this.#preferences.desktopUpdateChannel
      };
      this.#initialized = true;
      return;
    }

    try {
      const unsubscribe = await host.onDesktopUpdateState(this.#handleNativeSnapshot);
      if (lifecycle !== this.#lifecycle) {
        await unsubscribe();
        return;
      }
      this.#unsubscribe = unsubscribe;

      const channelSnapshot = await host.setDesktopUpdateChannel(
        this.#preferences.desktopUpdateChannel
      );
      if (lifecycle !== this.#lifecycle) return;
      this.#handleNativeSnapshot(channelSnapshot);

      await this.#runCheck();
      if (lifecycle !== this.#lifecycle) return;
      this.#startCheckTimer();
    } catch {
      this.#recordUnavailableFailure();
    } finally {
      if (lifecycle === this.#lifecycle) this.#initialized = true;
    }
  }

  /** Stop timers and native events when the root layout is unmounted. */
  async destroy(): Promise<void> {
    ++this.#lifecycle;
    this.#initialized = false;
    this.#host = null;
    if (this.#checkTimer !== null) {
      clearInterval(this.#checkTimer);
      this.#checkTimer = null;
    }
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    if (unsubscribe) await unsubscribe();
  }

  /** Check immediately without allowing a second overlapping native request. */
  checkNow(): Promise<DesktopUpdateSnapshot> {
    if (!this.#initialized) {
      return this.initialize().then(() => this.snapshot);
    }
    return this.#runCheck();
  }

  /** Persist a channel selection, discard stale presentation, and re-check it. */
  async setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateSnapshot> {
    this.#preferences.desktopUpdateChannel = channel;
    this.snapshot = {
      supported: this.snapshot.supported,
      channel,
      phase: 'idle',
      currentVersion: this.snapshot.currentVersion,
      lastCheckedAt: this.snapshot.lastCheckedAt
    };

    const alreadyStarted = this.#initialized || this.#initializing !== null;
    await this.initialize();
    const host = this.#host;
    if (!host?.capabilities.desktopUpdates) return this.snapshot;
    if (!alreadyStarted) return this.snapshot;

    try {
      const channelSnapshot = await host.setDesktopUpdateChannel(channel);
      this.#handleNativeSnapshot(channelSnapshot);
    } catch {
      this.#recordUnavailableFailure();
      return this.snapshot;
    }

    const previousCheck = this.#checkPromise;
    if (previousCheck) await previousCheck;
    return this.#runCheck();
  }

  #handleNativeSnapshot = (snapshot: DesktopUpdateSnapshot): void => {
    if (!this.#host?.capabilities.desktopUpdates) return;
    if (snapshot.channel !== this.#preferences.desktopUpdateChannel) return;
    this.snapshot = snapshot;
  };

  #handleCheckTimer = (): void => {
    void this.#runCheck();
  };

  #startCheckTimer(): void {
    if (this.#checkTimer !== null) return;
    this.#checkTimer = setInterval(this.#handleCheckTimer, DESKTOP_UPDATE_CHECK_INTERVAL_MS);
  }

  #runCheck(): Promise<DesktopUpdateSnapshot> {
    if (this.#checkPromise) return this.#checkPromise;
    const host = this.#host;
    if (!host?.capabilities.desktopUpdates) return Promise.resolve(this.snapshot);

    const checking = host
      .checkForDesktopUpdate()
      .then((snapshot) => {
        this.#handleNativeSnapshot(snapshot);
        return this.snapshot;
      })
      .catch(() => {
        this.#recordUnavailableFailure();
        return this.snapshot;
      })
      .finally(() => {
        if (this.#checkPromise === checking) this.#checkPromise = null;
      });
    this.#checkPromise = checking;
    return checking;
  }

  #recordUnavailableFailure(): void {
    this.snapshot = {
      supported: this.#host?.capabilities.desktopUpdates ?? false,
      channel: this.#preferences.desktopUpdateChannel,
      phase: 'failed',
      currentVersion: this.snapshot.currentVersion,
      lastCheckedAt: this.snapshot.lastCheckedAt,
      errorCode: 'unavailable'
    };
  }
}

export const desktopUpdates = new DesktopUpdatesCoordinator();
