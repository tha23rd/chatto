import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { __resetCustomEmojisForTests, getCustomEmojis } from '$lib/state/customEmojis.svelte';
import UserCustomStatusBadge from './UserCustomStatusBadge.svelte';

const customStatus = {
  emoji: 'partyparrot',
  text: 'Working',
  expiresAt: null
};

beforeEach(() => {
  __resetCustomEmojisForTests();
});

describe('UserCustomStatusBadge', () => {
  it('renders a known custom status emoji as an image', () => {
    getCustomEmojis('origin').upsert({
      id: 'emoji-partyparrot',
      name: 'partyparrot',
      url: 'https://example.test/assets/emoji/partyparrot'
    });

    const { container } = render(UserCustomStatusBadge, {
      props: {
        serverId: 'origin',
        status: customStatus,
        showText: true
      }
    });

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.test/assets/emoji/partyparrot');
    expect(image?.getAttribute('alt')).toBe(':partyparrot:');
    expect(container.textContent).toContain('Working');
    expect(container.textContent).not.toContain('partyparrot');
  });

  it('preserves status text without exposing an unresolved custom marker', () => {
    const { container } = render(UserCustomStatusBadge, {
      props: {
        serverId: 'origin',
        status: customStatus,
        showText: true
      }
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Working');
    expect(container.textContent).not.toContain('partyparrot');
    expect(container.querySelector('[aria-label="Working"]')).not.toBeNull();
  });

  it('preserves status text when a rendered custom emoji is deleted', async () => {
    const store = getCustomEmojis('origin');
    store.upsert({
      id: 'emoji-partyparrot',
      name: 'partyparrot',
      url: 'https://example.test/assets/emoji/partyparrot'
    });
    const { container } = render(UserCustomStatusBadge, {
      props: {
        serverId: 'origin',
        status: customStatus,
        showText: true
      }
    });

    expect(container.querySelector('img[alt=":partyparrot:"]')).not.toBeNull();

    store.remove('emoji-partyparrot');

    await vi.waitFor(() => {
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('Working');
      expect(container.textContent).not.toContain('partyparrot');
    });
  });

  it('renders no empty badge for an unresolved marker-only status', () => {
    const { container } = render(UserCustomStatusBadge, {
      props: {
        serverId: 'origin',
        status: customStatus
      }
    });

    expect(container.querySelector('span')).toBeNull();
    expect(container.textContent).not.toContain('partyparrot');
  });
});
