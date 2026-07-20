import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNativeHost } from './browserHost';
import {
  DesktopUpdatesCoordinator,
  DESKTOP_UPDATE_CHECK_INTERVAL_MS,
  DESKTOP_UPDATE_SETUP_RETRY_MS
} from './desktopUpdates.svelte';
import type { DesktopUpdateChannel, DesktopUpdateSnapshot, NativeHost, Unsubscribe } from './types';

const idleUpdate: DesktopUpdateSnapshot = {
  supported: true,
  channel: 'stable',
  phase: 'idle',
  currentVersion: '0.1.0'
};

interface TestPreferences {
  desktopUpdateChannel: DesktopUpdateChannel;
}

function createDesktopHost(overrides: Partial<NativeHost> = {}) {
  let updateListener: ((snapshot: DesktopUpdateSnapshot) => void) | undefined;
  const unsubscribe = vi.fn<Unsubscribe>();
  const host: NativeHost = {
    ...browserNativeHost,
    kind: 'tauri',
    capabilities: { ...browserNativeHost.capabilities, desktopUpdates: true },
    onDesktopUpdateState: vi.fn(async (listener) => {
      updateListener = listener;
      return unsubscribe;
    }),
    setDesktopUpdateChannel: vi.fn(async (channel) => ({ ...idleUpdate, channel })),
    checkForDesktopUpdate: vi.fn(async () => idleUpdate),
    ...overrides
  };

  return {
    host,
    unsubscribe,
    emit(snapshot: DesktopUpdateSnapshot) {
      updateListener?.(snapshot);
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfil, fail) => {
    resolve = fulfil;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('DesktopUpdatesCoordinator', () => {
  let coordinators: DesktopUpdatesCoordinator[] = [];

  function createCoordinator(host: NativeHost, preferences: TestPreferences) {
    const coordinator = new DesktopUpdatesCoordinator(() => host, preferences);
    coordinators.push(coordinator);
    return coordinator;
  }

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    await Promise.all(coordinators.map((coordinator) => coordinator.destroy()));
    coordinators = [];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('performs no update I/O when initialized with a browser host', async () => {
    const onState = vi.spyOn(browserNativeHost, 'onDesktopUpdateState');
    const setChannel = vi.spyOn(browserNativeHost, 'setDesktopUpdateChannel');
    const check = vi.spyOn(browserNativeHost, 'checkForDesktopUpdate');
    const preferences: TestPreferences = { desktopUpdateChannel: 'stable' };
    const coordinator = createCoordinator(browserNativeHost, preferences);

    await coordinator.initialize();

    expect(onState).not.toHaveBeenCalled();
    expect(setChannel).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(coordinator.snapshot.supported).toBe(false);
  });

  it('subscribes before applying the persisted channel and starting one background check', async () => {
    const calls: string[] = [];
    const desktop = createDesktopHost({
      onDesktopUpdateState: vi.fn(async () => {
        calls.push('subscribe');
        return () => {};
      }),
      setDesktopUpdateChannel: vi.fn(async (channel) => {
        calls.push(`channel:${channel}`);
        return { ...idleUpdate, channel };
      }),
      checkForDesktopUpdate: vi.fn(async () => {
        calls.push('check');
        return idleUpdate;
      })
    });
    const preferences: TestPreferences = { desktopUpdateChannel: 'nightly' };
    const coordinator = createCoordinator(desktop.host, preferences);

    await Promise.all([coordinator.initialize(), coordinator.initialize()]);
    await coordinator.initialize();

    expect(calls).toEqual(['subscribe', 'channel:nightly', 'check']);
  });

  it('keeps overlapping checks single-flight', async () => {
    const desktop = createDesktopHost();
    const coordinator = createCoordinator(desktop.host, {
      desktopUpdateChannel: 'stable'
    });
    await coordinator.initialize();
    const checkResult = deferred<DesktopUpdateSnapshot>();
    vi.mocked(desktop.host.checkForDesktopUpdate).mockImplementationOnce(() => checkResult.promise);

    const first = coordinator.checkNow();
    const overlapping = coordinator.checkNow();

    expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledTimes(2);
    checkResult.resolve(idleUpdate);
    await Promise.all([first, overlapping]);
    expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent install requests single-flight across the frontend', async () => {
    const nativeInstall = deferred<void>();
    const installDesktopUpdate = vi.fn<NativeHost['installDesktopUpdate']>(
      () => nativeInstall.promise
    );
    const desktop = createDesktopHost({ installDesktopUpdate });
    const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });
    await coordinator.initialize();
    desktop.emit({ ...idleUpdate, phase: 'ready', candidateVersion: '0.2.0' });

    const first = coordinator.installNow();
    const overlapping = coordinator.installNow();

    expect(coordinator.installing).toBe(true);
    expect(installDesktopUpdate).toHaveBeenCalledOnce();
    nativeInstall.resolve(undefined);
    await Promise.all([first, overlapping]);
    expect(coordinator.installing).toBe(false);
  });

  it('rejects install requests when desktop updates are unavailable', async () => {
    const installDesktopUpdate = vi.spyOn(browserNativeHost, 'installDesktopUpdate');
    const coordinator = createCoordinator(browserNativeHost, { desktopUpdateChannel: 'stable' });
    await coordinator.initialize();

    await expect(coordinator.installNow()).rejects.toThrow('Desktop updates are unavailable');

    expect(installDesktopUpdate).not.toHaveBeenCalled();
    expect(coordinator.installing).toBe(false);
  });

  it('rejects install requests until a candidate is ready', async () => {
    const installDesktopUpdate = vi.fn<NativeHost['installDesktopUpdate']>();
    const desktop = createDesktopHost({ installDesktopUpdate });
    const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });
    await coordinator.initialize();

    await expect(coordinator.installNow()).rejects.toThrow('No desktop update is ready to install');

    expect(installDesktopUpdate).not.toHaveBeenCalled();
    expect(coordinator.installing).toBe(false);
  });

  it('allows an explicit install retry after the native install rejects', async () => {
    const installDesktopUpdate = vi
      .fn<NativeHost['installDesktopUpdate']>()
      .mockRejectedValueOnce(new Error('native install failed'))
      .mockResolvedValueOnce(undefined);
    const desktop = createDesktopHost({ installDesktopUpdate });
    const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });
    await coordinator.initialize();
    desktop.emit({ ...idleUpdate, phase: 'ready', candidateVersion: '0.2.0' });

    await expect(coordinator.installNow()).rejects.toThrow('native install failed');
    expect(coordinator.installing).toBe(false);
    await coordinator.installNow();

    expect(installDesktopUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not start a second native install when destroyed and remounted while one is pending', async () => {
    const nativeInstall = deferred<void>();
    const installDesktopUpdate = vi.fn<NativeHost['installDesktopUpdate']>(
      () => nativeInstall.promise
    );
    const desktop = createDesktopHost({ installDesktopUpdate });
    const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });
    await coordinator.initialize();
    desktop.emit({ ...idleUpdate, phase: 'ready', candidateVersion: '0.2.0' });

    const beforeDestroy = coordinator.installNow();
    await coordinator.destroy();
    await coordinator.initialize();
    const afterRemount = coordinator.installNow();

    expect(coordinator.installing).toBe(true);
    expect(installDesktopUpdate).toHaveBeenCalledOnce();
    nativeInstall.resolve(undefined);
    await Promise.all([beforeDestroy, afterRemount]);
    expect(coordinator.installing).toBe(false);
  });

  it('establishes a fresh subscription and timer when remounted during an old subscription', async () => {
    vi.useFakeTimers();
    const oldSubscription = deferred<Unsubscribe>();
    const oldUnsubscribe = vi.fn<Unsubscribe>();
    const newUnsubscribe = vi.fn<Unsubscribe>();
    const onDesktopUpdateState = vi
      .fn<NativeHost['onDesktopUpdateState']>()
      .mockImplementationOnce(() => oldSubscription.promise)
      .mockResolvedValueOnce(newUnsubscribe);
    const desktop = createDesktopHost({ onDesktopUpdateState });
    const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });

    const oldInitialization = coordinator.initialize();
    await coordinator.destroy();
    const remounted = coordinator.initialize();
    const subscriptionsBeforeOldResolved = onDesktopUpdateState.mock.calls.length;
    oldSubscription.resolve(oldUnsubscribe);
    await Promise.all([oldInitialization, remounted]);

    expect(subscriptionsBeforeOldResolved).toBe(2);
    expect(oldUnsubscribe).toHaveBeenCalledOnce();
    expect(desktop.host.setDesktopUpdateChannel).toHaveBeenCalledOnce();
    expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_CHECK_INTERVAL_MS);
    expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not reuse or apply an old deferred check after destroy and remount', async () => {
    vi.useFakeTimers();
    const oldCheck = deferred<DesktopUpdateSnapshot>();
    const checkForDesktopUpdate = vi
      .fn<NativeHost['checkForDesktopUpdate']>()
      .mockImplementationOnce(() => oldCheck.promise)
      .mockResolvedValue(idleUpdate);
    const desktop = createDesktopHost({ checkForDesktopUpdate });
    const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });

    const oldInitialization = coordinator.initialize();
    await vi.waitFor(() => expect(checkForDesktopUpdate).toHaveBeenCalledOnce());
    await coordinator.destroy();
    const remounted = coordinator.initialize();
    const subscriptionsBeforeOldResolved = vi.mocked(desktop.host.onDesktopUpdateState).mock.calls
      .length;
    oldCheck.resolve({
      ...idleUpdate,
      phase: 'ready',
      candidateVersion: '0.2.0-stale'
    });
    await Promise.all([oldInitialization, remounted]);

    expect(subscriptionsBeforeOldResolved).toBe(2);
    expect(checkForDesktopUpdate).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot).toEqual(idleUpdate);
    await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_CHECK_INTERVAL_MS);
    expect(checkForDesktopUpdate).toHaveBeenCalledTimes(3);
  });

  it('does not let deferred setup cleanup invalidate or leak a fresh remount', async () => {
    const oldCleanup = deferred<void>();
    const oldUnsubscribe = vi.fn<Unsubscribe>(() => oldCleanup.promise);
    const newUnsubscribe = vi.fn<Unsubscribe>();
    const unexpectedUnsubscribe = vi.fn<Unsubscribe>();
    const onDesktopUpdateState = vi
      .fn<NativeHost['onDesktopUpdateState']>()
      .mockResolvedValueOnce(oldUnsubscribe)
      .mockResolvedValueOnce(newUnsubscribe)
      .mockResolvedValueOnce(unexpectedUnsubscribe);
    const desktop = createDesktopHost({ onDesktopUpdateState });
    vi.mocked(desktop.host.setDesktopUpdateChannel).mockRejectedValueOnce(
      new Error('transient channel failure')
    );
    const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });

    const oldInitialization = coordinator.initialize();
    await vi.waitFor(() => expect(oldUnsubscribe).toHaveBeenCalledOnce());
    await coordinator.destroy();
    await coordinator.initialize();
    oldCleanup.resolve(undefined);
    await oldInitialization;

    await coordinator.initialize();

    expect(onDesktopUpdateState).toHaveBeenCalledTimes(2);
    await coordinator.destroy();
    expect(newUnsubscribe).toHaveBeenCalledOnce();
    expect(unexpectedUnsubscribe).not.toHaveBeenCalled();
  });

  it.each(['subscription', 'channel'] as const)(
    'recovers from a transient startup %s failure after a bounded delay',
    async (failure) => {
      vi.useFakeTimers();
      const desktop = createDesktopHost();
      if (failure === 'subscription') {
        vi.mocked(desktop.host.onDesktopUpdateState).mockRejectedValueOnce(
          new Error('transient subscription failure')
        );
      } else {
        vi.mocked(desktop.host.setDesktopUpdateChannel).mockRejectedValueOnce(
          new Error('transient channel failure')
        );
      }
      const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });

      await coordinator.initialize();
      expect(coordinator.snapshot.phase).toBe('failed');
      expect(desktop.host.checkForDesktopUpdate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_SETUP_RETRY_MS - 1);
      expect(desktop.host.checkForDesktopUpdate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await vi.waitFor(() => expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledOnce());
      expect(coordinator.snapshot).toEqual(idleUpdate);
      expect(desktop.host.onDesktopUpdateState).toHaveBeenCalledTimes(2);
    }
  );

  it('checks every six hours and removes the timer and subscription when destroyed', async () => {
    vi.useFakeTimers();
    const desktop = createDesktopHost();
    const coordinator = createCoordinator(desktop.host, {
      desktopUpdateChannel: 'stable'
    });
    await coordinator.initialize();
    expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_CHECK_INTERVAL_MS);
    expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledTimes(2);

    await coordinator.destroy();
    await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_CHECK_INTERVAL_MS);
    expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledTimes(2);
    expect(desktop.unsubscribe).toHaveBeenCalledOnce();
  });

  it('persists channel changes only after native acceptance and triggers a fresh check', async () => {
    const desktop = createDesktopHost();
    const preferences: TestPreferences = { desktopUpdateChannel: 'stable' };
    const coordinator = createCoordinator(desktop.host, preferences);
    await coordinator.initialize();
    desktop.emit({
      ...idleUpdate,
      phase: 'ready',
      candidateVersion: '0.2.0'
    });
    expect(coordinator.snapshot.candidateVersion).toBe('0.2.0');

    const changingChannel = coordinator.setChannel('nightly');

    await changingChannel;
    expect(preferences.desktopUpdateChannel).toBe('nightly');
    expect(coordinator.snapshot).toMatchObject({ channel: 'nightly', phase: 'idle' });
    expect(coordinator.snapshot.candidateVersion).toBeUndefined();
    expect(desktop.host.setDesktopUpdateChannel).toHaveBeenLastCalledWith('nightly');
    expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledTimes(2);

    desktop.emit({ ...idleUpdate, phase: 'ready', candidateVersion: '0.2.0-stale' });
    expect(coordinator.snapshot.candidateVersion).toBeUndefined();
  });

  it('waits for an active check before changing and persisting the native channel', async () => {
    const activeCheck = deferred<DesktopUpdateSnapshot>();
    const desktop = createDesktopHost();
    const preferences: TestPreferences = { desktopUpdateChannel: 'stable' };
    const coordinator = createCoordinator(desktop.host, preferences);
    await coordinator.initialize();
    vi.mocked(desktop.host.checkForDesktopUpdate).mockImplementationOnce(() => activeCheck.promise);

    const checking = coordinator.checkNow();
    const changingChannel = coordinator.setChannel('nightly');

    expect(desktop.host.setDesktopUpdateChannel).toHaveBeenCalledTimes(1);
    expect(preferences.desktopUpdateChannel).toBe('stable');
    expect(coordinator.snapshot.channel).toBe('stable');

    activeCheck.resolve({ ...idleUpdate, phase: 'idle' });
    await Promise.all([checking, changingChannel]);

    expect(desktop.host.setDesktopUpdateChannel).toHaveBeenLastCalledWith('nightly');
    expect(preferences.desktopUpdateChannel).toBe('nightly');
    expect(coordinator.snapshot.channel).toBe('nightly');
  });

  it('retries an independently busy channel change without exposing a permanent failure', async () => {
    vi.useFakeTimers();
    const desktop = createDesktopHost();
    const preferences: TestPreferences = { desktopUpdateChannel: 'stable' };
    const coordinator = createCoordinator(desktop.host, preferences);
    await coordinator.initialize();
    const busyAttempt = deferred<DesktopUpdateSnapshot>();
    vi.mocked(desktop.host.setDesktopUpdateChannel)
      .mockImplementationOnce(() => busyAttempt.promise)
      .mockImplementationOnce(async (channel) => ({ ...idleUpdate, channel }));

    const changingChannel = coordinator.setChannel('nightly');
    await vi.waitFor(() => expect(desktop.host.setDesktopUpdateChannel).toHaveBeenCalledTimes(2));
    busyAttempt.reject(new Error('unavailable'));
    await vi.advanceTimersByTimeAsync(0);

    expect(preferences.desktopUpdateChannel).toBe('stable');
    expect(coordinator.snapshot).toMatchObject({ channel: 'stable', phase: 'idle' });
    await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_SETUP_RETRY_MS - 1);
    expect(desktop.host.setDesktopUpdateChannel).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await changingChannel;

    expect(desktop.host.setDesktopUpdateChannel).toHaveBeenLastCalledWith('nightly');
    expect(preferences.desktopUpdateChannel).toBe('nightly');
    expect(coordinator.snapshot).toMatchObject({ channel: 'nightly', phase: 'idle' });
  });

  it('coalesces selections made while a busy channel change is waiting to retry', async () => {
    vi.useFakeTimers();
    const desktop = createDesktopHost();
    const preferences: TestPreferences = { desktopUpdateChannel: 'stable' };
    const coordinator = createCoordinator(desktop.host, preferences);
    await coordinator.initialize();
    const busyAttempt = deferred<DesktopUpdateSnapshot>();
    vi.mocked(desktop.host.setDesktopUpdateChannel)
      .mockImplementationOnce(() => busyAttempt.promise)
      .mockImplementation(async (channel) => ({ ...idleUpdate, channel }));

    const firstSelection = coordinator.setChannel('nightly');
    await vi.waitFor(() => expect(desktop.host.setDesktopUpdateChannel).toHaveBeenCalledTimes(2));
    busyAttempt.reject(new Error('unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    const secondSelection = coordinator.setChannel('stable');
    const latestSelection = coordinator.setChannel('nightly');

    expect(preferences.desktopUpdateChannel).toBe('stable');
    expect(coordinator.snapshot.channel).toBe('stable');
    await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_SETUP_RETRY_MS);
    await Promise.all([firstSelection, secondSelection, latestSelection]);

    expect(desktop.host.setDesktopUpdateChannel).toHaveBeenLastCalledWith('nightly');
    expect(preferences.desktopUpdateChannel).toBe('nightly');
    expect(coordinator.snapshot.channel).toBe('nightly');
  });

  it('serializes concurrent channel changes so the latest preference wins natively', async () => {
    let nativeChannel: DesktopUpdateChannel = 'stable';
    const firstChange = deferred<DesktopUpdateSnapshot>();
    const desktop = createDesktopHost();
    const setDesktopUpdateChannel = vi.mocked(desktop.host.setDesktopUpdateChannel);
    const checkForDesktopUpdate = vi.mocked(desktop.host.checkForDesktopUpdate);
    checkForDesktopUpdate.mockImplementation(async () => ({
      ...idleUpdate,
      channel: nativeChannel
    }));
    const preferences: TestPreferences = { desktopUpdateChannel: 'stable' };
    const coordinator = createCoordinator(desktop.host, preferences);
    await coordinator.initialize();
    setDesktopUpdateChannel
      .mockImplementationOnce(async (channel) => {
        await firstChange.promise;
        nativeChannel = channel;
        return { ...idleUpdate, channel };
      })
      .mockImplementationOnce(async (channel) => {
        nativeChannel = channel;
        return { ...idleUpdate, channel };
      });

    const selectNightly = coordinator.setChannel('nightly');
    await vi.waitFor(() => expect(setDesktopUpdateChannel).toHaveBeenCalledTimes(2));
    const selectStable = coordinator.setChannel('stable');
    expect(preferences.desktopUpdateChannel).toBe('stable');
    firstChange.resolve({ ...idleUpdate, channel: 'nightly' });
    await Promise.all([selectNightly, selectStable]);

    expect(setDesktopUpdateChannel).toHaveBeenLastCalledWith('stable');
    expect(nativeChannel).toBe('stable');
    expect(coordinator.snapshot.channel).toBe('stable');
    expect(checkForDesktopUpdate).toHaveBeenCalledTimes(2);
  });

  it('keeps normalized manual failures visible in state', async () => {
    const desktop = createDesktopHost();
    const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });
    await coordinator.initialize();
    vi.mocked(desktop.host.checkForDesktopUpdate).mockRejectedValueOnce(
      new Error('sensitive transport details')
    );

    await coordinator.checkNow();

    expect(coordinator.snapshot).toMatchObject({
      phase: 'failed',
      errorCode: 'unavailable'
    });
    expect(coordinator.snapshot).not.toHaveProperty('error');
  });

  it('keeps scheduled background failures in state without a toast dependency', async () => {
    vi.useFakeTimers();
    const desktop = createDesktopHost();
    const coordinator = createCoordinator(desktop.host, { desktopUpdateChannel: 'stable' });
    await coordinator.initialize();
    vi.mocked(desktop.host.checkForDesktopUpdate).mockRejectedValueOnce(
      new Error('sensitive transport details')
    );

    await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_CHECK_INTERVAL_MS);

    expect(coordinator.snapshot).toMatchObject({
      phase: 'failed',
      errorCode: 'unavailable'
    });
    expect(coordinator.snapshot).not.toHaveProperty('error');
  });
});
