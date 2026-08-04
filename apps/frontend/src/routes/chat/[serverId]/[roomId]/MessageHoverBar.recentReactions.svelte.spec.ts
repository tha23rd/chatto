import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import EmojiPicker from '$lib/components/EmojiPicker.svelte';
import { PINNED_REACTIONS } from '$lib/emoji';
import { __resetRecentEmojisForTests, getRecentEmojis } from '$lib/state/recentEmojis.svelte';
import {
  getCustomEmojis,
  __resetCustomEmojisForTests
} from '$lib/state/customEmojis.svelte';
import { serverStorageKey } from '$lib/storage/serverStorage';
import MessageHoverBar from './MessageHoverBar.svelte';
import { buildMessageActionModel } from './messageActionModel';

const SERVER_ID = 'recent-reactions-server';

const mocks = vi.hoisted(() => ({
  actions: {
    toggleReaction: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    startEdit: vi.fn(),
    openDeleteConfirmation: vi.fn(),
    copyMessageText: vi.fn(),
    copyMessageLink: vi.fn()
  }
}));

// The bar's custom-emoji load is a no-op here; these tests seed custom
// emojis directly on the store, so nothing needs fetching.
vi.mock('$lib/hooks', () => ({
  useEnsureCustomEmojis: () => {}
}));

function renderBar() {
  const action = buildMessageActionModel({
    actions: mocks.actions,
    params: {
      serverId: SERVER_ID,
      roomId: 'room-1',
      messageEventId: 'message-event-1',
      eventId: 'event-1',
      messageBody: 'Hello'
    },
    reactions: [],
    canReact: true,
    canEdit: false,
    canDelete: false,
    replyInRoomLabel: 'Reply',
    replyThreadLabel: 'Reply in thread'
  });

  return render(MessageHoverBar, {
    props: { action }
  });
}

function quickReactionLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label^="React with "]'))
    .map((button) => button.getAttribute('aria-label')?.replace('React with ', '') ?? '')
    .filter(Boolean);
}

function searchInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="Search emojis..."]');
  if (!input) throw new Error('emoji search input not found');
  return input;
}

async function searchEmoji(container: HTMLElement, query: string) {
  const input = searchInput(container);
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  await tick();
}

beforeEach(() => {
  localStorage.clear();
  __resetRecentEmojisForTests();
  __resetCustomEmojisForTests();
  vi.clearAllMocks();
});

/** Register a custom emoji so recents on this server can resolve its shortcode. */
function addCustomEmoji(name: string) {
  getCustomEmojis(SERVER_ID).upsert({
    id: `id-${name}`,
    name,
    url: `https://example.test/emoji/${name}.png`
  });
}

describe('MessageHoverBar recent reactions integration', () => {
  it('uses a checkmark emoji selected in the picker as the first non-pinned quick reaction', async () => {
    const bar = renderBar();
    expect(quickReactionLabels(bar.container)).toEqual(['👍', '👋', '🤣', '🙏', '❤️', '😂']);

    const picker = render(EmojiPicker, {
      props: {
        serverId: SERVER_ID,
        onSelect: vi.fn(),
        onClose: vi.fn()
      }
    });
    await searchEmoji(picker.container, 'check');
    (
      picker.container.querySelector('button[title="white_check_mark"]') as HTMLButtonElement
    ).click();
    flushSync();
    await tick();

    const reactions = quickReactionLabels(bar.container);
    expect(reactions.slice(0, PINNED_REACTIONS.length)).toEqual([...PINNED_REACTIONS]);
    expect(reactions[PINNED_REACTIONS.length]).toBe('✅');
    expect(reactions).toHaveLength(6);
    expect(reactions).not.toContain('😂');
  });

  it('hydrates recent quick reactions from server-scoped localStorage', () => {
    localStorage.setItem(serverStorageKey(SERVER_ID, 'recentEmojis'), JSON.stringify(['🔥']));

    const { container } = renderBar();
    const reactions = quickReactionLabels(container);

    expect(reactions.slice(0, PINNED_REACTIONS.length)).toEqual([...PINNED_REACTIONS]);
    expect(reactions[PINNED_REACTIONS.length]).toBe('🔥');
  });

  it('shows a recent custom emoji as an image in a quick-reaction slot', async () => {
    addCustomEmoji('partyparrot');
    localStorage.setItem(serverStorageKey(SERVER_ID, 'recentEmojis'), JSON.stringify(['partyparrot']));

    const { container } = renderBar();
    await tick();

    const slot = container.querySelector<HTMLButtonElement>(
      '[aria-label="React with partyparrot"]'
    );
    expect(slot?.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/emoji/partyparrot.png'
    );
    // The bare shortcode must never leak into the toolbar as text.
    expect(slot?.textContent?.trim()).toBe('');
  });

  it('reacts with the shortcode when a custom quick reaction is clicked', async () => {
    addCustomEmoji('partyparrot');
    localStorage.setItem(serverStorageKey(SERVER_ID, 'recentEmojis'), JSON.stringify(['partyparrot']));

    const { container } = renderBar();
    await tick();

    (
      container.querySelector('[aria-label="React with partyparrot"]') as HTMLButtonElement
    ).click();

    await vi.waitFor(() => expect(mocks.actions.toggleReaction).toHaveBeenCalledOnce());
    expect(mocks.actions.toggleReaction).toHaveBeenCalledWith(
      expect.anything(),
      'partyparrot',
      false
    );
  });

  it('falls back rather than leaving a slot empty for a deleted custom emoji', () => {
    localStorage.setItem(
      serverStorageKey(SERVER_ID, 'recentEmojis'),
      JSON.stringify(['deleted_emoji'])
    );

    const { container } = renderBar();
    const reactions = quickReactionLabels(container);

    expect(reactions).toHaveLength(6);
    expect(reactions).not.toContain('deleted_emoji');
    expect(reactions[PINNED_REACTIONS.length]).toBe('❤️');
  });

  it('does not reorder recent reactions when a toolbar quick reaction is clicked', async () => {
    const { container } = renderBar();
    const before = [...getRecentEmojis(SERVER_ID).quickReactions];

    (container.querySelector('[aria-label="React with ❤️"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.actions.toggleReaction).toHaveBeenCalledOnce());

    expect([...getRecentEmojis(SERVER_ID).quickReactions]).toEqual(before);
  });

  // The per-server store is a lazily created module singleton, so it outlives
  // the bar that happened to construct it. While its views were $derived class
  // fields they belonged to that bar's reaction and went inert (Svelte's
  // `derived_inert`) on unmount, so every later bar rendered the list captured
  // at construction — on a fresh profile, pinned plus fallbacks forever.
  it('shows an emoji recorded after the bar that created the store unmounted', () => {
    const first = renderBar();
    flushSync();
    first.unmount();
    flushSync();

    getRecentEmojis(SERVER_ID).record('🚀');
    flushSync();

    const { container } = renderBar();
    expect(quickReactionLabels(container)).toContain('🚀');
  });

  it('shows a custom emoji recorded after that unmount', async () => {
    addCustomEmoji('partyparrot');
    const first = renderBar();
    flushSync();
    first.unmount();
    flushSync();

    getRecentEmojis(SERVER_ID).record('partyparrot');
    flushSync();

    const { container } = renderBar();
    await tick();
    expect(
      container.querySelector('[aria-label="React with partyparrot"] img')?.getAttribute('src')
    ).toBe('https://example.test/emoji/partyparrot.png');
  });
});
