/**
 * Covers stopping and resuming one specific feed: dropping a single camera or screen
 * share without touching anyone else's.
 *
 * "Stop watching" unsubscribes the track, so the tile has no picture left to show. The
 * card stays regardless, because the control that resumes the feed lives on it, and a
 * stopped feed must not be handed the featured slot or stopping it would enlarge it.
 *
 * The store's own subscription behaviour is covered in voiceCall.svelte.spec.ts; these
 * are component tests for how the stage responds, and e2e cannot join a real LiveKit
 * call in CI (see the header of e2e/voice-call.spec.ts).
 *
 * The harness's 'screen' scenario seeds Dana (screen share, auto-featured), Alice (the
 * local viewer, camera on), Bob (camera on), and Chloe (voice-only, poor connection).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import { userPreferences } from '$lib/state/userPreferences.svelte';
import VoiceCallPanelStoryHarness from './VoiceCallPanelStoryHarness.svelte';

function featuredTitle(container: Element): string | null {
  return q(container, '[data-testid="call-featured-stage-card"]')?.getAttribute('title') ?? null;
}

/** A secondary-strip tile addressed by its card title. */
function secondaryTile(container: Element, title: string): HTMLElement | null {
  return q(container, `[data-testid="call-secondary-stage-list"] [title="${title}"]`);
}

/** A tile anywhere on the stage: featured slot, secondary strip, or grid. */
function stageTile(container: Element, title: string): HTMLElement | null {
  return q(
    container,
    `[data-testid="call-featured-stage-card"][title="${title}"],` +
      ` [data-testid="call-secondary-stage-list"] [title="${title}"],` +
      ` [data-testid="call-grid-stage-list"] [title="${title}"]`
  );
}

function watchButtonIn(tile: Element): HTMLElement | null {
  return q(tile, '[data-testid="call-feed-watch-button"]');
}

function hasVideoIn(tile: Element): boolean {
  return q(tile, '[data-testid="call-tile-media-button"]') !== null;
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

describe('per-feed watching', () => {
  beforeEach(() => {
    userPreferences.callView = {
      grid: false,
      showOwnCamera: true,
      showNonVideoParticipants: true,
      showOwnScreenShare: true,
      collapsedStrip: false
    };
  });

  it('stops watching one camera without touching anyone else', async () => {
    const container = await renderStage();
    await expect.poll(() => secondaryTile(container, 'Bob')).not.toBeNull();
    expect(hasVideoIn(secondaryTile(container, 'Bob')!)).toBe(true);

    watchButtonIn(secondaryTile(container, 'Bob')!)!.click();

    // Bob's picture goes, but his card stays so he is still visibly in the call.
    await expect.poll(() => hasVideoIn(secondaryTile(container, 'Bob')!)).toBe(false);
    expect(secondaryTile(container, 'Bob')).not.toBeNull();
    // Alice is a separate feed and is unaffected.
    expect(hasVideoIn(secondaryTile(container, 'Alice')!)).toBe(true);
  });

  it('resumes a stopped feed from its own card', async () => {
    const container = await renderStage();
    await expect.poll(() => secondaryTile(container, 'Bob')).not.toBeNull();

    watchButtonIn(secondaryTile(container, 'Bob')!)!.click();
    await expect.poll(() => hasVideoIn(secondaryTile(container, 'Bob')!)).toBe(false);

    // The control survives on the collapsed card, so the feed can come back.
    const restore = watchButtonIn(secondaryTile(container, 'Bob')!);
    expect(restore).not.toBeNull();
    restore!.click();

    await expect.poll(() => hasVideoIn(secondaryTile(container, 'Bob')!)).toBe(true);
  });

  it('stops a stopped feed claiming the featured slot', async () => {
    const container = await renderStage();

    const featuredHide = q(
      container,
      '[data-testid="call-featured-stage-card"] [data-testid="call-feed-watch-button"]'
    );
    expect(featuredHide).not.toBeNull();
    featuredHide!.click();

    // Dana's screen was auto-featured; hiding it must hand the stage to another
    // feed rather than enlarging a blank card.
    await expect.poll(() => featuredTitle(container)).not.toBe("Dana's screen");
    expect(featuredTitle(container)).not.toBeNull();
  });

  it('keeps a resumed camera tile in place rather than rebuilding it', async () => {
    const container = await renderStage();
    await expect.poll(() => secondaryTile(container, 'Bob')).not.toBeNull();

    watchButtonIn(secondaryTile(container, 'Bob')!)!.click();
    await expect.poll(() => hasVideoIn(secondaryTile(container, 'Bob')!)).toBe(false);

    const before = secondaryTile(container, 'Bob')!;
    watchButtonIn(before)!.click();
    await expect.poll(() => hasVideoIn(secondaryTile(container, 'Bob')!)).toBe(true);

    // Same DOM node throughout. Tile identity follows whether the camera is on, not
    // whether its track has arrived, so the picture landing swaps the card's contents
    // instead of tearing the card down and building a new one — which is what made a
    // resumed feed visibly blink.
    expect(secondaryTile(container, 'Bob')).toBe(before);
  });

  it('holds a resumed screen share on the stage while its track is still arriving', async () => {
    const container = await renderStage();

    const featuredHide = q(
      container,
      '[data-testid="call-featured-stage-card"] [data-testid="call-feed-watch-button"]'
    );
    featuredHide!.click();
    await expect.poll(() => secondaryTile(container, "Dana's screen")).not.toBeNull();

    watchButtonIn(secondaryTile(container, "Dana's screen")!)!.click();
    await tick();

    // The track has not come back yet, and the card has to be on the stage regardless.
    // A screen share tile that tested for a track vanished in this gap and reappeared a
    // moment later, reflowing the stage under the viewer. Searched across the whole stage
    // because resuming also makes it eligible for the featured slot again.
    expect(stageTile(container, "Dana's screen")).not.toBeNull();

    await expect.poll(() => featuredTitle(container)).toBe("Dana's screen");
  });

  it('hides your own camera through the view option instead of unsubscribing', async () => {
    const container = await renderStage();
    await expect.poll(() => secondaryTile(container, 'Alice')).not.toBeNull();

    watchButtonIn(secondaryTile(container, 'Alice')!)!.click();

    // Your own feed is published, not subscribed, so there is nothing to stop receiving.
    // The control writes the persisted view option instead, and the tile leaves the stage
    // outright — the header menu is what brings it back.
    await expect.poll(() => secondaryTile(container, 'Alice')).toBeNull();
    expect(userPreferences.callView.showOwnCamera).toBe(false);
  });

  it('offers no watch control for a participant with no picture', async () => {
    const container = await renderStage();
    await expect.poll(() => secondaryTile(container, 'Chloe — poor connection')).not.toBeNull();

    // Chloe is voice-only, so there is nothing to hide.
    expect(watchButtonIn(secondaryTile(container, 'Chloe — poor connection')!)).toBeNull();
  });
});
