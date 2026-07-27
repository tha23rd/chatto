/**
 * The view options section of the in-call settings menu: it must render every
 * option as a checkbox reflecting the stored preference, and toggling one must
 * persist. The surrounding menu deliberately stays open, since these options
 * are usually adjusted together.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userPreferences } from '$lib/state/userPreferences.svelte';
import CallViewOptionsSection from './CallViewOptionsSection.svelte';

function renderSection() {
  return render(CallViewOptionsSection);
}

function items(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[role="menuitemcheckbox"]'));
}

describe('CallViewOptionsSection', () => {
  beforeEach(() => {
    userPreferences.callView = {
      grid: false,
      showOwnCamera: true,
      showNonVideoParticipants: true,
      showOwnScreenShare: true,
      collapsedStrip: false
    };
  });

  it('renders every option with its stored state', async () => {
    const { container } = renderSection();

    await expect.poll(() => items(container).length).toBe(4);
    expect(container.textContent).toContain('Grid view');
    expect(container.textContent).toContain('Show my own camera');
    expect(container.textContent).toContain('Show non-video participants');
    expect(container.textContent).toContain('Show my screen share');

    // Grid is off by default; the three visibility options are on.
    const checked = container.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"]');
    expect(checked).toHaveLength(3);
  });

  it('toggles a preference', async () => {
    const { container } = renderSection();
    await expect.poll(() => items(container).length).toBe(4);

    const grid = container.querySelector<HTMLButtonElement>(
      '[data-testid="call-view-option-grid"]'
    )!;
    expect(grid.getAttribute('aria-checked')).toBe('false');

    grid.click();

    await expect.poll(() => grid.getAttribute('aria-checked')).toBe('true');
    expect(userPreferences.callView.grid).toBe(true);
  });

  it('turns a visibility option off', async () => {
    const { container } = renderSection();
    await expect.poll(() => items(container).length).toBe(4);

    const ownCamera = container.querySelector<HTMLButtonElement>(
      '[data-testid="call-view-option-own-camera"]'
    )!;
    ownCamera.click();

    await expect.poll(() => ownCamera.getAttribute('aria-checked')).toBe('false');
    expect(userPreferences.callView.showOwnCamera).toBe(false);
  });
});
