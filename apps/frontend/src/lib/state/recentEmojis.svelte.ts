/**
 * Recently used emojis, per-server.
 *
 * Single source of truth for "what emojis has this user picked lately" on a
 * given server. Used by:
 * - The full emoji picker, which leads with a "Recently Used" section.
 * - The message quick-reaction bar / context menu / mobile action sheet,
 *   which fill the trailing (non-pinned) slots with these recents.
 *
 * State is keyed by server ID via {@link serverSlot}; switching servers
 * shows a different recent list.
 */

import {
  isCustomEmojiName,
  PINNED_REACTIONS,
  QUICK_REACTIONS_COUNT,
  RECENT_REACTION_FALLBACKS
} from '$lib/emoji';
import { getCustomEmojis, type CustomEmojisStore } from '$lib/state/customEmojis.svelte';
import { Codecs, serverSlot, type StorageSlot } from '$lib/storage/slot';

const STORAGE_SUFFIX = 'recentEmojis';
export const MAX_RECENT_EMOJIS = 16;

// Codec only checks "is an array"; individual entries are filtered on read
// so corrupt items don't invalidate the whole payload.
const emojiListCodec = Codecs.json<string[]>((v): v is string[] => Array.isArray(v));

export class RecentEmojisStore {
  /**
   * The raw persisted list, newest first. Entries are either a unicode glyph or
   * a custom-emoji shortcode name. Custom names are kept here even when the
   * emoji is currently unknown (deleted, or not yet loaded) so a transient
   * fetch failure cannot permanently erase a user's history; render surfaces
   * should read {@link renderable} instead.
   */
  recent = $state<string[]>([]);
  private storage: StorageSlot<string[]>;
  /**
   * Resolved once here rather than inside {@link renderable}. Looking it up in
   * the derived would lazily create the custom-emoji store mid-computation, and
   * that mutate-during-derived left the derived unable to track later loads.
   */
  private customEmojis: CustomEmojisStore;

  constructor(serverId: string) {
    this.customEmojis = getCustomEmojis(serverId);
    this.storage = serverSlot(serverId, STORAGE_SUFFIX, [], emojiListCodec);
    this.recent = this.storage
      .get()
      .filter((e): e is string => typeof e === 'string')
      .slice(0, MAX_RECENT_EMOJIS);
  }

  /**
   * Recents that can actually be displayed right now: unicode glyphs, plus
   * custom shortcodes that resolve against this server's loaded custom emojis.
   *
   * Unresolved custom names are dropped rather than rendered, since the bare
   * shortcode would otherwise show up as literal text (`partyparrot`). They
   * reappear on their own once the custom-emoji store loads, and stay hidden
   * for good if an admin deleted the emoji.
   */
  renderable: readonly string[] = $derived.by(() =>
    this.recent.filter(
      (entry) => !isCustomEmojiName(entry) || !!this.customEmojis.find(entry)
    )
  );

  record(emoji: string) {
    const filtered = this.recent.filter((e) => e !== emoji);
    this.recent = [emoji, ...filtered].slice(0, MAX_RECENT_EMOJIS);
    this.storage.set(this.recent);
  }

  /**
   * The quick-reactions list shown on the message hover bar / context menu /
   * mobile action sheet: pinned emojis followed by the user's most recent
   * non-pinned emojis on this server, backfilled with fallback defaults so
   * the list always has exactly {@link QUICK_REACTIONS_COUNT} entries.
   *
   * Draws from {@link renderable}, so an unresolvable custom emoji yields a
   * fallback rather than an empty slot.
   *
   * Declared as a $derived class field rather than a JS getter so consumers
   * across the app share one memoised computation that re-fires on `recent`
   * mutations — the getter form silently lost reactivity for some consumers.
   */
  quickReactions: readonly string[] = $derived.by(() => {
    const pinned = PINNED_REACTIONS as readonly string[];
    const result: string[] = [...pinned];
    const recent = [...this.renderable];

    for (const emoji of recent) {
      if (result.length >= QUICK_REACTIONS_COUNT) break;
      if (!result.includes(emoji)) result.push(emoji);
    }

    for (const emoji of RECENT_REACTION_FALLBACKS) {
      if (result.length >= QUICK_REACTIONS_COUNT) break;
      if (!result.includes(emoji)) result.push(emoji);
    }

    return result;
  });
}

// Private singleton registry. Reactivity comes from each store's $state.recent
// field; the Map itself is just an identity cache so the same serverId always
// returns the same store instance. A SvelteMap would invalidate readers on
// every first-access (mutate-during-derived), which is not the intent.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const stores = new Map<string, RecentEmojisStore>();

/** Get (or lazily create) the recent-emojis store for a given server. */
export function getRecentEmojis(serverId: string): RecentEmojisStore {
  let store = stores.get(serverId);
  if (!store) {
    store = new RecentEmojisStore(serverId);
    stores.set(serverId, store);
  }
  return store;
}

/** Test-only: clear the store cache so a fresh instance is built per test. */
export function __resetRecentEmojisForTests() {
  stores.clear();
}
