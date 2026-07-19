import { page } from '$app/state';
import { segmentToServerId } from '$lib/navigation';
import { serverRegistry } from './server/registry.svelte';

/**
 * Returns the active server ID, derived from the URL `[serverId]` segment.
 * Falls back to the origin server when the URL has no segment (or the
 * "-" placeholder). When there is no origin server (static hosting or the
 * bundled desktop client, whose origin is the app bundle rather than a Chatto
 * server), fall back to the first registered server so app chrome such as the
 * current-user/presence bar binds to a real, authenticated server instead of
 * an empty context.
 *
 * Reactive when called inside `$derived` / `$effect` / template — the
 * `page.params` and `serverRegistry` reads track via Svelte's normal
 * reactivity. No context, no getter dance: just a function that resolves the
 * value on every call.
 */
export function getActiveServer(): string {
  return (
    segmentToServerId(page.params.serverId ?? '-')
    ?? serverRegistry.originServer?.id
    ?? serverRegistry.servers[0]?.id
    ?? ''
  );
}
