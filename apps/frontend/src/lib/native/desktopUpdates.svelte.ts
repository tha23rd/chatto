import { getNativeHost } from './host';
import type { DesktopUpdateChannel, DesktopUpdateSnapshot, NativeHost, Unsubscribe } from './types';
import { userPreferences } from '$lib/state/userPreferences.svelte';

export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DESKTOP_UPDATE_SETUP_RETRY_MS = 60 * 1000;

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
  installing = $state(false);

  readonly #getHost: () => NativeHost;
  readonly #preferences: DesktopUpdatePreferences;
  #host: NativeHost | null = null;
  #initialized = false;
  #initializing: Promise<void> | null = null;
  #unsubscribe: Unsubscribe | null = null;
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #setupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #channelRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #resolveChannelRetry: (() => void) | null = null;
  #checkPromise: Promise<DesktopUpdateSnapshot> | null = null;
  #channelMutation: Promise<DesktopUpdateSnapshot> | null = null;
  #requestedChannel: DesktopUpdateChannel | null = null;
  #nativeChannel: DesktopUpdateChannel | null = null;
  #installPromise: Promise<void> | null = null;
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

    this.#clearSetupRetryTimer();
    const lifecycle = this.#lifecycle;
    const initializing = this.#initialize(lifecycle).finally(() => {
      if (this.#initializing === initializing) this.#initializing = null;
    });
    this.#initializing = initializing;
    return initializing;
  }

  async #initialize(lifecycle: number): Promise<void> {
    const host = this.#getHost();
    if (lifecycle !== this.#lifecycle) return;
    this.#host = host;

    if (!host.capabilities.desktopUpdates) {
      this.snapshot = {
        ...initialSnapshot,
        channel: this.#preferences.desktopUpdateChannel
      };
      this.#initialized = true;
      return;
    }

    let setupUnsubscribe: Unsubscribe | null = null;
    try {
      setupUnsubscribe = await host.onDesktopUpdateState((snapshot) => {
        this.#handleNativeSnapshot(snapshot, lifecycle, host);
      });
      if (lifecycle !== this.#lifecycle) {
        await this.#safelyUnsubscribe(setupUnsubscribe);
        return;
      }
      this.#unsubscribe = setupUnsubscribe;

      const channelSnapshot = await host.setDesktopUpdateChannel(
        this.#preferences.desktopUpdateChannel
      );
      if (lifecycle !== this.#lifecycle) return;
      this.#nativeChannel = channelSnapshot.channel;
      this.#handleNativeSnapshot(channelSnapshot, lifecycle, host);

      await this.#runCheck(lifecycle, host);
      if (lifecycle !== this.#lifecycle) return;
      this.#startCheckTimer(lifecycle, host);
      this.#initialized = true;
    } catch {
      if (lifecycle !== this.#lifecycle) return;
      if (setupUnsubscribe && this.#unsubscribe === setupUnsubscribe) {
        this.#unsubscribe = null;
        await this.#safelyUnsubscribe(setupUnsubscribe);
        if (lifecycle !== this.#lifecycle || host !== this.#host) return;
      }
      this.#initialized = false;
      this.#recordUnavailableFailure(lifecycle, host);
      this.#scheduleSetupRetry(lifecycle);
    }
  }

  /** Stop timers and native events when the root layout is unmounted. */
  async destroy(): Promise<void> {
    ++this.#lifecycle;
    this.#initialized = false;
    this.#initializing = null;
    this.#checkPromise = null;
    this.#channelMutation = null;
    this.#requestedChannel = null;
    this.#nativeChannel = null;
    this.#host = null;
    if (this.#checkTimer !== null) {
      clearInterval(this.#checkTimer);
      this.#checkTimer = null;
    }
    this.#clearSetupRetryTimer();
    this.#clearChannelRetryTimer();
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    if (unsubscribe) await this.#safelyUnsubscribe(unsubscribe);
  }

  /** Check immediately without allowing a second overlapping native request. */
  checkNow(): Promise<DesktopUpdateSnapshot> {
    if (!this.#initialized) {
      return this.initialize().then(() => this.snapshot);
    }
    return this.#runCheck(this.#lifecycle, this.#host);
  }

  /** Install the ready update after an explicit user action, with one process-wide request. */
  installNow(): Promise<void> {
    if (this.#installPromise) return this.#installPromise;

    const host = this.#host;
    if (!host?.capabilities.desktopUpdates || !this.snapshot.supported) {
      return Promise.reject(new Error('Desktop updates are unavailable'));
    }
    if (this.snapshot.phase !== 'ready' || !this.snapshot.candidateVersion) {
      return Promise.reject(new Error('No desktop update is ready to install'));
    }

    this.installing = true;
    let nativeInstall: Promise<void>;
    try {
      nativeInstall = host.installDesktopUpdate();
    } catch (error) {
      this.installing = false;
      return Promise.reject(error);
    }
    const installing = nativeInstall.finally(() => {
      if (this.#installPromise === installing) {
        this.#installPromise = null;
        this.installing = false;
      }
    });
    this.#installPromise = installing;
    return installing;
  }

  /** Apply the latest channel selection natively before persisting and presenting it. */
  setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateSnapshot> {
    this.#requestedChannel = channel;

    const lifecycle = this.#lifecycle;
    const previousMutation = this.#channelMutation;
    const operation = (previousMutation ?? Promise.resolve(this.snapshot))
      .catch(() => this.snapshot)
      .then(() => this.#reconcileSelectedChannel(lifecycle))
      .finally(() => {
        if (this.#channelMutation === operation) this.#channelMutation = null;
      });
    this.#channelMutation = operation;
    return operation;
  }

  async #reconcileSelectedChannel(lifecycle: number): Promise<DesktopUpdateSnapshot> {
    while (lifecycle === this.#lifecycle && this.#requestedChannel !== null) {
      await this.initialize();
      if (lifecycle !== this.#lifecycle) return this.snapshot;
      const host = this.#host;
      if (!host?.capabilities.desktopUpdates) return this.snapshot;

      const activeCheck = this.#checkPromise;
      if (activeCheck) await activeCheck;
      if (lifecycle !== this.#lifecycle || host !== this.#host) return this.snapshot;

      const selectedChannel = this.#requestedChannel;
      if (selectedChannel === null) return this.snapshot;
      if (
        selectedChannel === this.#preferences.desktopUpdateChannel &&
        selectedChannel === this.#nativeChannel
      ) {
        this.#requestedChannel = null;
        return this.snapshot;
      }

      let channelSnapshot: DesktopUpdateSnapshot;
      try {
        channelSnapshot = await host.setDesktopUpdateChannel(selectedChannel);
      } catch {
        if (lifecycle !== this.#lifecycle || host !== this.#host) return this.snapshot;
        if (selectedChannel !== this.#requestedChannel) continue;
        await this.#waitForChannelRetry(lifecycle);
        continue;
      }
      if (lifecycle !== this.#lifecycle || host !== this.#host) return this.snapshot;
      this.#nativeChannel = channelSnapshot.channel;

      // A newer selection may have arrived while the native request was in flight.
      // Leave the accepted presentation untouched and immediately converge again.
      if (selectedChannel !== this.#requestedChannel) continue;
      if (channelSnapshot.channel !== selectedChannel) {
        await this.#waitForChannelRetry(lifecycle);
        continue;
      }

      this.#preferences.desktopUpdateChannel = selectedChannel;
      this.#requestedChannel = null;
      this.#handleNativeSnapshot(channelSnapshot, lifecycle, host);
      await this.#runCheck(lifecycle, host);
    }
    return this.snapshot;
  }

  #handleNativeSnapshot(
    snapshot: DesktopUpdateSnapshot,
    lifecycle: number,
    host: NativeHost
  ): void {
    if (lifecycle !== this.#lifecycle || host !== this.#host) return;
    if (!host.capabilities.desktopUpdates) return;
    if (snapshot.channel !== this.#preferences.desktopUpdateChannel) return;
    this.snapshot = snapshot;
  }

  #startCheckTimer(lifecycle: number, host: NativeHost): void {
    if (this.#checkTimer !== null) return;
    this.#checkTimer = setInterval(() => {
      if (lifecycle !== this.#lifecycle || host !== this.#host) return;
      void this.#runCheck(lifecycle, host);
    }, DESKTOP_UPDATE_CHECK_INTERVAL_MS);
  }

  #runCheck(lifecycle: number, host: NativeHost | null): Promise<DesktopUpdateSnapshot> {
    if (lifecycle !== this.#lifecycle || host !== this.#host) {
      return Promise.resolve(this.snapshot);
    }
    if (this.#checkPromise) return this.#checkPromise;
    if (!host?.capabilities.desktopUpdates) return Promise.resolve(this.snapshot);

    const checking = host
      .checkForDesktopUpdate()
      .then((snapshot) => {
        this.#handleNativeSnapshot(snapshot, lifecycle, host);
        return this.snapshot;
      })
      .catch(() => {
        this.#recordUnavailableFailure(lifecycle, host);
        return this.snapshot;
      })
      .finally(() => {
        if (this.#checkPromise === checking) this.#checkPromise = null;
      });
    this.#checkPromise = checking;
    return checking;
  }

  #recordUnavailableFailure(lifecycle: number, host: NativeHost): void {
    if (lifecycle !== this.#lifecycle || host !== this.#host) return;
    this.snapshot = {
      supported: host.capabilities.desktopUpdates,
      channel: this.#preferences.desktopUpdateChannel,
      phase: 'failed',
      currentVersion: this.snapshot.currentVersion,
      lastCheckedAt: this.snapshot.lastCheckedAt,
      errorCode: 'unavailable'
    };
  }

  #scheduleSetupRetry(lifecycle: number): void {
    if (this.#setupRetryTimer !== null || lifecycle !== this.#lifecycle) return;
    this.#setupRetryTimer = setTimeout(() => {
      this.#setupRetryTimer = null;
      if (lifecycle !== this.#lifecycle || this.#initialized) return;
      void this.initialize();
    }, DESKTOP_UPDATE_SETUP_RETRY_MS);
  }

  #clearSetupRetryTimer(): void {
    if (this.#setupRetryTimer === null) return;
    clearTimeout(this.#setupRetryTimer);
    this.#setupRetryTimer = null;
  }

  #waitForChannelRetry(lifecycle: number): Promise<void> {
    if (lifecycle !== this.#lifecycle) return Promise.resolve();
    if (this.#channelRetryTimer !== null) {
      return new Promise((resolve) => {
        const existingResolve = this.#resolveChannelRetry;
        this.#resolveChannelRetry = () => {
          existingResolve?.();
          resolve();
        };
      });
    }

    return new Promise((resolve) => {
      const finish = () => {
        if (this.#channelRetryTimer !== null) clearTimeout(this.#channelRetryTimer);
        this.#channelRetryTimer = null;
        this.#resolveChannelRetry = null;
        resolve();
      };
      this.#resolveChannelRetry = finish;
      this.#channelRetryTimer = setTimeout(finish, DESKTOP_UPDATE_SETUP_RETRY_MS);
    });
  }

  #clearChannelRetryTimer(): void {
    this.#resolveChannelRetry?.();
  }

  async #safelyUnsubscribe(unsubscribe: Unsubscribe): Promise<void> {
    try {
      await unsubscribe();
    } catch {
      // Cleanup failures must not disable update retries or block application teardown.
    }
  }
}

export const desktopUpdates = new DesktopUpdatesCoordinator();
