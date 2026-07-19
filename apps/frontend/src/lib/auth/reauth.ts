import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { getPublicServerInfo, type PublicServerInfo } from '$lib/api-client/server';
import { getNativeHost } from '$lib/native/host';
import { assertAllowedServerUrl } from '$lib/native/urlPolicy';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  saveFlowState
} from '$lib/oauth/pkce';
import { serverRegistry, type RegisteredServer } from '$lib/state/server/registry.svelte';
import { clearCachedUser } from './loadAuth';
import { completeServerOAuth } from './serverOAuth';

function serverAuthorizeUrl(
  serverUrl: string,
  authorizePath: string,
  params: URLSearchParams
): string {
  const endpoint = new URL(authorizePath, `${serverUrl}/`);
  if (endpoint.origin !== serverUrl || endpoint.hash) {
    throw new Error('OAuth authorization URL is not allowed.');
  }
  endpoint.search = params.toString();
  return endpoint.toString();
}

export async function startServerOAuthFlow(
  serverUrl: string,
  serverInfo: Pick<PublicServerInfo, 'name' | 'authorizeUrl' | 'iconUrl'>
): Promise<void> {
  if (!serverInfo.authorizeUrl) {
    throw new Error('This server does not support OAuth sign-in.');
  }

  const remoteUrl = assertAllowedServerUrl(serverUrl);
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();
  const params = new URLSearchParams({
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  });
  const nativeHost = getNativeHost();

  if (nativeHost.capabilities.nativeOAuth) {
    // Validate the discovered path before it crosses the native boundary.
    serverAuthorizeUrl(remoteUrl, serverInfo.authorizeUrl, params);
    const result = await nativeHost.startServerOAuth({
      serverUrl: remoteUrl,
      authorizePath: serverInfo.authorizeUrl,
      codeChallenge: challenge,
      codeVerifier: verifier,
      state
    });
    const route = completeServerOAuth(
      {
        remoteUrl,
        serverName: serverInfo.name,
        serverIconUrl: serverInfo.iconUrl ?? null
      },
      result
    );
    await goto(route);
    return;
  }

  const redirectUri = `${window.location.origin}/servers/callback`;
  saveFlowState({
    verifier,
    state,
    remoteUrl,
    serverName: serverInfo.name,
    serverIconUrl: serverInfo.iconUrl ?? null
  });
  params.set('redirect_uri', redirectUri);

  window.location.href = serverAuthorizeUrl(remoteUrl, serverInfo.authorizeUrl, params);
}

export async function startRemoteReauthentication(server: RegisteredServer): Promise<void> {
  const info = await getPublicServerInfo(server.url, { signal: AbortSignal.timeout(10000) });
  await startServerOAuthFlow(server.url, {
    name: info.name || server.name,
    authorizeUrl: info.authorizeUrl,
    iconUrl: info.iconUrl ?? server.iconUrl
  });
}

export function beginOriginReauthentication(): void {
  const path = window.location.pathname + window.location.search;
  sessionStorage.setItem('returnUrl', path);
  clearCachedUser();
  serverRegistry.clearOriginAuthentication();

  const redirect =
    resolve('/login') +
    '?' +
    new URLSearchParams({
      error: 'authentication_required',
      redirect: path
    });
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- base route is resolved above; query parameters preserve the current app path
  void goto(redirect, { invalidateAll: true });
}
