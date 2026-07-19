import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { PresenceCache } from '$lib/state/presenceCache.svelte';
import { PresenceStatus } from '$lib/render/types';

// Capture the arguments SessionPresenceTracker passes to initPresenceTracking so
// the test can assert what would actually be reported to the server.
const { mocks } = vi.hoisted(() => ({
  mocks: {
    initPresenceTracking: vi.fn(() => vi.fn()),
    // A single authenticated *remote* server and, deliberately, no origin
    // server — the desktop / standalone-frontend (remote-only) scenario.
    servers: [{ id: 'remote-1', url: 'https://chat.example.test' }],
    store: {
      isAuthenticated: true,
      currentUser: { user: { id: 'user-1' }, loading: false }
    },
    client: { connectBaseUrl: 'https://chat.example.test/api/connect', bearerToken: 'tok-1' }
  }
}));

vi.mock('$lib/presenceTracking', () => ({
  initPresenceTracking: mocks.initPresenceTracking
}));

vi.mock('$lib/state/server/registry.svelte', () => ({
  serverRegistry: {
    get servers() {
      return mocks.servers;
    },
    tryGetStore: (id: string) => (id === mocks.servers[0]?.id ? mocks.store : undefined)
  }
}));

vi.mock('$lib/state/server/serverConnection.svelte', () => ({
  serverConnectionManager: {
    getClient: () => mocks.client
  }
}));

vi.mock('$lib/state/server/eventBus.svelte', () => ({
  eventBusManager: {
    pauseAll: vi.fn(),
    resumeAll: vi.fn(),
    startBus: vi.fn()
  }
}));

import SessionPresenceTracker from './SessionPresenceTracker.svelte';

describe('SessionPresenceTracker', () => {
  beforeEach(() => {
    mocks.initPresenceTracking.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes presence tracking for a remote-only session (no origin server)', () => {
    render(SessionPresenceTracker, { presenceCache: new PresenceCache() });

    expect(mocks.initPresenceTracking).toHaveBeenCalledTimes(1);
  });

  it('reports every authenticated remote server, keyed by its own base URL', () => {
    render(SessionPresenceTracker, { presenceCache: new PresenceCache() });

    const [getReporters] = mocks.initPresenceTracking.mock.calls[0] as unknown as [
      () => Array<{ serverId: string; baseUrl: string; bearerToken: string | null }>
    ];

    expect(getReporters()).toEqual([
      {
        serverId: 'remote-1',
        baseUrl: 'https://chat.example.test/api/connect',
        bearerToken: 'tok-1'
      }
    ]);
  });

  it('mirrors the effective status into the local presence cache on mount', () => {
    const presenceCache = new PresenceCache();
    render(SessionPresenceTracker, { presenceCache });

    // The mount-time $effect seeds the current user's cache entry so the avatar
    // never falls back to the server's stale (offline) profile status.
    expect(presenceCache.get({ serverId: 'remote-1', userId: 'user-1' }, PresenceStatus.Offline)).toBe(
      PresenceStatus.Online
    );
  });
});
