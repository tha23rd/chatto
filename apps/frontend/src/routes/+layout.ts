import '$lib/apiClientHooks';
import { loadCurrentUser } from '$lib/auth/loadAuth';
import { getPublicServerInfo } from '$lib/api-client/server';
import { getNativeClient } from '$lib/native/client';
import { preloadActiveLocaleMessages } from '$lib/i18n/messages';
import type { LayoutLoad } from './$types';

// SPA mode - no server-side rendering
export const ssr = false;

export const load: LayoutLoad = async ({ url }) => {
  await preloadActiveLocaleMessages();

  const [serverInfo, user] = await Promise.all([
    // The desktop client's origin is the app bundle, not a Chatto server, so
    // there is no public server info to discover — skip the probe (it would
    // 405 against the app protocol). Web deployments still discover their origin.
    getNativeClient() ? Promise.resolve(null) : getPublicServerInfo(url.origin).catch(() => null),
    loadCurrentUser()
  ]);

  return {
    serverInfo,
    serverInfoLoaded: true,
    user
  };
};
