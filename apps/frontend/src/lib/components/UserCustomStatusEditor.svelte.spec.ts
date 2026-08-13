import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { __resetCustomEmojisForTests, getCustomEmojis } from '$lib/state/customEmojis.svelte';
import UserCustomStatusEditor from './UserCustomStatusEditor.svelte';

const userStatusAPI = vi.hoisted(() => ({
  updateCustomStatus: vi.fn(),
  deleteCustomStatus: vi.fn()
}));

vi.mock('$lib/api-client/userStatus', () => ({
  updateCustomStatus: userStatusAPI.updateCustomStatus,
  deleteCustomStatus: userStatusAPI.deleteCustomStatus
}));

const config = {
  serverId: 'origin',
  baseUrl: 'https://chat.example.test',
  bearerToken: 'token'
};
const unresolvedStatus = {
  emoji: 'partyparrot',
  text: 'Working',
  expiresAt: null
};

beforeEach(() => {
  __resetCustomEmojisForTests();
  userStatusAPI.updateCustomStatus.mockReset();
  userStatusAPI.updateCustomStatus.mockResolvedValue({
    emoji: '🙂',
    text: 'Updated',
    expiresAt: null
  });
  userStatusAPI.deleteCustomStatus.mockReset();
  userStatusAPI.deleteCustomStatus.mockResolvedValue(null);
});

describe('UserCustomStatusEditor', () => {
  it('keeps known custom and Unicode status markers visible', () => {
    getCustomEmojis('origin').upsert({
      id: 'emoji-partyparrot',
      name: 'partyparrot',
      url: 'https://example.test/assets/emoji/partyparrot'
    });
    const knownCustom = render(UserCustomStatusEditor, {
      props: {
        status: unresolvedStatus,
        config,
        compact: true
      }
    });
    const customRow = Array.from(
      knownCustom.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((button) => button.textContent?.includes('Working'));

    expect(customRow?.querySelector('img[alt=":partyparrot:"]')).not.toBeNull();
    customRow?.click();
    flushSync();
    expect(
      knownCustom.container.querySelector(
        '[data-testid="settings-custom-status-emoji-picker"] img[alt=":partyparrot:"]'
      )
    ).not.toBeNull();
    knownCustom.unmount();

    const unicode = render(UserCustomStatusEditor, {
      props: {
        status: { ...unresolvedStatus, emoji: '🍜' },
        config
      }
    });
    expect(
      unicode.container.querySelector('[data-testid="settings-custom-status-emoji-picker"]')
        ?.textContent
    ).toContain('🍜');
  });

  it('uses neutral fallbacks for an unresolved marker in the compact editor', () => {
    const { container } = render(UserCustomStatusEditor, {
      props: {
        status: unresolvedStatus,
        config,
        compact: true
      }
    });
    const customRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((button) => button.textContent?.includes('Working'));

    expect(customRow?.querySelector('.iconify')).not.toBeNull();
    expect(customRow?.textContent).not.toContain('partyparrot');

    customRow?.click();
    flushSync();

    const picker = container.querySelector('[data-testid="settings-custom-status-emoji-picker"]');
    expect(picker?.textContent).toContain('🙂');
    expect(picker?.textContent).not.toContain('partyparrot');
    expect(picker?.querySelector('img')).toBeNull();
  });

  it('uses a neutral fallback for an unresolved marker in the full editor', () => {
    const { container } = render(UserCustomStatusEditor, {
      props: {
        status: unresolvedStatus,
        config
      }
    });
    const picker = container.querySelector('[data-testid="settings-custom-status-emoji-picker"]');

    expect(picker?.textContent).toContain('🙂');
    expect(picker?.textContent).not.toContain('partyparrot');
    expect(picker?.querySelector('img')).toBeNull();
  });

  it('submits the visible fallback when editing a status with an unresolved marker', async () => {
    const { container } = render(UserCustomStatusEditor, {
      props: {
        status: unresolvedStatus,
        config
      }
    });
    const textInput = container.querySelector(
      '[data-testid="settings-custom-status-text"]'
    ) as HTMLInputElement;
    textInput.value = 'Updated';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(userStatusAPI.updateCustomStatus).toHaveBeenCalledWith(config, {
        emoji: '🙂',
        text: 'Updated',
        expiresAt: null
      });
    });
    expect(JSON.stringify(userStatusAPI.updateCustomStatus.mock.calls)).not.toContain(
      'partyparrot'
    );
  });

  it('switches a preset draft to custom when a custom emoji is selected', async () => {
    getCustomEmojis('origin').upsert({
      id: 'emoji-partyparrot',
      name: 'partyparrot',
      url: 'https://example.test/assets/emoji/partyparrot'
    });
    const { container } = render(UserCustomStatusEditor, {
      props: {
        status: {
          emoji: '🌴',
          text: 'chatto:status:vacation',
          expiresAt: null
        },
        config
      }
    });

    const pickerButton = container.querySelector(
      '[data-testid="settings-custom-status-emoji-picker"]'
    ) as HTMLButtonElement;
    pickerButton.click();
    flushSync();

    const customEmojiButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('button[title="partyparrot"]');
      expect(button).not.toBeNull();
      return button!;
    });
    customEmojiButton.click();
    flushSync();

    expect(pickerButton.querySelector('img[alt=":partyparrot:"]')).not.toBeNull();

    (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(userStatusAPI.updateCustomStatus).toHaveBeenCalledWith(config, {
        emoji: 'partyparrot',
        text: 'Holiday',
        expiresAt: null
      });
    });
  });
});
