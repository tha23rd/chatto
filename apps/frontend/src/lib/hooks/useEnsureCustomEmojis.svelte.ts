import { getCustomEmojis } from '$lib/state/customEmojis.svelte';
import { useServerScope } from '$lib/state/server/scope.svelte';

/**
 * Ensure a server's custom emojis are loaded for the lifetime of the calling
 * component.
 *
 * The message quick-reaction surfaces (hover bar, context menu, mobile action
 * sheet) can show a recent custom emoji, which only renders as an image once
 * this server's custom-emoji store has loaded. Each of those surfaces can be
 * the first thing to need them, so each ensures the load itself; the fetch is
 * idempotent per server, so overlapping callers share one request.
 *
 * Must be called during component initialization (it reads the server scope
 * and registers an `$effect`). Pass `serverId` as a getter so the load follows
 * a changing server.
 */
export function useEnsureCustomEmojis(serverId: () => string): void {
  const scope = useServerScope();
  $effect(() => {
    const connection = scope.connection;
    getCustomEmojis(serverId()).ensureLoaded({
      serverId: connection.serverId,
      baseUrl: connection.connectBaseUrl,
      bearerToken: connection.bearerToken
    });
  });
}
