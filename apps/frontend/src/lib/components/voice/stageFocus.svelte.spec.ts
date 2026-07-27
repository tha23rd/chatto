/**
 * Covers click-to-focus on the call stage: clicking a stream enlarges it and
 * pushes everyone else below, until the same stream is clicked again or it goes
 * away.
 *
 * Focus is held as participant + surface rather than as a tile key, because a
 * participant tile's key changes kind when their camera goes on or off. The
 * regression these tests guard is a focused person silently losing the stage the
 * moment they toggle their camera.
 *
 * Component tests because focus feeds the same `$derived` chain that picks the
 * featured tile, and e2e cannot join a real LiveKit call in CI (see the header
 * of e2e/voice-call.spec.ts).
 *
 * The harness's 'screen' scenario seeds Dana (screen share, auto-featured),
 * Alice (the local viewer, camera on), Bob (camera on), and Chloe (voice-only).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import { serverRegistry } from '$lib/state/server/registry.svelte';
import { userPreferences } from '$lib/state/userPreferences.svelte';
import VoiceCallPanelStoryHarness from './VoiceCallPanelStoryHarness.svelte';

function featuredTitle(container: Element): string | null {
  return q(container, '[data-testid="call-featured-stage-card"]')?.getAttribute('title') ?? null;
}

/** The media button of a secondary tile, addressed by its card title. */
function secondaryMediaButton(container: Element, title: string): HTMLElement | null {
  return q(
    container,
    `[data-testid="call-secondary-stage-list"] [title="${title}"] [data-testid="call-tile-media-button"]`
  );
}

function featuredMediaButton(container: Element): HTMLElement | null {
  return q(
    container,
    '[data-testid="call-featured-stage-card"] [data-testid="call-tile-media-button"]'
  );
}

async function renderStage() {
  const { container } = render(VoiceCallPanelStoryHarness, {
    props: { layout: 'stage' as const, scenario: 'screen' as const }
  });

  // Generous timeout: the harness imports the panel lazily, so a cold Vite transform
  // can push the first mount past the 1s default while the module is still compiling.
  await expect.poll(() => featuredTitle(container), { timeout: 15000 }).toBe("Dana's screen");
  return container;
}

describe('call stage focus', () => {
  beforeEach(() => {
    userPreferences.callView = {
      grid: false,
      showOwnCamera: true,
      showNonVideoParticipants: true,
      showOwnScreenShare: true,
      collapsedStrip: false
    };
  });

  it('focuses a stream on click and falls back to grid when clicked again', async () => {
    const container = await renderStage();

    secondaryMediaButton(container, 'Bob')!.click();
    await expect.poll(() => featuredTitle(container)).toBe('Bob');

    // Releasing focus lands in grid rather than on another single feed: having just said
    // "not this one", showing everything at once is the useful answer.
    featuredMediaButton(container)!.click();
    await expect.poll(() => q(container, '[data-testid="call-grid-stage-list"]')).not.toBeNull();
    expect(featuredTitle(container)).toBeNull();
    // The stored preference follows, so the menu never disagrees with the screen.
    expect(userPreferences.callView.grid).toBe(true);
  });

  it('keeps a focused participant featured when their camera goes off and on', async () => {
    const container = await renderStage();

    secondaryMediaButton(container, 'Bob')!.click();
    await expect.poll(() => featuredTitle(container)).toBe('Bob');

    const store = serverRegistry.getStore(serverRegistry.originServer!.id);
    const withCamera = store.voiceCall.participants;

    // Bob turns his camera off: his tile changes kind, but focus follows the
    // person rather than the tile identity.
    store.voiceCall.participants = withCamera.map((p) =>
      p.identity === 'bob' ? { ...p, isCameraEnabled: false, videoTrack: null } : p
    );
    await expect.poll(() => featuredTitle(container)).toBe('Bob');

    // ...and back on again.
    store.voiceCall.participants = withCamera;
    await expect.poll(() => featuredTitle(container)).toBe('Bob');
  });

  it('falls back to the automatic pick while a focused participant is gone', async () => {
    const container = await renderStage();

    secondaryMediaButton(container, 'Bob')!.click();
    await expect.poll(() => featuredTitle(container)).toBe('Bob');

    const store = serverRegistry.getStore(serverRegistry.originServer!.id);
    const withBob = store.voiceCall.participants;
    store.voiceCall.participants = withBob.filter((p) => p.identity !== 'bob');
    await expect.poll(() => featuredTitle(container)).toBe("Dana's screen");

    // Bob rejoins: the still-held focus takes the stage again.
    store.voiceCall.participants = withBob;
    await expect.poll(() => featuredTitle(container)).toBe('Bob');
  });

  it('takes over from grid view until the focus is released', async () => {
    const container = await renderStage();
    userPreferences.setCallViewPreference('grid', true);
    await expect.poll(() => q(container, '[data-testid="call-grid-stage-list"]')).not.toBeNull();

    q(
      container,
      `[data-testid="call-grid-stage-list"] [title="Bob"] [data-testid="call-tile-media-button"]`
    )!.click();

    // Focusing is an explicit "show me this now", so it wins over the grid.
    await expect.poll(() => featuredTitle(container)).toBe('Bob');
    expect(q(container, '[data-testid="call-grid-stage-list"]')).toBeNull();

    featuredMediaButton(container)!.click();

    // Releasing it returns to the grid the viewer asked for.
    await expect.poll(() => q(container, '[data-testid="call-grid-stage-list"]')).not.toBeNull();
  });
});
