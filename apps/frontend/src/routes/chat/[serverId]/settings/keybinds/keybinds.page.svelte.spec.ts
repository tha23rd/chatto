import { beforeEach, describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { DEFAULT_CALL_KEYBINDINGS } from '$lib/callKeybindings';
import { userPreferences } from '$lib/state/userPreferences.svelte';
import { q } from '$lib/test-utils';
import KeybindsPage from './+page.svelte';

function press(code: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code,
      ...init
    })
  );
  flushSync();
}

beforeEach(() => {
  localStorage.clear();
  userPreferences.resetCallKeybindings();
});

describe('Keybind settings page', () => {
  it('renders every call action and the compatibility push-to-talk default', async () => {
    const { container } = render(KeybindsPage);

    await expect.element(q(container, 'h1')).toHaveTextContent('Keybinds');
    expect(container.textContent).toContain('Push to talk');
    expect(container.textContent).toContain('Push to mute');
    expect(container.textContent).toContain('Start screen share');
    expect(container.textContent).toContain('Stop screen share');
    expect(container.textContent).toContain('Undeafen');
    expect(container.textContent).toContain('Ctrl + Shift + Space');
  });

  it('records, reassigns, clears, and resets keybindings immediately', () => {
    const { container } = render(KeybindsPage);
    const muteRecorder = q(
      container,
      '[data-testid="keybind-recorder-toggle-mute"]'
    )!;
    muteRecorder.click();
    flushSync();
    expect(muteRecorder.getAttribute('aria-pressed')).toBe('true');

    press('KeyM', { ctrlKey: true });
    expect(userPreferences.callKeybindings['toggle-mute']).toBe('Control+KeyM');
    expect(muteRecorder.textContent).toContain('Ctrl + M');

    q(
      container,
      '[data-testid="keybind-recorder-toggle-deafen"]'
    )!.click();
    press('KeyM', { ctrlKey: true });
    expect(userPreferences.callKeybindings['toggle-mute']).toBeUndefined();
    expect(userPreferences.callKeybindings['toggle-deafen']).toBe('Control+KeyM');

    q(
      container,
      '[data-testid="keybind-clear-toggle-deafen"]'
    )!.click();
    flushSync();
    expect(userPreferences.callKeybindings['toggle-deafen']).toBeUndefined();

    userPreferences.setCallKeybinding('leave-call', 'F12');
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Reset to defaults'))
      ?.click();
    flushSync();
    expect(userPreferences.callKeybindings).toEqual(DEFAULT_CALL_KEYBINDINGS);
  });

  it('cancels recording with Escape without changing the current binding', () => {
    const { container } = render(KeybindsPage);
    const recorder = q(
      container,
      '[data-testid="keybind-recorder-push-to-talk"]'
    )!;
    recorder.click();
    flushSync();

    press('Escape');

    expect(recorder.getAttribute('aria-pressed')).toBe('false');
    expect(userPreferences.callKeybindings).toEqual(DEFAULT_CALL_KEYBINDINGS);
  });
});
