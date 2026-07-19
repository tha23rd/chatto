import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServerOAuthFlow } from './reauth';

const mocks = vi.hoisted(() => ({
  allowProbe: vi.fn((_origin: string) => {}),
  openExternalAuth: vi.fn((_url: string) => Promise.resolve()),
  prepareOAuthFlow: vi.fn((_request: unknown) =>
    Promise.resolve('http://127.0.0.1:43123/oauth/callback/random')
  ),
  saveFlowState: vi.fn()
}));

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/api-client/server', () => ({ getPublicServerInfo: vi.fn() }));
vi.mock('$lib/oauth/pkce', () => ({
  generateCodeChallenge: () => Promise.resolve('challenge'),
  generateCodeVerifier: () => 'verifier',
  generateState: () => 'state',
  saveFlowState: mocks.saveFlowState
}));
vi.mock('$lib/state/server/registry.svelte', () => ({ serverRegistry: {} }));
vi.mock('./loadAuth', () => ({ clearCachedUser: vi.fn() }));
vi.mock('$lib/native/client', () => ({
  getNativeClient: () => ({
    allowServerOriginForProbe: mocks.allowProbe,
    openExternalAuth: mocks.openExternalAuth,
    prepareOAuthFlow: mocks.prepareOAuthFlow
  })
}));
vi.mock('$lib/i18n/messages', () => ({
  'native.callback.title': () => 'Sign-in complete',
  'native.callback.message': () => 'Return to Chatto.'
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { location: { origin: 'chatto-app://app' } });
});

afterEach(() => vi.unstubAllGlobals());

describe('native server OAuth', () => {
  it('renews the probe grant and uses the exact loopback URI throughout PKCE', async () => {
    await startServerOAuthFlow('https://chat.example', {
      name: 'Community',
      authorizeUrl: '/oauth/authorize',
      iconUrl: null
    });

    expect(mocks.allowProbe).toHaveBeenCalledWith('https://chat.example');
    expect(mocks.allowProbe.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepareOAuthFlow.mock.invocationCallOrder[0]
    );
    expect(mocks.prepareOAuthFlow).toHaveBeenCalledWith({
      serverOrigin: 'https://chat.example',
      callbackLabels: {
        title: 'Sign-in complete',
        message: 'Return to Chatto.'
      }
    });
    expect(mocks.saveFlowState).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUrl: 'https://chat.example',
        redirectUri: 'http://127.0.0.1:43123/oauth/callback/random'
      })
    );

    const authorizeUrl = new URL(mocks.openExternalAuth.mock.calls[0][0]);
    expect(authorizeUrl.origin).toBe('https://chat.example');
    expect(authorizeUrl.pathname).toBe('/oauth/authorize');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:43123/oauth/callback/random'
    );
    expect(authorizeUrl.searchParams.get('code_challenge')).toBe('challenge');
    expect(authorizeUrl.searchParams.get('state')).toBe('state');
  });
});
