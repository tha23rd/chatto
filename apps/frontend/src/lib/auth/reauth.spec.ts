import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeHost } from '$lib/native/types';

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  getNativeHost: vi.fn(),
  saveFlowState: vi.fn(),
  completeServerOAuth: vi.fn(),
  startServerOAuth: vi.fn()
}));

vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$app/paths', () => ({
  resolve: (route: string) => route
}));
vi.mock('$lib/api-client/server', () => ({ getPublicServerInfo: vi.fn() }));
vi.mock('$lib/native/host', () => ({ getNativeHost: mocks.getNativeHost }));
vi.mock('$lib/oauth/pkce', () => ({
  generateCodeChallenge: vi.fn(async () => 'challenge'),
  generateCodeVerifier: vi.fn(() => 'verifier'),
  generateState: vi.fn(() => 'state'),
  saveFlowState: mocks.saveFlowState
}));
vi.mock('$lib/state/server/registry.svelte', () => ({
  serverRegistry: { clearOriginAuthentication: vi.fn() }
}));
vi.mock('./loadAuth', () => ({ clearCachedUser: vi.fn() }));
vi.mock('./serverOAuth', () => ({ completeServerOAuth: mocks.completeServerOAuth }));

import { startServerOAuthFlow } from './reauth';

function nativeHost(nativeOAuth: boolean): NativeHost {
  return {
    capabilities: { nativeOAuth },
    startServerOAuth: mocks.startServerOAuth
  } as unknown as NativeHost;
}

beforeEach(() => {
  mocks.goto.mockReset().mockResolvedValue(undefined);
  mocks.saveFlowState.mockReset();
  mocks.completeServerOAuth.mockReset().mockReturnValue('/chat/chatto.example');
  mocks.startServerOAuth.mockReset().mockResolvedValue({ accessToken: 'token' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startServerOAuthFlow', () => {
  it('uses the native loopback flow and completes registration on desktop', async () => {
    mocks.getNativeHost.mockReturnValue(nativeHost(true));

    await startServerOAuthFlow('https://chatto.example', {
      name: 'Example',
      authorizeUrl: '/oauth/authorize',
      iconUrl: 'https://chatto.example/icon.png'
    });

    expect(mocks.startServerOAuth).toHaveBeenCalledWith({
      serverUrl: 'https://chatto.example',
      authorizePath: '/oauth/authorize',
      codeChallenge: 'challenge',
      codeVerifier: 'verifier',
      state: 'state'
    });
    expect(mocks.saveFlowState).not.toHaveBeenCalled();
    expect(mocks.completeServerOAuth).toHaveBeenCalledWith(
      {
        remoteUrl: 'https://chatto.example',
        serverName: 'Example',
        serverIconUrl: 'https://chatto.example/icon.png'
      },
      { accessToken: 'token' }
    );
    expect(mocks.goto).toHaveBeenCalledWith('/chat/chatto.example');
  });

  it('retains the browser callback flow for the web client', async () => {
    mocks.getNativeHost.mockReturnValue(nativeHost(false));
    const location = { origin: 'https://client.example', href: '' };
    vi.stubGlobal('window', { location });

    await startServerOAuthFlow('https://chatto.example', {
      name: 'Example',
      authorizeUrl: '/oauth/authorize',
      iconUrl: null
    });

    expect(mocks.saveFlowState).toHaveBeenCalledWith({
      verifier: 'verifier',
      state: 'state',
      remoteUrl: 'https://chatto.example',
      serverName: 'Example',
      serverIconUrl: null
    });
    const authorizeUrl = new URL(location.href);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      'https://chatto.example/oauth/authorize'
    );
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
      'https://client.example/servers/callback'
    );
  });

  it('rejects an authorization endpoint on a different origin', async () => {
    mocks.getNativeHost.mockReturnValue(nativeHost(true));

    await expect(
      startServerOAuthFlow('https://chatto.example', {
        name: 'Example',
        authorizeUrl: 'https://evil.example/authorize',
        iconUrl: null
      })
    ).rejects.toThrow('OAuth authorization URL is not allowed.');
    expect(mocks.startServerOAuth).not.toHaveBeenCalled();
  });
});
