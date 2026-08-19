import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import { __resetRecentEmojisForTests } from '$lib/state/recentEmojis.svelte';
import UserCustomStatusEditor from './UserCustomStatusEditor.svelte';

const { updateCustomStatusMock, deleteCustomStatusMock } = vi.hoisted(() => ({
  updateCustomStatusMock: vi.fn(),
  deleteCustomStatusMock: vi.fn()
}));

vi.mock('$lib/api-client/userStatus', () => ({
  updateCustomStatus: updateCustomStatusMock,
  deleteCustomStatus: deleteCustomStatusMock
}));

const config = {
  serverId: 'test-server',
  baseUrl: 'https://chat.example.test',
  bearerToken: 'test-token'
};

beforeEach(() => {
  localStorage.clear();
  __resetRecentEmojisForTests();
  updateCustomStatusMock.mockReset();
  updateCustomStatusMock.mockImplementation(async (_config, input) => ({
    ...input,
    expiresAt: input.expiresAt ?? null
  }));
  deleteCustomStatusMock.mockReset();
  deleteCustomStatusMock.mockResolvedValue(null);
});

describe('UserCustomStatusEditor', () => {
  it('saves an expiry-only edit to an emoji-only status', async () => {
    const { container } = render(UserCustomStatusEditor, {
      props: {
        config,
        status: { emoji: '🌿', text: '', expiresAt: null }
      }
    });

    const expiryPreset = container.querySelector<HTMLSelectElement>(
      '[data-testid="settings-custom-status-expiry-preset"]'
    )!;
    expiryPreset.value = 'one_hour';
    expiryPreset.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    container.querySelector<HTMLFormElement>('form')!.requestSubmit();

    await vi.waitFor(() => {
      expect(updateCustomStatusMock).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          emoji: '🌿',
          text: '',
          expiresAt: expect.any(String)
        })
      );
    });
  });

  it('saves a default emoji-only status after explicitly selecting its emoji', async () => {
    const { container } = render(UserCustomStatusEditor, { props: { config } });
    const form = container.querySelector<HTMLFormElement>('form')!;
    const saveButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(saveButton.disabled).toBe(true);

    container
      .querySelector<HTMLButtonElement>('[data-testid="settings-custom-status-emoji-picker"]')!
      .click();
    flushSync();

    let searchInput: HTMLInputElement | null = null;
    await vi.waitFor(() => {
      searchInput = document.querySelector<HTMLInputElement>('input[type="text"]');
      expect(searchInput).not.toBeNull();
    });
    searchInput!.value = 'herb';
    searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    await tick();

    const herb = document.querySelector<HTMLButtonElement>('button[title="herb"]');
    expect(herb).not.toBeNull();
    herb!.click();
    flushSync();

    expect(saveButton.disabled).toBe(false);
    form.requestSubmit();

    await vi.waitFor(() => {
      expect(updateCustomStatusMock).toHaveBeenCalledWith(config, {
        emoji: '🌿',
        text: '',
        expiresAt: expect.any(String)
      });
    });
  });
});
