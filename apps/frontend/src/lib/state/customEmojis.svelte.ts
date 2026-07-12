/**
 * Custom emojis, per-server.
 *
 * Single source of truth for a server's admin-defined custom emojis. Custom
 * emojis are referenced by their shortcode `name` (never the unicode char);
 * the backend guarantees custom names never collide with built-in gemoji
 * shortcodes, so a reaction whose name is unknown to gemoji is a custom emoji.
 *
 * Used by:
 * - The emoji picker, which shows a "Custom" category.
 * - Message reactions, which resolve a reaction name to a {@link CustomEmoji}
 *   (with `.url`) and render its image instead of a unicode glyph.
 *
 * State is keyed by server via {@link normalizeServerKey}; the same server is
 * addressable both by its raw registry id (used by the picker) and by its URL
 * segment (used by message components), which normalize to one store instance.
 */

import {
  createCustomEmojiAPI,
  type CustomEmoji,
} from '$lib/api-client/customEmojis';
import type { ConnectAPIConfig } from '$lib/api-client/connect';
import { segmentToServerId } from '$lib/navigation';

export type { CustomEmoji };

export class CustomEmojisStore {
  emojis = $state<CustomEmoji[]>([]);
  /** True once a load has completed at least once. */
  loaded = $state(false);
  private loadPromise: Promise<void> | null = null;

  /**
   * Look up a custom emoji by shortcode name (case-insensitive), or `undefined`.
   * Reads the {@link emojis} state array directly so it is safe to call from
   * plain (non-reactive) helpers as well as component render.
   */
  find(name: string): CustomEmoji | undefined {
    const target = name.toLowerCase();
    return this.emojis.find((emoji) => emoji.name.toLowerCase() === target);
  }

  /** Fetch the server's custom emojis, replacing local state. */
  async load(config: ConnectAPIConfig): Promise<void> {
    try {
      this.emojis = await createCustomEmojiAPI(config).list();
      this.loaded = true;
    } catch {
      // Leave existing state intact on failure; callers fall back to raw names.
    }
  }

  /**
   * Load once for this server. Concurrent callers share the same in-flight
   * request, and later callers after a successful load are no-ops. Safe to
   * call from many message components without refetching per message.
   */
  ensureLoaded(config: ConnectAPIConfig): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = this.load(config).finally(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }
}

// Private singleton registry. Reactivity comes from each store's $state fields;
// the Map itself is an identity cache so a given server always resolves to the
// same store instance.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const stores = new Map<string, CustomEmojisStore>();

/**
 * Normalize a server identifier to a stable key. Accepts either a raw registry
 * id or a URL segment; both resolve to the same key so the picker (raw id) and
 * message components (segment) share one store.
 */
function normalizeServerKey(serverId: string): string {
  return segmentToServerId(serverId) ?? serverId;
}

/** Get (or lazily create) the custom-emoji store for a given server. */
export function getCustomEmojis(serverId: string): CustomEmojisStore {
  const key = normalizeServerKey(serverId);
  let store = stores.get(key);
  if (!store) {
    store = new CustomEmojisStore();
    stores.set(key, store);
  }
  return store;
}

/**
 * Resolve a reaction/shortcode name to a custom emoji for a server, or
 * `undefined` if the name is not a known custom emoji (e.g. a gemoji name or
 * the store has not loaded yet).
 */
export function getCustomEmoji(
  serverId: string,
  name: string
): CustomEmoji | undefined {
  return getCustomEmojis(serverId).find(name);
}

/** Test-only: clear the store cache so a fresh instance is built per test. */
export function __resetCustomEmojisForTests() {
  stores.clear();
}
