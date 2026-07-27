/**
 * Covers the viewer-local stage pin: in the maximized stage layout any tile can
 * be pinned as the featured one, overriding the automatic screen-share-first
 * order. This needs a component test because the pin lives in `VoiceCallPanel`
 * component state and reacts to live participant changes, and e2e cannot join a
 * real LiveKit call in CI (see the header of e2e/voice-call.spec.ts).
 *
 * The harness's 'screen' scenario seeds Dana (screen share, auto-featured),
 * Alice (local viewer, camera), Bob (camera), and Chloe (voice-only).
 */

import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import { serverRegistry } from '$lib/state/server/registry.svelte';
import VoiceCallPanelStoryHarness from './VoiceCallPanelStoryHarness.svelte';

function featuredTitle(container: Element): string | null {
  return (
    q(container, '[data-testid="call-featured-stage-card"]')?.getAttribute('title') ?? null
  );
}

function secondaryPinButton(container: Element, title: string): HTMLElement | null {
  return q(
    container,
    `[data-testid="call-secondary-stage-list"] [title="${title}"] [data-testid="call-feed-pin-button"]`
  );
}

async function renderStage() {
  const { container } = render(VoiceCallPanelStoryHarness, {
    props: { layout: 'stage' as const, scenario: 'screen' as const }
  });

  // The harness imports the panel lazily; the automatic pick features Dana's
  // screen share once it is mounted.
  await expect.poll(() => featuredTitle(container)).toBe("Dana's screen");
  return container;
}

describe('stage featured-tile pin', () => {
  it('pins a secondary tile as the featured one and unpins back to automatic', async () => {
    const container = await renderStage();

    secondaryPinButton(container, 'Bob')!.click();
    await expect.poll(() => featuredTitle(container)).toBe('Bob');

    // The featured card's toolbar now offers the unpin control.
    const unpin = q(
      container,
      '[data-testid="call-featured-stage-card"] [data-testid="call-feed-pin-button"]'
    );
    expect(unpin?.getAttribute('aria-label')).not.toBeNull();
    unpin!.click();
    await expect.poll(() => featuredTitle(container)).toBe("Dana's screen");
  });

  it('falls back to the automatic pick while the pinned feed is gone and re-applies on return', async () => {
    const container = await renderStage();

    secondaryPinButton(container, 'Bob')!.click();
    await expect.poll(() => featuredTitle(container)).toBe('Bob');

    const store = serverRegistry.getStore(serverRegistry.originServer!.id);
    const withBob = store.voiceCall.participants;
    store.voiceCall.participants = withBob.filter((p) => p.identity !== 'bob');
    await expect.poll(() => featuredTitle(container)).toBe("Dana's screen");

    // Bob rejoins: the still-held pin selects his tile again.
    store.voiceCall.participants = withBob;
    await expect.poll(() => featuredTitle(container)).toBe('Bob');
  });

  it('features a secondary media tile when its media area is clicked', async () => {
    const container = await renderStage();

    q(
      container,
      '[data-testid="call-secondary-stage-list"] [title="Bob"] [data-testid="call-tile-media-button"]'
    )!.click();

    await expect.poll(() => featuredTitle(container)).toBe('Bob');
  });

  it('hides and restores the secondary strip from the featured tile toolbar', async () => {
    const container = await renderStage();

    const strip = () => q(container, '[data-testid="call-secondary-stage-list"]');
    const toggle = () =>
      q(
        container,
        '[data-testid="call-featured-stage-card"] [data-testid="call-stage-strip-toggle"]'
      );

    await expect.poll(toggle).not.toBeNull();
    toggle()!.click();
    await expect.poll(strip).toBeNull();

    // The toggle stays on the featured tile so the strip can be brought back.
    toggle()!.click();
    await expect.poll(strip).not.toBeNull();
  });

  it('unpins with Escape', async () => {
    const container = await renderStage();

    secondaryPinButton(container, 'Bob')!.click();
    await expect.poll(() => featuredTitle(container)).toBe('Bob');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect.poll(() => featuredTitle(container)).toBe("Dana's screen");
  });

  it('restores the hidden strip with Escape before unpinning', async () => {
    const container = await renderStage();
    const strip = () => q(container, '[data-testid="call-secondary-stage-list"]');

    secondaryPinButton(container, 'Bob')!.click();
    await expect.poll(() => featuredTitle(container)).toBe('Bob');
    q(
      container,
      '[data-testid="call-featured-stage-card"] [data-testid="call-stage-strip-toggle"]'
    )!.click();
    await expect.poll(strip).toBeNull();

    // First Escape brings the strip back and leaves the pin alone.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect.poll(strip).not.toBeNull();
    expect(featuredTitle(container)).toBe('Bob');

    // Second Escape releases the pin.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect.poll(() => featuredTitle(container)).toBe("Dana's screen");
  });

  it('offers no pin control in the sidebar layout', async () => {
    const { container } = render(VoiceCallPanelStoryHarness, {
      props: { layout: 'sidebar' as const, scenario: 'screen' as const }
    });

    await expect
      .poll(() => q(container, '[data-testid="call-participant-panel"]'))
      .not.toBeNull();
    expect(q(container, '[data-testid="call-feed-pin-button"]')).toBeNull();
  });
});
