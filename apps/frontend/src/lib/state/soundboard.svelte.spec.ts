import { describe, it, expect, beforeEach } from 'vitest';
import { SoundboardStore, getSoundboard, __resetSoundboardForTests } from './soundboard.svelte';
import type { Sound } from '$lib/api-client/soundboard';

function sound(id: string, name: string): Sound {
  return {
    id,
    name,
    url: `https://example.test/assets/sound/${id}`,
    emoji: '',
    volume: 1,
    durationMs: 1000
  } as Sound;
}

describe('SoundboardStore', () => {
  beforeEach(() => __resetSoundboardForTests());

  it('upsert adds newest-first and marks the store loaded', () => {
    const store = new SoundboardStore();
    expect(store.loaded).toBe(false);

    store.upsert(sound('1', 'airhorn'));
    store.upsert(sound('2', 'wow'));

    expect(store.sounds.map((s) => s.name)).toEqual(['wow', 'airhorn']);
    expect(store.loaded).toBe(true);
    expect(store.find('1')?.name).toBe('airhorn');
  });

  it('upsert replaces an existing sound by id without duplicating', () => {
    const store = new SoundboardStore();
    store.upsert(sound('1', 'airhorn'));
    store.upsert({ ...sound('1', 'airhorn'), volume: 0.5 } as Sound);

    expect(store.sounds).toHaveLength(1);
    expect(store.sounds[0].volume).toBe(0.5);
  });

  it('remove deletes by id', () => {
    const store = new SoundboardStore();
    store.upsert(sound('1', 'airhorn'));
    store.upsert(sound('2', 'wow'));

    store.remove('1');

    expect(store.sounds.map((s) => s.id)).toEqual(['2']);
    expect(store.find('1')).toBeUndefined();
  });

  it('shares one instance per server so an upsert is visible everywhere', () => {
    const adminView = getSoundboard('server_abc');
    const panel = getSoundboard('server_abc');
    expect(adminView).toBe(panel);

    adminView.upsert(sound('9', 'tada'));
    expect(panel.find('9')?.name).toBe('tada');
  });
});
