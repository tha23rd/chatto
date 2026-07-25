import { describe, it, expect, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import {
  CustomEmojisStore,
  getCustomEmojis,
  __resetCustomEmojisForTests
} from './customEmojis.svelte';
import type { CustomEmoji } from '$lib/api-client/customEmojis';

function emoji(id: string, name: string): CustomEmoji {
  return { id, name, url: `https://example.test/assets/emoji/${id}` } as CustomEmoji;
}

describe('CustomEmojisStore', () => {
  beforeEach(() => __resetCustomEmojisForTests());

  it('upsert adds newest-first and marks the store loaded', () => {
    const store = new CustomEmojisStore();
    expect(store.loaded).toBe(false);

    store.upsert(emoji('1', 'alpha'));
    store.upsert(emoji('2', 'beta'));

    expect(store.emojis.map((e) => e.name)).toEqual(['beta', 'alpha']);
    expect(store.loaded).toBe(true);
    expect(store.find('ALPHA')?.id).toBe('1');
  });

  it('upsert replaces an existing emoji by id without duplicating', () => {
    const store = new CustomEmojisStore();
    store.upsert(emoji('1', 'alpha'));
    store.upsert({ ...emoji('1', 'alpha'), url: 'https://example.test/new' } as CustomEmoji);

    expect(store.emojis).toHaveLength(1);
    expect(store.emojis[0].url).toBe('https://example.test/new');
  });

  it('remove deletes by id', () => {
    const store = new CustomEmojisStore();
    store.upsert(emoji('1', 'alpha'));
    store.upsert(emoji('2', 'beta'));

    store.remove('1');

    expect(store.emojis.map((e) => e.id)).toEqual(['2']);
    expect(store.find('alpha')).toBeUndefined();
  });

  it('shares one instance per server so an upsert is visible everywhere', () => {
    // The admin settings view and the picker resolve the same server to the
    // same store instance; a mutation in one is seen by the other.
    const adminView = getCustomEmojis('server_abc');
    const picker = getCustomEmojis('server_abc');
    expect(adminView).toBe(picker);

    adminView.upsert(emoji('9', 'pepeperfect'));
    expect(picker.find('pepeperfect')?.id).toBe('9');
  });

  // `find` resolves through a lowercase-name index rather than rescanning the
  // array, because quick-reaction surfaces call it per recent entry per mounted
  // message row. The index is keyed on array identity, so every writer must
  // invalidate it.
  describe('name index', () => {
    it('reflects an upsert that replaces an emoji of the same name', () => {
      const store = new CustomEmojisStore();
      store.upsert(emoji('1', 'parrot'));
      expect(store.find('parrot')?.id).toBe('1');

      store.remove('1');
      store.upsert(emoji('2', 'parrot'));
      expect(store.find('parrot')?.id).toBe('2');
    });

    it('goes stale for no lookup after a removal', () => {
      const store = new CustomEmojisStore();
      store.upsert(emoji('1', 'alpha'));
      store.upsert(emoji('2', 'beta'));
      expect(store.find('alpha')?.id).toBe('1');

      store.remove('1');
      expect(store.find('alpha')).toBeUndefined();
      expect(store.find('beta')?.id).toBe('2');
    });

    it('matches case-insensitively in both directions', () => {
      const store = new CustomEmojisStore();
      store.upsert(emoji('1', 'PartyParrot'));
      expect(store.find('partyparrot')?.id).toBe('1');
      expect(store.find('PARTYPARROT')?.id).toBe('1');
    });

    it('resolves a duplicated name to the newest entry, as a linear scan did', () => {
      const store = new CustomEmojisStore();
      store.upsert(emoji('old', 'parrot'));
      store.upsert(emoji('new', 'parrot'));
      // upsert keeps the list newest-first and these have distinct ids, so both
      // survive; the newest must win.
      expect(store.emojis.map((e) => e.id)).toEqual(['new', 'old']);
      expect(store.find('parrot')?.id).toBe('new');
    });

    it('does not resolve prototype members as emojis', () => {
      // The index is a null-prototype record, so a reaction keyed `constructor`
      // or `__proto__` must miss rather than return an Object member.
      const store = new CustomEmojisStore();
      store.upsert(emoji('1', 'parrot'));

      expect(store.find('constructor')).toBeUndefined();
      expect(store.find('__proto__')).toBeUndefined();
      expect(store.find('toString')).toBeUndefined();
    });

    it('stays reactive: a reader re-runs when the emoji list changes', () => {
      const store = new CustomEmojisStore();
      let resolved: string | undefined;
      const cleanup = $effect.root(() => {
        $effect(() => {
          resolved = store.find('parrot')?.id;
        });
      });
      flushSync();
      expect(resolved).toBeUndefined();

      store.upsert(emoji('1', 'parrot'));
      flushSync();
      expect(resolved).toBe('1');
      cleanup();
    });
  });
});
