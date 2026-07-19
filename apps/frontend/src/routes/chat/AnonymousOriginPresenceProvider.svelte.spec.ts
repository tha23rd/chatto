import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { CurrentUserState } from '$lib/auth/currentUser.svelte';
import { PresenceStatus } from '$lib/render/types';
import { PresenceCache } from '$lib/state/presenceCache.svelte';
import AnonymousOriginPresenceProvider from './AnonymousOriginPresenceProvider.svelte';

const mocks = vi.hoisted(() => ({
  initPresenceTracking: vi.fn(),
  synchronizeAuthenticatedServers: vi.fn(),
  stopPresenceTracking: vi.fn(),
  connection: {
    connectBaseUrl: 'https://remote.example/api/connect',
    bearerToken: 'test-token'
  },
  realtimeSync: {},
  store: {
    isAuthenticated: true,
    currentUser: null as CurrentUserState | null,
    serverInfo: { supportsRealtimeProjection: true },
    realtimeSync: null as object | null
  }
}));

vi.mock('$lib/presenceTracking', () => ({
  initPresenceTracking: mocks.initPresenceTracking
}));

vi.mock('$lib/state/server/registry.svelte', () => ({
  serverRegistry: {
    servers: [{ id: 'remote' }],
    tryGetStore: () => mocks.store
  }
}));

vi.mock('$lib/state/activeServer.svelte', () => ({
  getActiveServer: () => 'remote'
}));

vi.mock('$lib/state/server/eventBus.svelte', () => ({
  eventBusManager: {
    synchronizeAuthenticatedServers: mocks.synchronizeAuthenticatedServers
  }
}));

vi.mock('$lib/state/server/serverConnection.svelte', () => ({
  serverConnectionManager: {
    getClient: () => mocks.connection
  }
}));

describe('AnonymousOriginPresenceProvider', () => {
  beforeEach(() => {
    mocks.store.currentUser = new CurrentUserState();
    mocks.store.realtimeSync = mocks.realtimeSync;
    mocks.initPresenceTracking.mockReset();
    mocks.synchronizeAuthenticatedServers.mockReset();
    mocks.stopPresenceTracking.mockReset();
    mocks.initPresenceTracking.mockImplementation((_getReporters, onStatusChange) => {
      onStatusChange?.(PresenceStatus.Online);
      return mocks.stopPresenceTracking;
    });
  });

  it('starts the active remote projection transport while the origin is anonymous', () => {
    render(AnonymousOriginPresenceProvider, { props: { presenceCache: new PresenceCache() } });
    flushSync();

    expect(mocks.synchronizeAuthenticatedServers).toHaveBeenCalledWith(
      [
        {
          serverId: 'remote',
          connection: mocks.connection,
          projectionSupported: true,
          sync: mocks.realtimeSync
        }
      ],
      'remote'
    );
  });

  it('applies the effective presence after a remote current user loads', () => {
    const presenceCache = new PresenceCache();
    render(AnonymousOriginPresenceProvider, { props: { presenceCache } });
    flushSync();

    expect(mocks.initPresenceTracking).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function)
    );

    expect(
      presenceCache.get({ serverId: 'remote', userId: 'remote-user' }, PresenceStatus.Offline)
    ).toBe(PresenceStatus.Offline);

    if (!mocks.store.currentUser) throw new Error('current user state was not initialized');
    mocks.store.currentUser.user = {
      id: 'remote-user',
      login: 'remote-user',
      displayName: 'Remote User',
      presenceStatus: PresenceStatus.Offline,
      hasVerifiedEmail: true,
      hasPassword: true,
      viewerCanDeleteAccount: true
    };
    mocks.store.currentUser.loading = false;
    flushSync();

    expect(
      presenceCache.get({ serverId: 'remote', userId: 'remote-user' }, PresenceStatus.Offline)
    ).toBe(PresenceStatus.Online);
  });
});
