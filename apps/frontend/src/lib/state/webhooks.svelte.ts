/**
 * Channel webhooks, per-server (FDR-902).
 *
 * Single source of truth for a server's admin-defined channel webhooks, used
 * by the server management webhooks page. Unlike custom emojis this
 * store is admin-only: webhooks are not referenced by ordinary chat surfaces,
 * so there is no picker/typeahead consumer to keep in sync — the store just
 * gives the admin page a shared, refreshable list across mount/unmount.
 *
 * State is keyed by server via {@link normalizeServerKey}, matching the
 * pattern used by the custom emoji store.
 */

import { createAdminWebhookAPI, type WebhookView } from '$lib/api-client/webhooks';
import type { ConnectAPIConfig } from '$lib/api-client/connect';
import { segmentToServerId } from '$lib/navigation';

export type { WebhookView };

export class WebhooksStore {
  webhooks = $state<WebhookView[]>([]);
  /** True once a load has completed at least once. */
  loaded = $state(false);
  private loadPromise: Promise<void> | null = null;

  /**
   * Insert or replace a webhook by id, keeping newest-first order. Call after
   * a successful create/update/regenerate so the admin list reflects the
   * change immediately without a reload.
   */
  upsert(webhook: WebhookView): void {
    this.webhooks = [webhook, ...this.webhooks.filter((existing) => existing.id !== webhook.id)];
    this.loaded = true;
  }

  /** Remove a webhook by id. Call after a successful delete. */
  remove(id: string): void {
    this.webhooks = this.webhooks.filter((existing) => existing.id !== id);
  }

  /**
   * Fetch the server's webhooks, replacing local state. Returns `true` on
   * success and `false` on failure; on failure existing state is left intact
   * so the admin view can surface an error without clearing the list.
   */
  async load(config: ConnectAPIConfig): Promise<boolean> {
    try {
      this.webhooks = await createAdminWebhookAPI(config).list();
      this.loaded = true;
      return true;
    } catch {
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
const stores = new Map<string, WebhooksStore>();

/**
 * Normalize a server identifier to a stable key. Accepts either a raw registry
 * id or a URL segment so callers do not need to know which form they hold.
 */
function normalizeServerKey(serverId: string): string {
  return segmentToServerId(serverId) ?? serverId;
}

/** Get (or lazily create) the webhooks store for a given server. */
export function getWebhooks(serverId: string): WebhooksStore {
  const key = normalizeServerKey(serverId);
  let store = stores.get(key);
  if (!store) {
    store = new WebhooksStore();
    stores.set(key, store);
  }
  return store;
}

/** Test-only: clear the store cache so a fresh instance is built per test. */
export function __resetWebhooksForTests() {
  stores.clear();
}
