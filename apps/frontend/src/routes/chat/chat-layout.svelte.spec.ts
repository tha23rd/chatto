import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { testSnippet } from '$lib/test-utils';

const mocks = vi.hoisted(() => ({
  stopPresenceTracking: vi.fn(),
  store: {
    isAuthenticated: true,
    serverInfo: {
      supportsRealtimeProjection: true
    },
    realtimeSync: {},
    currentUser: {
      user: undefined
    }
  }
}));

vi.mock('$lib/components/NotificationSync.svelte', async () => {
  const { default: NotificationSyncMock } = await import('./ChatLayoutNotificationSyncMock.svelte');
  return { default: NotificationSyncMock };
});

vi.mock('$lib/presenceTracking', () => ({
  initPresenceTracking: () => mocks.stopPresenceTracking
}));

vi.mock('$lib/state/server/eventBus.svelte', () => ({
  eventBusManager: {
    synchronizeAuthenticatedServers: vi.fn()
  }
}));

vi.mock('$lib/state/server/registry.svelte', () => ({
  // The layout mounts AuthStatusNotice, which imports the reauth module, which
  // imports `generateServerId` from here. Unused by this test, but the mock has
  // to provide it or the module namespace fails to resolve.
  generateServerId: (url: string) => url,
  serverRegistry: {
    originServer: null,
    servers: [{ id: 'remote' }],
    // No server resolves, so the reauth notice stays hidden and this test is
    // only exercising the lifecycle owners the layout mounts.
    getServer: () => undefined,
    tryGetStore: () => mocks.store
  }
}));

vi.mock('$lib/state/server/serverConnection.svelte', () => ({
  serverConnectionManager: {
    getClient: () => ({
      connectBaseUrl: 'https://remote.example/api/connect',
      bearerToken: 'test-token'
    })
  }
}));

import Layout from './+layout.svelte';

describe('chat layout lifecycle owners', () => {
  it('mounts notification sync for an anonymous origin with remote authentication', () => {
    const { container } = render(Layout, {
      props: {
        data: {
          serverInfo: null,
          serverInfoLoaded: true,
          user: null
        },
        children: testSnippet('<div data-testid="chat-layout-child"></div>')
      }
    });

    expect(container.querySelectorAll('[data-testid="notification-sync-mounted"]')).toHaveLength(
      1
    );
  });
});
