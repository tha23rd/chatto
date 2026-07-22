import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearBadge,
  registerAppBadgeHandler,
  syncServiceWorkerNotificationBadgeState,
  updateBadge
} from './appBadge';

function stubBadgeEnvironment(options: { installed: boolean; controlled?: boolean }) {
  const controllerPostMessage = vi.fn();
  const activePostMessage = vi.fn();
  let controller =
    options.controlled === false
      ? null
      : ({ postMessage: controllerPostMessage } as unknown as ServiceWorker);
  let controllerChange: (() => void) | undefined;
  const serviceWorker = {
    get controller() {
      return controller;
    },
    ready: Promise.resolve({ active: { postMessage: activePostMessage } }),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'controllerchange') controllerChange = listener;
    })
  };
  vi.stubGlobal('navigator', {
    setAppBadge: vi.fn(),
    clearAppBadge: vi.fn(),
    serviceWorker
  });
  vi.stubGlobal('window', {
    matchMedia: vi.fn((query: string) => ({
      matches: options.installed && query === '(display-mode: standalone)'
    }))
  });

  return {
    postMessage: controllerPostMessage,
    activePostMessage,
    replaceController() {
      const postMessage = vi.fn();
      controller = { postMessage } as unknown as ServiceWorker;
      controllerChange?.();
      return postMessage;
    }
  };
}

describe('syncServiceWorkerNotificationBadgeState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tells the service worker to skip worker-side badging in a browser tab', () => {
    const { postMessage } = stubBadgeEnvironment({ installed: false });

    syncServiceWorkerNotificationBadgeState({ kind: 'count', count: 3 });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'chatto-badge-state',
      badgeIntent: { kind: 'count', count: 3 },
      notificationCount: 3,
      serviceWorkerAppBadgeEnabled: false
    });
  });

  it('allows worker-side badging in an installed app display mode', () => {
    const { postMessage } = stubBadgeEnvironment({ installed: true });

    syncServiceWorkerNotificationBadgeState({ kind: 'flag' });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'chatto-badge-state',
      badgeIntent: { kind: 'flag' },
      notificationCount: 1,
      serviceWorkerAppBadgeEnabled: true
    });
  });

  it('sends the latest state to an active worker before the page is controlled', async () => {
    const { activePostMessage } = stubBadgeEnvironment({ installed: true, controlled: false });

    syncServiceWorkerNotificationBadgeState({ kind: 'clear' });
    await vi.waitFor(() => expect(activePostMessage).toHaveBeenCalledOnce());

    expect(activePostMessage).toHaveBeenCalledWith({
      type: 'chatto-badge-state',
      badgeIntent: { kind: 'clear' },
      notificationCount: 0,
      serviceWorkerAppBadgeEnabled: true
    });
  });

  it('does not deliver an older badge intent while worker readiness is pending', async () => {
    const { activePostMessage } = stubBadgeEnvironment({ installed: true, controlled: false });

    syncServiceWorkerNotificationBadgeState({ kind: 'count', count: 2 });
    syncServiceWorkerNotificationBadgeState({ kind: 'clear' });
    await vi.waitFor(() => expect(activePostMessage).toHaveBeenCalledOnce());

    expect(activePostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ badgeIntent: { kind: 'clear' }, notificationCount: 0 })
    );
  });

  it('replays authoritative state when the controlling worker changes', () => {
    const environment = stubBadgeEnvironment({ installed: true });
    syncServiceWorkerNotificationBadgeState({ kind: 'clear' });

    const replacementPostMessage = environment.replaceController();

    expect(replacementPostMessage).toHaveBeenCalledOnce();
    expect(replacementPostMessage).toHaveBeenCalledWith({
      type: 'chatto-badge-state',
      badgeIntent: { kind: 'clear' },
      notificationCount: 0,
      serviceWorkerAppBadgeEnabled: true
    });
  });
});

describe('app badge handlers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes normalized badge intents when the browser Badging API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const handler = vi.fn();
    const unregister = registerAppBadgeHandler(handler);

    await updateBadge({ kind: 'count', count: 2.8 });

    expect(handler).toHaveBeenCalledWith({ kind: 'count', count: 2 });
    unregister();
  });

  it('publishes a clear intent when the badge is cleared', async () => {
    vi.stubGlobal('navigator', {});
    const handler = vi.fn();
    const unregister = registerAppBadgeHandler(handler);

    await clearBadge();

    expect(handler).toHaveBeenCalledWith({ kind: 'clear' });
    unregister();
  });

  it('replays the latest intent to a newly registered host', async () => {
    vi.stubGlobal('navigator', {});
    await updateBadge({ kind: 'flag' });
    const handler = vi.fn();

    const unregister = registerAppBadgeHandler(handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ kind: 'flag' }));
    unregister();
  });

  it('stops publishing after a handler is unregistered', async () => {
    vi.stubGlobal('navigator', {});
    const handler = vi.fn();
    const unregister = registerAppBadgeHandler(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    handler.mockClear();

    unregister();
    await updateBadge({ kind: 'count', count: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps the browser badge best-effort when a native handler fails', async () => {
    const setAppBadge = vi.fn();
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge: vi.fn() });
    const unregister = registerAppBadgeHandler(() => Promise.reject(new Error('unavailable')));

    await updateBadge({ kind: 'flag' });

    expect(setAppBadge).toHaveBeenCalledWith();
    unregister();
  });

  it('does not delay the browser badge while a native handler is pending', async () => {
    const setAppBadge = vi.fn();
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge: vi.fn() });
    const unregister = registerAppBadgeHandler(() => new Promise(() => {}));

    await updateBadge({ kind: 'flag' });

    expect(setAppBadge).toHaveBeenCalledWith();
    unregister();
  });
});
