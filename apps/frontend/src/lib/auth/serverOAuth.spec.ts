import { describe, expect, it, vi } from 'vitest';
import type { RegisteredServer } from '$lib/state/server/registry.svelte';
import {
  completeServerOAuth,
  parseServerOAuthTokenResponse,
  type ServerOAuthRegistry
} from './serverOAuth';

function server(overrides: Partial<RegisteredServer> = {}): RegisteredServer {
  return {
    id: 'chatto-example',
    source: 'local',
    url: 'https://chatto.example',
    name: 'Existing Chatto',
    iconUrl: 'https://chatto.example/old-icon.png',
    token: 'old-token',
    userId: 'old-user',
    userLogin: 'old-login',
    userDisplayName: 'Old User',
    userAvatarUrl: null,
    reauthRequiredAt: 123,
    addedAt: 10,
    ...overrides
  };
}

class FakeRegistry implements ServerOAuthRegistry {
  servers: RegisteredServer[];

  constructor(servers: RegisteredServer[] = []) {
    this.servers = servers;
  }

  addServer(value: RegisteredServer): void {
    this.servers.push(value);
  }

  updateServer(id: string, data: Partial<Omit<RegisteredServer, 'id'>>): boolean {
    const value = this.servers.find((candidate) => candidate.id === id);
    if (!value) return false;
    Object.assign(value, data);
    return true;
  }

  replaceServerAuthentication(
    id: string,
    data: Pick<
      RegisteredServer,
      'token' | 'userId' | 'userLogin' | 'userDisplayName' | 'userAvatarUrl' | 'reauthRequiredAt'
    >
  ): boolean {
    return this.updateServer(id, data);
  }
}

describe('server OAuth completion', () => {
  it('adds a newly authenticated server and returns its chat route', () => {
    vi.spyOn(Date, 'now').mockReturnValue(42);
    const registry = new FakeRegistry();

    const route = completeServerOAuth(
      {
        remoteUrl: 'https://chatto.example',
        serverName: 'Example Community',
        serverIconUrl: 'https://chatto.example/icon.png'
      },
      {
        accessToken: 'new-token',
        user: {
          id: 'user-1',
          login: 'ada',
          displayName: 'Ada',
          avatarUrl: 'https://chatto.example/ada.png'
        }
      },
      registry
    );

    expect(route).toEqual({ serverId: 'chatto.example' });
    expect(registry.servers).toEqual([
      server({
        name: 'Example Community',
        iconUrl: 'https://chatto.example/icon.png',
        token: 'new-token',
        userId: 'user-1',
        userLogin: 'ada',
        userDisplayName: 'Ada',
        userAvatarUrl: 'https://chatto.example/ada.png',
        reauthRequiredAt: null,
        addedAt: 42
      })
    ]);
  });

  it('replaces authentication without duplicating an existing server', () => {
    const existing = server();
    const registry = new FakeRegistry([existing]);

    const route = completeServerOAuth(
      {
        remoteUrl: 'https://CHATTO.example',
        serverName: 'Fresh Discovery Name',
        serverIconUrl: 'https://chatto.example/new-icon.png'
      },
      {
        accessToken: 'replacement-token',
        user: { id: 'new-user', login: 'grace' }
      },
      registry
    );

    expect(route).toEqual({ serverId: 'chatto.example' });
    expect(registry.servers).toHaveLength(1);
    expect(existing).toMatchObject({
      id: 'chatto-example',
      url: 'https://chatto.example',
      name: 'Fresh Discovery Name',
      iconUrl: 'https://chatto.example/new-icon.png',
      token: 'replacement-token',
      userId: 'new-user',
      userLogin: 'grace',
      userDisplayName: null,
      userAvatarUrl: null,
      reauthRequiredAt: null,
      addedAt: 10
    });
  });

  it('preserves existing trusted metadata when refreshed discovery omits it', () => {
    const existing = server();
    const registry = new FakeRegistry([existing]);

    completeServerOAuth(
      {
        remoteUrl: existing.url,
        serverName: null,
        serverIconUrl: null
      },
      { accessToken: 'replacement-token' },
      registry
    );

    expect(existing.name).toBe('Existing Chatto');
    expect(existing.iconUrl).toBe('https://chatto.example/old-icon.png');
  });
});

describe('parseServerOAuthTokenResponse', () => {
  it('normalizes the server token response', () => {
    expect(
      parseServerOAuthTokenResponse({
        access_token: 'token',
        user: { id: 'user-1', login: 'ada', displayName: 'Ada' }
      })
    ).toEqual({
      accessToken: 'token',
      user: { id: 'user-1', login: 'ada', displayName: 'Ada', avatarUrl: null }
    });
  });

  it.each([null, {}, { access_token: '' }, { access_token: 123 }])(
    'rejects a response without a usable access token',
    (value) => {
      expect(() => parseServerOAuthTokenResponse(value)).toThrow(
        'OAuth token response did not include an access token.'
      );
    }
  );
});
