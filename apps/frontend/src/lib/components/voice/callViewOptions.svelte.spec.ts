/**
 * Covers the viewer's call view options: grid vs featured layout, and the three
 * visibility toggles that drop the viewer's own camera, their own screen share,
 * or participants with no video.
 *
 * These are component tests because the filtering feeds the same `$derived`
 * chain that picks the featured tile, and e2e cannot join a real LiveKit call in
 * CI (see the header of e2e/voice-call.spec.ts).
 *
 * The harness's 'screen' scenario seeds Dana (screen share, auto-featured),
 * Alice (the local viewer, camera on), Bob (camera on), and Chloe (voice-only,
 * on a poor connection).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import { userPreferences } from '$lib/state/userPreferences.svelte';
import VoiceCallPanelStoryHarness from './VoiceCallPanelStoryHarness.svelte';

/** Every tile card, in either stage layout. Action buttons also carry titles. */
const TILE_CARD_SELECTOR = [
  '[data-testid="call-featured-stage-card"]',
  '[data-testid="call-screen-share-card"]',
  '[data-testid="call-participant-card"]'
].join(',');

function featuredTitle(container: Element): string | null {
  return q(container, '[data-testid="call-featured-stage-card"]')?.getAttribute('title') ?? null;
}

function tileTitles(container: Element): string[] {
  return [...container.querySelectorAll(TILE_CARD_SELECTOR)]
    .map((node) => node.getAttribute('title') ?? '')
    .filter(Boolean);
}

/**
 * Whether a participant has a tile on the stage. A tile title is the display
 * name, with a " — poor connection" suffix when their link is struggling.
 */
function hasTileFor(container: Element, name: string): boolean {
  return tileTitles(container).some((title) => title === name || title.startsWith(`${name} —`));
}

async function renderStage(scenario: 'screen' | 'screen-single-secondary' | 'voice' = 'screen') {
  const { container } = render(VoiceCallPanelStoryHarness, {
    props: { layout: 'stage' as const, scenario }
  });

  // Generous timeout: the harness imports the panel lazily, so a cold Vite transform
  // can push the first mount past the 1s default while the module is still compiling.
  await expect
    .poll(() => q(container, '[data-testid="call-participant-panel"]'), { timeout: 15000 })
    .not.toBeNull();
  return container;
}

describe('call view options', () => {
  beforeEach(() => {
    // Preferences are a persisted singleton, so each test starts from defaults.
    userPreferences.callView = {
      grid: false,
      showOwnCamera: true,
      showNonVideoParticipants: true,
      showOwnScreenShare: true,
      collapsedStrip: false
    };
  });

  it('features the screen share and lists everyone else by default', async () => {
    const container = await renderStage();

    await expect.poll(() => featuredTitle(container)).toBe("Dana's screen");
    expect(hasTileFor(container, 'Alice')).toBe(true);
    expect(hasTileFor(container, 'Bob')).toBe(true);
    expect(hasTileFor(container, 'Chloe')).toBe(true);
  });

  it('drops the featured card for an equal grid in grid view', async () => {
    const container = await renderStage();
    await expect.poll(() => featuredTitle(container)).toBe("Dana's screen");

    userPreferences.setCallViewPreference('grid', true);

    await expect.poll(() => q(container, '[data-testid="call-grid-stage-list"]')).not.toBeNull();
    expect(featuredTitle(container)).toBeNull();
    // Every feed is still present, just at equal size.
    expect(tileTitles(container)).toContain("Dana's screen");
    expect(hasTileFor(container, 'Alice')).toBe(true);
    expect(hasTileFor(container, 'Chloe')).toBe(true);
  });

  it('hides the viewer’s own camera without touching other participants', async () => {
    const container = await renderStage();
    await expect.poll(() => hasTileFor(container, 'Alice')).toBe(true);

    userPreferences.setCallViewPreference('showOwnCamera', false);

    await expect.poll(() => hasTileFor(container, 'Alice')).toBe(false);
    // Bob's camera belongs to someone else, so it stays.
    expect(hasTileFor(container, 'Bob')).toBe(true);
  });

  it('hides participants with no video', async () => {
    const container = await renderStage();
    await expect.poll(() => hasTileFor(container, 'Chloe')).toBe(true);

    userPreferences.setCallViewPreference('showNonVideoParticipants', false);

    await expect.poll(() => hasTileFor(container, 'Chloe')).toBe(false);
    expect(hasTileFor(container, 'Bob')).toBe(true);
  });

  it('hides the viewer’s own screen share and re-features what is left', async () => {
    // Here the local viewer is the one sharing, with their camera also on.
    const container = await renderStage('screen-single-secondary');
    await expect.poll(() => featuredTitle(container)).toBe("Alice's screen");

    userPreferences.setCallViewPreference('showOwnScreenShare', false);

    // The stage falls through to the next-best feed rather than going blank.
    await expect.poll(() => featuredTitle(container)).toBe('Alice');
  });

  it('explains the empty stage when the filters hide every feed', async () => {
    // Everyone is voice-only here, so hiding non-video participants leaves
    // nothing at all to render.
    const container = await renderStage('voice');
    await expect.poll(() => featuredTitle(container)).not.toBeNull();

    userPreferences.setCallViewPreference('showNonVideoParticipants', false);

    // The filter is honoured rather than quietly ignored, and the stage says why
    // it is empty instead of just going blank.
    await expect.poll(() => q(container, '[data-testid="call-stage-empty"]')).not.toBeNull();
    expect(tileTitles(container)).toHaveLength(0);
    expect(featuredTitle(container)).toBeNull();
  });
});
