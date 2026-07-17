/**
 * Soundboard sounds, per-server.
 *
 * Single source of truth for a server's admin-curated soundboard catalog.
 * Sounds are immutable once uploaded (create + delete only) and are played
 * into an active voice call so every participant hears them.
 *
 * Used by:
 * - The server-admin soundboard settings view, which lists/creates/deletes.
 * - The in-call soundboard panel, which lists sounds and plays them into the
 *   LiveKit room.
 *
 * State is keyed by server via {@link normalizeServerKey}; the same server is
 * addressable both by its raw registry id and by its URL segment, which
 * normalize to one store instance.
 */

import { createSoundboardAPI, type Sound } from '$lib/api-client/soundboard';
import type { ConnectAPIConfig } from '$lib/api-client/connect';
import { segmentToServerId } from '$lib/navigation';

export type { Sound };

export class SoundboardStore {
  sounds = $state<Sound[]>([]);
  /** True once a load has completed at least once. */
  loaded = $state(false);
  private loadPromise: Promise<void> | null = null;

  /** Look up a sound by id, or `undefined`. */
  find(id: string): Sound | undefined {
    return this.sounds.find((sound) => sound.id === id);
  }

  /**
   * Insert or replace a sound by id, keeping newest-first order. Call after a
   * successful create so every surface reading this store (admin list, in-call
   * panel) updates immediately without a client reload.
   */
  upsert(sound: Sound): void {
    this.sounds = [sound, ...this.sounds.filter((existing) => existing.id !== sound.id)];
    this.loaded = true;
  }

  /** Remove a sound by id. Call after a successful delete. */
  remove(id: string): void {
    this.sounds = this.sounds.filter((existing) => existing.id !== id);
  }

  /**
   * Fetch the server's sounds, replacing local state. Returns `true` on
   * success and `false` on failure; on failure existing state is left intact so
   * passive callers keep working, while the admin view can surface an error.
   */
  async load(config: ConnectAPIConfig): Promise<boolean> {
    try {
      this.sounds = await createSoundboardAPI(config).list();
      this.loaded = true;
      return true;
    } catch {
      // Leave existing state intact on failure.
      return false;
    }
  }

  /**
   * Load once for this server. Concurrent callers share the same in-flight
   * request, and later callers after a successful load are no-ops.
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
const stores = new Map<string, SoundboardStore>();

/**
 * Normalize a server identifier to a stable key. Accepts either a raw registry
 * id or a URL segment; both resolve to the same key so the admin view and the
 * in-call panel share one store.
 *
 * `segmentToServerId` reads the server registry, which is not always ready when
 * the in-call panel first resolves its store (or in tests with a partial
 * registry). Fall back to the raw id in that case rather than throwing — the
 * raw id is itself a stable key.
 */
function normalizeServerKey(serverId: string): string {
  try {
    return segmentToServerId(serverId) ?? serverId;
  } catch {
    return serverId;
  }
}

/** Get (or lazily create) the soundboard store for a given server. */
export function getSoundboard(serverId: string): SoundboardStore {
  const key = normalizeServerKey(serverId);
  let store = stores.get(key);
  if (!store) {
    store = new SoundboardStore();
    stores.set(key, store);
  }
  return store;
}

/** Test-only: clear the store cache so a fresh instance is built per test. */
export function __resetSoundboardForTests() {
  stores.clear();
}
