import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SoundboardStore,
  getSoundboard,
  notifySoundboard,
  __resetSoundboardForTests
} from './soundboard.svelte';
import type { Sound } from '$lib/api-client/soundboard';
import type { Sound as SoundProto } from '@chatto/api-types/api/v1/soundboard_pb';

const { listSounds } = vi.hoisted(() => ({ listSounds: vi.fn<() => Promise<Sound[]>>() }));

// Only the list call is faked; mapSound stays real so the projection path is
// exercised end to end.
vi.mock('$lib/api-client/soundboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/api-client/soundboard')>()),
  createSoundboardAPI: () => ({ list: listSounds })
}));

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
  beforeEach(() => {
    __resetSoundboardForTests();
    listSounds.mockReset();
  });

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

  it('replace swaps in an authoritative catalog and marks the store loaded', () => {
    const store = new SoundboardStore();
    store.upsert(sound('1', 'airhorn'));

    store.replace([sound('2', 'wow'), sound('3', 'tada')]);

    expect(store.sounds.map((s) => s.id)).toEqual(['2', '3']);
    expect(store.loaded).toBe(true);
    expect(store.find('1')).toBeUndefined();
  });

  it('replace during an in-flight load wins so a deleted sound cannot come back', async () => {
    const store = new SoundboardStore();
    let releaseList: (sounds: Sound[]) => void = () => {};
    const listed = new Promise<Sound[]>((resolve) => {
      releaseList = resolve;
    });
    listSounds.mockReturnValue(listed);

    const load = store.load({} as Parameters<SoundboardStore['load']>[0]);
    // A realtime replace lands first: the sound the list response still carries
    // has already been deleted server-side.
    store.replace([sound('2', 'wow')]);
    releaseList([sound('1', 'airhorn'), sound('2', 'wow')]);

    await expect(load).resolves.toBe(true);
    expect(store.sounds.map((s) => s.id)).toEqual(['2']);
  });

  it('notifySoundboard applies a projection catalog to the shared store', () => {
    notifySoundboard('server_abc', [
      {
        id: '1',
        name: 'airhorn',
        url: 'https://example.test/assets/sound/1',
        emoji: '📣',
        volume: 0.5,
        durationMs: 2_000n
      } as unknown as SoundProto
    ]);

    const sounds = getSoundboard('server_abc').sounds;
    expect(sounds).toHaveLength(1);
    // bigint durations become numbers, exactly as the ConnectRPC mapper does.
    expect(sounds[0]).toMatchObject({ id: '1', name: 'airhorn', durationMs: 2_000 });
    expect(getSoundboard('server_abc').loaded).toBe(true);
  });

  it('shares one instance per server so an upsert is visible everywhere', () => {
    const adminView = getSoundboard('server_abc');
    const panel = getSoundboard('server_abc');
    expect(adminView).toBe(panel);

    adminView.upsert(sound('9', 'tada'));
    expect(panel.find('9')?.name).toBe('tada');
  });
});
