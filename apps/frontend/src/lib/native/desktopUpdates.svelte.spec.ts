import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNativeHost } from './browserHost';
import {
  DesktopUpdatesCoordinator,
  DESKTOP_UPDATE_CHECK_INTERVAL_MS
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
  const promise = new Promise<T>((fulfil) => {
    resolve = fulfil;
  });
  return { promise, resolve };
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

  it('persists channel changes, discards stale candidates, and triggers a fresh check', async () => {
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

    expect(preferences.desktopUpdateChannel).toBe('nightly');
    expect(coordinator.snapshot).toMatchObject({ channel: 'nightly', phase: 'idle' });
    expect(coordinator.snapshot.candidateVersion).toBeUndefined();
    desktop.emit({ ...idleUpdate, phase: 'ready', candidateVersion: '0.2.0' });
    expect(coordinator.snapshot.candidateVersion).toBeUndefined();
    await changingChannel;
    expect(desktop.host.setDesktopUpdateChannel).toHaveBeenLastCalledWith('nightly');
    expect(desktop.host.checkForDesktopUpdate).toHaveBeenCalledTimes(2);
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
