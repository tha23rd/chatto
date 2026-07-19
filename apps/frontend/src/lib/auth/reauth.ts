import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { getPublicServerInfo, type PublicServerInfo } from '$lib/api-client/server';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  saveFlowState
} from '$lib/oauth/pkce';
import { serverRegistry, type RegisteredServer } from '$lib/state/server/registry.svelte';
import { clearCachedUser } from './loadAuth';
import { navigateToAuthorization, resolveOAuthRedirectUri } from '$lib/native/oauth';

export async function startServerOAuthFlow(
  serverUrl: string,
  serverInfo: Pick<PublicServerInfo, 'name' | 'authorizeUrl' | 'iconUrl'>
): Promise<void> {
  if (!serverInfo.authorizeUrl) {
    throw new Error('This server does not support OAuth sign-in.');
  }

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();
  const redirectUri = await resolveOAuthRedirectUri(serverUrl);

  saveFlowState({
    verifier,
    state,
    remoteUrl: serverUrl,
    serverName: serverInfo.name,
    serverIconUrl: serverInfo.iconUrl ?? null,
    redirectUri
  });

  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  });

  const authorizeUrl = new URL(serverInfo.authorizeUrl, serverUrl);
  authorizeUrl.search = params.toString();
  await navigateToAuthorization(authorizeUrl.toString());
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

  const redirect = resolve('/login') + '?' + new URLSearchParams({
    error: 'authentication_required',
    redirect: path
  });
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- base route is resolved above; query parameters preserve the current app path
  void goto(redirect, { invalidateAll: true });
}
