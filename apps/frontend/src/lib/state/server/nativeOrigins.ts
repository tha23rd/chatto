/**
 * Native-host origin leases for registered servers.
 *
 * The desktop host refuses traffic to any origin it holds no lease for, so a
 * server needs one for as long as it stays registered. The host reference-counts
 * per origin, so each acquire needs exactly one release — two servers may share
 * an origin, and dropping one must not disarm the other.
 *
 * Kept out of `registry.svelte.ts` so upstream's frequent restructuring there
 * only ever costs us a few call sites. See docs/FORK-MAINTENANCE.md.
 */

import { getNativeHost } from '$lib/native/host';
import type { Unsubscribe } from '$lib/native/types';

/** Tracks one native-host origin lease per registered server id. */
export class NativeServerOrigins {
  // Plain Map: leases are not rendered, so reactivity would only add overhead.
  readonly #leases = new Map<string, { url: string; release: Unsubscribe }>();

  /**
   * Hold a lease on `url` for `serverId`, replacing any lease it holds for a
   * different origin. Re-registering the same URL is a no-op.
   */
  register(serverId: string, url: string): void {
    const existing = this.#leases.get(serverId);
    if (existing?.url === url) return;
    // Acquire before releasing, or a shared origin's count hits zero in between.
    const release = getNativeHost().registerServerOrigin(url);
    existing?.release();
    this.#leases.set(serverId, { url, release });
  }

  /** Drop this server's lease. Safe to call for a server that holds none. */
  release(serverId: string): void {
    const lease = this.#leases.get(serverId);
    if (!lease) return;
    this.#leases.delete(serverId);
    lease.release();
  }
}
