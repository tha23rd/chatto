import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import EmojiPicker from './EmojiPicker.svelte';
import { EMOJI_BY_CATEGORY } from '$lib/emoji';
import { __resetRecentEmojisForTests } from '$lib/state/recentEmojis.svelte';
import {
  getCustomEmojis,
  __resetCustomEmojisForTests
} from '$lib/state/customEmojis.svelte';

const TEST_SERVER_ID = 'test-server';
const CUSTOM_EMOJI_URL = 'https://example.test/emoji/partyparrot.png';

/** Register a custom emoji so the picker's Custom category and recents resolve it. */
function addCustomEmoji(name: string, serverId = TEST_SERVER_ID) {
  getCustomEmojis(serverId).upsert({
    id: `id-${name}`,
    name,
    url: `https://example.test/emoji/${name}.png`
  });
}

function renderPicker(
  props: { onSelect?: (e: string) => void; onClose?: () => void; serverId?: string } = {}
) {
  return render(EmojiPicker, {
    props: {
      serverId: props.serverId ?? TEST_SERVER_ID,
      onSelect: props.onSelect ?? (() => {}),
      onClose: props.onClose ?? (() => {})
    }
  });
}

beforeEach(() => {
  localStorage.clear();
  __resetRecentEmojisForTests();
  __resetCustomEmojisForTests();
});

function searchInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="text"]');
  if (!input) throw new Error('search input not found');
  return input as HTMLInputElement;
}

async function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  // searchResults is a $derived, so values propagate within this microtask
  await tick();
}

describe('EmojiPicker', () => {
  describe('default state (no search)', () => {
    it('renders the search input', () => {
      const { container } = renderPicker();
      expect(searchInput(container)).toBeTruthy();
    });

    it('renders all category sections', () => {
      const { container } = renderPicker();
      const headings = Array.from(container.querySelectorAll('div'))
        .map((d) => d.textContent?.trim())
        .filter(Boolean);
      for (const cat of EMOJI_BY_CATEGORY) {
        expect(headings).toContain(cat.name);
      }
    });

    it('does not show "No emojis found" when not searching', () => {
      const { container } = renderPicker();
      expect(container.textContent).not.toContain('No emojis found');
    });
  });

  describe('search', () => {
    it('shows search results matching the query', async () => {
      const { container } = renderPicker();
      await type(searchInput(container), 'smile');

      // Hides categories while searching
      const headings = Array.from(container.querySelectorAll('div'))
        .map((d) => d.textContent?.trim())
        .filter(Boolean);
      for (const cat of EMOJI_BY_CATEGORY) {
        expect(headings).not.toContain(cat.name);
      }
      // Shows at least one emoji button (the result grid)
      const resultButtons = container.querySelectorAll('button');
      expect(resultButtons.length).toBeGreaterThan(0);
    });

    it('shows "No emojis found" for queries with no matches', async () => {
      const { container } = renderPicker();
      await type(searchInput(container), 'zzzzzznotanemoji');
      expect(container.textContent).toContain('No emojis found');
    });

    it('treats whitespace-only queries as empty', async () => {
      const { container } = renderPicker();
      await type(searchInput(container), '   ');
      expect(container.textContent).not.toContain('No emojis found');
      // Categories should still be visible
      const headings = Array.from(container.querySelectorAll('div'))
        .map((d) => d.textContent?.trim())
        .filter(Boolean);
      expect(headings).toContain(EMOJI_BY_CATEGORY[0].name);
    });
  });

  describe('selection', () => {
    it('clicking a category emoji calls onSelect with that emoji', () => {
      const onSelect = vi.fn();
      const { container } = renderPicker({ onSelect });
      const firstButton = container.querySelector('button') as HTMLButtonElement;
      const emojiText = firstButton.textContent?.trim() ?? '';
      firstButton.click();
      expect(onSelect).toHaveBeenCalledWith(emojiText);
    });

    it('clicking a search result calls onSelect with that emoji', async () => {
      const onSelect = vi.fn();
      const { container } = renderPicker({ onSelect });
      await type(searchInput(container), 'smile');
      const firstResult = container.querySelector('.grid button') as HTMLButtonElement;
      const emojiText = firstResult.textContent?.trim() ?? '';
      firstResult.click();
      expect(onSelect).toHaveBeenCalledWith(emojiText);
    });
  });

  describe('Recently Used section', () => {
    it('is not rendered when there are no recents', () => {
      const { container } = renderPicker();
      expect(container.textContent).not.toContain('Recently Used');
    });

    it('appears after selecting an emoji and shows the selection first', async () => {
      const { container } = renderPicker();
      const firstButton = container.querySelector('button') as HTMLButtonElement;
      const emojiText = firstButton.textContent?.trim() ?? '';
      firstButton.click();
      flushSync();
      await tick();
      expect(container.textContent).toContain('Recently Used');
      // The first button in the recent grid should be the just-selected emoji
      const recentGrid = container.querySelector('.grid') as HTMLElement;
      expect(recentGrid.querySelector('button')?.textContent?.trim()).toBe(emojiText);
    });

    it('hydrates from localStorage on mount', () => {
      localStorage.setItem(
        `chatto:i:${TEST_SERVER_ID}:recentEmojis`,
        JSON.stringify(['🚀', '🔥'])
      );
      const { container } = renderPicker();
      expect(container.textContent).toContain('Recently Used');
      const firstGrid = container.querySelector('.grid') as HTMLElement;
      const recentButtons = Array.from(firstGrid.querySelectorAll('button'));
      expect(recentButtons[0]?.textContent?.trim()).toBe('🚀');
      expect(recentButtons[1]?.textContent?.trim()).toBe('🔥');
    });

    it('is scoped per server', () => {
      localStorage.setItem(`chatto:i:server-a:recentEmojis`, JSON.stringify(['🚀']));
      const { container } = renderPicker({ serverId: 'server-b' });
      expect(container.textContent).not.toContain('Recently Used');
    });
  });

  describe('custom emojis in Recently Used', () => {
    /** The "Recently Used" grid is the first grid when recents are present. */
    function recentGrid(container: HTMLElement): HTMLElement {
      return container.querySelector('.grid') as HTMLElement;
    }

    it('records a picked custom emoji into recents as its shortcode', () => {
      addCustomEmoji('partyparrot');
      const onSelect = vi.fn();
      const { container } = renderPicker({ onSelect });

      // The Custom category is prepended, so its emoji is the first button.
      const customButton = container.querySelector('button[title="partyparrot"]');
      (customButton as HTMLButtonElement).click();
      flushSync();

      expect(onSelect).toHaveBeenCalledWith('partyparrot');
      expect(JSON.parse(localStorage.getItem(`chatto:i:${TEST_SERVER_ID}:recentEmojis`) ?? '[]'))
        .toEqual(['partyparrot']);
    });

    it('renders a recent custom emoji as its image, not the raw shortcode', async () => {
      addCustomEmoji('partyparrot');
      localStorage.setItem(
        `chatto:i:${TEST_SERVER_ID}:recentEmojis`,
        JSON.stringify(['partyparrot'])
      );
      const { container } = renderPicker();
      await tick();

      const img = recentGrid(container).querySelector('img');
      expect(img?.getAttribute('src')).toBe(CUSTOM_EMOJI_URL);
      expect(recentGrid(container).textContent).not.toContain('partyparrot');
    });

    it('clicking a recent custom emoji re-selects it by shortcode', async () => {
      addCustomEmoji('partyparrot');
      localStorage.setItem(
        `chatto:i:${TEST_SERVER_ID}:recentEmojis`,
        JSON.stringify(['partyparrot'])
      );
      const onSelect = vi.fn();
      const { container } = renderPicker({ onSelect });
      await tick();

      (recentGrid(container).querySelector('button') as HTMLButtonElement).click();
      expect(onSelect).toHaveBeenCalledWith('partyparrot');
    });

    it('omits a recent whose custom emoji no longer exists', () => {
      localStorage.setItem(
        `chatto:i:${TEST_SERVER_ID}:recentEmojis`,
        JSON.stringify(['deleted_emoji'])
      );
      const { container } = renderPicker();
      // Nothing renderable is left, so the section is hidden entirely rather
      // than showing a bare `deleted_emoji`.
      expect(container.textContent).not.toContain('Recently Used');
      expect(container.textContent).not.toContain('deleted_emoji');
    });
  });

  describe('Escape semantics', () => {
    it('Escape with a non-empty query clears the query (does not close)', async () => {
      const onClose = vi.fn();
      const { container } = renderPicker({ onClose });
      const input = searchInput(container);
      await type(input, 'smile');
      expect(input.value).toBe('smile');

      const wrapper = input.closest('div[onkeydown], .flex') as HTMLElement;
      // The handler is on the outer flex container; bubble from the input.
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      flushSync();
      await tick();

      expect(onClose).not.toHaveBeenCalled();
      expect(input.value).toBe('');
      void wrapper; // silence unused
    });

    it('Escape with empty query calls onClose', async () => {
      const onClose = vi.fn();
      const { container } = renderPicker({ onClose });
      const input = searchInput(container);
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  // The per-server recents store is a module singleton that outlives the picker
  // which happened to create it. While its recents view was a $derived class
  // field, that field belonged to the first picker's reaction and went inert on
  // unmount, so every later picker rendered an empty "Recently Used" no matter
  // what the user picked.
  describe('recents across picker lifetimes', () => {
    it('still updates in a picker mounted after an earlier one unmounted', async () => {
      const first = renderPicker();
      first.unmount();
      flushSync();

      const { container } = renderPicker();
      const firstButton = container.querySelector('button') as HTMLButtonElement;
      const emojiText = firstButton.textContent?.trim() ?? '';
      firstButton.click();
      flushSync();
      await tick();

      expect(container.textContent).toContain('Recently Used');
      const recentGrid = container.querySelector('.grid') as HTMLElement;
      expect(recentGrid.querySelector('button')?.textContent?.trim()).toBe(emojiText);
    });
  });
});
