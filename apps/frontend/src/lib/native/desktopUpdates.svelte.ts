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

  readonly #getHost: () => NativeHost;
  readonly #preferences: DesktopUpdatePreferences;
  #host: NativeHost | null = null;
  #initialized = false;
  #initializing: Promise<void> | null = null;
  #unsubscribe: Unsubscribe | null = null;
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #setupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #checkPromise: Promise<DesktopUpdateSnapshot> | null = null;
  #channelMutation: Promise<DesktopUpdateSnapshot> | null = null;
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
    this.#host = null;
    if (this.#checkTimer !== null) {
      clearInterval(this.#checkTimer);
      this.#checkTimer = null;
    }
    this.#clearSetupRetryTimer();
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

  /** Persist a channel selection, discard stale presentation, and re-check it. */
  setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateSnapshot> {
    this.#preferences.desktopUpdateChannel = channel;
    this.snapshot = {
      supported: this.snapshot.supported,
      channel,
      phase: 'idle',
      currentVersion: this.snapshot.currentVersion,
      lastCheckedAt: this.snapshot.lastCheckedAt
    };

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
    if (lifecycle !== this.#lifecycle) return this.snapshot;
    const alreadyStarted = this.#initialized || this.#initializing !== null;
    await this.initialize();
    if (lifecycle !== this.#lifecycle) return this.snapshot;
    const host = this.#host;
    if (!host?.capabilities.desktopUpdates) return this.snapshot;
    if (!alreadyStarted) return this.snapshot;

    const selectedChannel = this.#preferences.desktopUpdateChannel;
    try {
      const channelSnapshot = await host.setDesktopUpdateChannel(selectedChannel);
      if (lifecycle !== this.#lifecycle || host !== this.#host) return this.snapshot;
      if (selectedChannel !== this.#preferences.desktopUpdateChannel) return this.snapshot;
      this.#handleNativeSnapshot(channelSnapshot, lifecycle, host);
    } catch {
      if (
        lifecycle === this.#lifecycle &&
        host === this.#host &&
        selectedChannel === this.#preferences.desktopUpdateChannel
      ) {
        this.#recordUnavailableFailure(lifecycle, host);
      }
      return this.snapshot;
    }

    const previousCheck = this.#checkPromise;
    if (previousCheck) await previousCheck;
    if (
      lifecycle !== this.#lifecycle ||
      host !== this.#host ||
      selectedChannel !== this.#preferences.desktopUpdateChannel
    ) {
      return this.snapshot;
    }
    return this.#runCheck(lifecycle, host);
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

  async #safelyUnsubscribe(unsubscribe: Unsubscribe): Promise<void> {
    try {
      await unsubscribe();
    } catch {
      // Cleanup failures must not disable update retries or block application teardown.
    }
  }
}

export const desktopUpdates = new DesktopUpdatesCoordinator();
