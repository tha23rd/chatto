import * as m from '$lib/i18n/messages';
import { getNativeClient } from './client';

/**
 * Resolve the OAuth `redirect_uri` for the current environment.
 *
 * On the web this is the SPA callback route. In the native shell the main
 * process registers a one-shot loopback URI (so the authorization code never
 * enters the privileged window), and the short-lived origin probe grant is
 * renewed for the explicit sign-in action.
 */
export async function resolveOAuthRedirectUri(serverUrl: string): Promise<string> {
	const webRedirect = `${window.location.origin}/servers/callback`;
	const nativeClient = getNativeClient();
	if (!nativeClient) return webRedirect;

	const serverOrigin = new URL(serverUrl).origin;
	nativeClient.allowServerOriginForProbe(serverOrigin);
	return nativeClient.prepareOAuthFlow({
		serverOrigin,
		callbackLabels: {
			title: m['native.callback.title'](),
			message: m['native.callback.message']()
		}
	});
}

/**
 * Send the user to the server's authorization URL. The web navigates the
 * current tab; the native shell opens the system browser and keeps remote
 * authorization UI out of the privileged window.
 */
export async function navigateToAuthorization(authorizeUrl: string): Promise<void> {
	const nativeClient = getNativeClient();
	if (nativeClient) await nativeClient.openExternalAuth(authorizeUrl);
	else window.location.href = authorizeUrl;
}
