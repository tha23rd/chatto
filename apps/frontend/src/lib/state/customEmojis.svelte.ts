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
   * Lowercase-name index over {@link emojis}, so {@link find} does not rescan
   * the array per call. Rebuilt whenever the array identity changes; every
   * writer here assigns a fresh array, so identity is a sound cache key.
   *
   * Deliberately non-reactive: this store is a lazily created module singleton,
   * so a `$derived` declared here would be owned by whichever component reaction
   * first constructed the store and would go inert once that component
   * unmounted, and a `SvelteMap` would invalidate readers as it filled during
   * their own render. Reactivity comes from the {@link emojis} read in
   * {@link find}; the index is a private cache hanging off it.
   *
   * A null-prototype record rather than a `Map`, so admin-chosen shortcodes such
   * as `constructor` cannot collide with prototype members.
   */
  private index: Record<string, CustomEmoji | undefined> = Object.create(null);
  private indexedFrom: CustomEmoji[] | null = null;

  /**
   * Look up a custom emoji by shortcode name (case-insensitive), or `undefined`.
   * Reads the {@link emojis} state array directly so it is safe to call from
   * plain (non-reactive) helpers as well as component render, and so callers
   * inside a reaction still track later loads and edits.
   */
  find(name: string): CustomEmoji | undefined {
    const emojis = this.emojis;
    if (this.indexedFrom !== emojis) {
      const index: Record<string, CustomEmoji | undefined> = Object.create(null);
      // First entry wins, matching the previous `Array.find` scan: `upsert`
      // keeps the list newest-first, so a duplicated name resolves to the
      // newest emoji.
      for (const emoji of emojis) {
        const key = emoji.name.toLowerCase();
        if (index[key] === undefined) index[key] = emoji;
      }
      this.index = index;
      this.indexedFrom = emojis;
    }
    return this.index[name.toLowerCase()];
  }

  /**
   * Insert or replace an emoji by id, keeping newest-first order. Call after a
   * successful create so every surface reading this store (picker, composer,
   * reactions) updates immediately without a client reload.
   */
  upsert(emoji: CustomEmoji): void {
    this.emojis = [emoji, ...this.emojis.filter((existing) => existing.id !== emoji.id)];
    this.loaded = true;
  }

  /** Remove an emoji by id. Call after a successful delete. */
  remove(id: string): void {
    this.emojis = this.emojis.filter((existing) => existing.id !== id);
  }

  /**
   * Fetch the server's custom emojis, replacing local state. Returns `true` on
   * success and `false` on failure; on failure existing state is left intact so
   * passive callers keep working, while the admin view can surface an error.
   */
  async load(config: ConnectAPIConfig): Promise<boolean> {
    try {
      this.emojis = await createCustomEmojiAPI(config).list();
      this.loaded = true;
      return true;
    } catch {
      // Leave existing state intact on failure; callers fall back to raw names.
      return false;
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
      this.loadPromise = this.load(config)
        .then(() => {})
        .finally(() => {
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
