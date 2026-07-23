/**
 * Covers the last piece of the soundboard propagation fix that e2e cannot reach.
 *
 * The in-call soundboard button is gated on `soundboardConfigured && sounds.length > 0`.
 * That `sounds.length` gate is why a live catalog update was not enough on its own:
 * when a server had no sounds at the moment a member joined a call, there was no
 * button to open, so the clip had nowhere to appear. The button therefore has to
 * appear reactively when the shared store gains its first sound.
 *
 * This is a component test rather than e2e because the button also requires
 * `voiceCallState.isInCall(roomId)`, which needs a real LiveKit WebRTC connection
 * that CI does not have (see the header of e2e/voice-call.spec.ts).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { getSoundboard, __resetSoundboardForTests } from '$lib/state/soundboard.svelte';
import type { Sound } from '$lib/api-client/soundboard';
import { serverRegistry } from '$lib/state/server/registry.svelte';
import SoundboardButtonHarness from './SoundboardButtonHarness.svelte';

const SERVER_ID = 'soundboard-button-server';

function sound(id: string, name: string): Sound {
  return {
    id,
    name,
    url: `https://example.test/assets/sound/${id}`,
    emoji: '📣',
    volume: 1,
    durationMs: 1000
  };
}

/** The store the panel resolves through `getActiveServer()`. */
function activeSoundboard() {
  return getSoundboard(serverRegistry.originServer?.id ?? SERVER_ID);
}

describe('in-call soundboard button', () => {
  beforeEach(() => {
    __resetSoundboardForTests();
    // The panel's lazy soundboard load would otherwise reach the network. Seeding
    // the store as already loaded makes ensureLoaded a no-op, so each test drives
    // the catalog explicitly.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appears when the catalog gains its first sound while in a call', async () => {
    // Present but empty: exactly the state of a server with no sounds yet.
    getSoundboard(SERVER_ID).replace([]);

    const screen = render(SoundboardButtonHarness, { props: { serverId: SERVER_ID } });

    // The panel itself mounts (proving the in-call gate is satisfied) but offers
    // no soundboard while the catalog is empty.
    await expect.element(screen.getByTestId('call-mute-toggle')).toBeInTheDocument();
    await expect.element(screen.getByTestId('call-soundboard-button')).not.toBeInTheDocument();

    // A live projection update is what calls replace() in production.
    activeSoundboard().replace([sound('1', 'airhorn')]);

    await expect.element(screen.getByTestId('call-soundboard-button')).toBeInTheDocument();
  });

  it('disappears again when the last sound is deleted', async () => {
    getSoundboard(SERVER_ID).replace([sound('1', 'airhorn')]);

    const screen = render(SoundboardButtonHarness, { props: { serverId: SERVER_ID } });

    await expect.element(screen.getByTestId('call-soundboard-button')).toBeInTheDocument();

    activeSoundboard().replace([]);

    await expect.element(screen.getByTestId('call-soundboard-button')).not.toBeInTheDocument();
  });

  it('opens a panel listing the sound the catalog gained', async () => {
    getSoundboard(SERVER_ID).replace([]);

    const screen = render(SoundboardButtonHarness, { props: { serverId: SERVER_ID } });
    await expect.element(screen.getByTestId('call-mute-toggle')).toBeInTheDocument();

    activeSoundboard().replace([sound('1', 'airhorn')]);

    const button = screen.getByTestId('call-soundboard-button');
    await expect.element(button).toBeInTheDocument();
    await button.click();

    // The clip is playable, not merely counted: the grid renders a trigger for it.
    await expect.element(screen.getByTestId('soundboard-sound-grid')).toBeInTheDocument();
    await expect.element(screen.getByTestId('soundboard-sound-button')).toBeInTheDocument();
  });
});
