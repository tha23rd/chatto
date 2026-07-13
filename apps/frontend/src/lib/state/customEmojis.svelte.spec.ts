import { describe, it, expect, beforeEach } from 'vitest';
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
});
