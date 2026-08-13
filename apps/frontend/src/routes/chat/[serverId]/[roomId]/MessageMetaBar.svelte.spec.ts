import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import '../../../../app.css';
import MessageMetaBar from './MessageMetaBar.svelte';
import { buildMessageActionModel } from './messageActionModel';

// 1x1 transparent PNG so the custom-emoji <img> resolves to a real element.
const CUSTOM_EMOJI_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const mocks = vi.hoisted(() => ({
  actions: {
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    toggleReaction: vi.fn(),
    startEdit: vi.fn(),
    openDeleteConfirmation: vi.fn(),
    copyMessageText: vi.fn(),
    copyMessageLink: vi.fn()
  }
}));

// Treat only the `custom` emoji name as a server custom emoji; everything else
// falls through to the built-in gemoji path.
vi.mock('$lib/state/customEmojis.svelte', () => ({
  getCustomEmoji: (_server: string, name: string) =>
    name === 'custom' ? { name: 'custom', url: CUSTOM_EMOJI_URL } : undefined,
  getCustomEmojis: () => ({ ensureLoaded: vi.fn() }),
  notifyCustomEmojis: vi.fn()
}));

// The component ensures this server's custom-emoji catalog is loaded, which
// needs a real server scope. Reaction behavior comes from `action` instead.
vi.mock('$lib/hooks', () => ({
  useEnsureCustomEmojis: () => {}
}));


vi.mock('$app/paths', () => ({
  assets: '',
  base: '',
  resolve: (path: string, params?: Record<string, string>) =>
    path
      .replace('[serverId]', params?.serverId ?? '')
      .replace('[roomId]', params?.roomId ?? '')
      .replace('[threadId]', params?.threadId ?? '')
}));

vi.mock('$lib/state/server/scope.svelte', () => ({
  useServerScope: () => ({
    serverId: 'server-1',
    store: {},
    connection: {
      client: {
        mutation: vi.fn().mockResolvedValue({ error: null })
      }
    },
    isCurrent: () => true
  })
}));

const baseProps = {
  roomId: 'room-1',
  serverSegment: '-',
  threadRootEventId: 'thread-1',
  reactions: [],
  action: buildAction(),
  onOpenThread: vi.fn()
};

function buildAction({
  canReact = false,
  reactions = [],
  messageStore,
  canPin = false,
  isPinned = false,
  togglePin = vi.fn().mockResolvedValue(undefined)
}: {
  canReact?: boolean;
  reactions?: { emoji: string; hasReacted: boolean }[];
  messageStore?: never;
  canPin?: boolean;
  isPinned?: boolean;
  togglePin?: () => Promise<void>;
} = {}) {
  return buildMessageActionModel({
    actions: mocks.actions,
    params: {
      serverId: 'server-1',
      roomId: 'room-1',
      messageEventId: 'thread-1',
      eventId: 'thread-1',
      messageBody: '',
      threadRootEventId: 'thread-1',
      messageStore
    },
    reactions,
    canReact,
    canEdit: false,
    canDelete: false,
    canPin,
    isPinned,
    togglePin,
    replyInRoomLabel: 'Reply',
    replyThreadLabel: 'Reply in thread'
  });
}

function reaction(
  overrides: Partial<{
    emoji: string;
    count: number;
    hasReacted: boolean;
    users: { id: string; displayName: string }[];
  }> = {}
) {
  return {
    emoji: 'thumbsup',
    count: 2,
    hasReacted: false,
    users: [
      { id: 'user-1', displayName: 'Alice' },
      { id: 'user-2', displayName: 'Bob' }
    ],
    ...overrides
  };
}

describe('MessageMetaBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the reply count badge as a native thread link', async () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        replyCount: 2
      }
    });

    const link = q(container, 'a[href="/chat/-/room-1/thread-1"]') as HTMLAnchorElement;

    await expect.element(link).toBeInTheDocument();
    expect(link.textContent?.replace(/\s+/g, ' ').trim()).toContain('2 replies');
    expect(link.classList).toContain('whitespace-nowrap');
  });

  it('renders an explicitly created empty thread', async () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        threadExists: true,
        replyCount: 0
      }
    });

    const link = q(container, 'a[href="/chat/-/room-1/thread-1"]') as HTMLAnchorElement;

    await expect.element(link).toBeInTheDocument();
    expect(link.textContent?.trim()).toContain('Thread');
  });

  it('renders the echo thread badge as a native thread link', async () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        isEchoEvent: true
      }
    });

    const link = q(container, 'a[href="/chat/-/room-1/thread-1"]') as HTMLAnchorElement;

    await expect.element(link).toBeInTheDocument();
    expect(link.textContent).toContain('Thread');
    expect(link.classList).toContain('whitespace-nowrap');
    const icon = link.querySelector('.iconify');
    expect(icon?.classList).toContain('icon-[uil--corner-up-right]');
    expect(icon?.classList).toContain('rtl:-scale-x-100');
  });

  it('opens the thread through the existing callback for plain primary clicks', () => {
    const onOpenThread = vi.fn();
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        onOpenThread,
        replyCount: 1
      }
    });

    const link = q(container, 'a[href="/chat/-/room-1/thread-1"]') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });

    const allowed = link.dispatchEvent(event);

    expect(allowed).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenThread).toHaveBeenCalledOnce();
  });

  it('leaves modified clicks to native link behavior', () => {
    const onOpenThread = vi.fn();
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        onOpenThread,
        replyCount: 1
      }
    });

    const link = q(container, 'a[href="/chat/-/room-1/thread-1"]') as HTMLAnchorElement;
    let preventedByComponent: boolean | undefined;
    link.addEventListener('click', (event) => {
      preventedByComponent = event.defaultPrevented;
      event.preventDefault();
    });
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true
    });

    link.dispatchEvent(event);

    expect(preventedByComponent).toBe(false);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('does not bubble press-start gestures to the message row', () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        replyCount: 1
      }
    });
    const touchStart = vi.fn();
    const mouseDown = vi.fn();
    container.addEventListener('touchstart', touchStart);
    container.addEventListener('mousedown', mouseDown);

    const link = q(container, 'a[href="/chat/-/room-1/thread-1"]') as HTMLAnchorElement;
    const touchEvent = new Event('touchstart', { bubbles: true, cancelable: true });
    const mouseEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });

    expect(link.dispatchEvent(touchEvent)).toBe(true);
    expect(touchEvent.defaultPrevented).toBe(false);
    expect(touchStart).not.toHaveBeenCalled();

    expect(link.dispatchEvent(mouseEvent)).toBe(true);
    expect(mouseEvent.defaultPrevented).toBe(false);
    expect(mouseDown).not.toHaveBeenCalled();
  });

  it('keeps follow toggles as buttons', () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        replyCount: 1,
        isFollowingThread: true,
        onToggleThreadFollow: vi.fn()
      }
    });

    const followButton = q(container, 'button[title="Unfollow thread"]');

    expect(followButton).not.toBeNull();
    expect(followButton?.closest('a')).toBeNull();
  });

  it('disables the follow toggle while a request is pending', () => {
    const onToggleThreadFollow = vi.fn();
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        replyCount: 1,
        isFollowingThread: true,
        isThreadFollowPending: true,
        onToggleThreadFollow
      }
    });

    const followButton = q(container, 'button[title="Unfollow thread"]') as HTMLButtonElement;
    followButton.click();

    expect(followButton.disabled).toBe(true);
    expect(onToggleThreadFollow).not.toHaveBeenCalled();
  });

  it('shows a pinned indicator and confirms before removing the pin', async () => {
    const togglePin = vi.fn().mockResolvedValue(undefined);
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        action: buildAction({ canPin: true, isPinned: true, togglePin })
      }
    });

    const pinButton = q(container, 'button[aria-label="Unpin message"]') as HTMLButtonElement;
    expect(pinButton).not.toBeNull();
    expect(pinButton.querySelector('span.iconify')).not.toBeNull();

    pinButton.click();
    await vi.waitFor(() => expect(q(document.body, 'dialog[open]')).not.toBeNull());
    const dialog = q(document.body, 'dialog[open]')!;
    expect(dialog.textContent).toContain('Are you sure you want to remove this pin?');
    expect(togglePin).not.toHaveBeenCalled();

    const confirmButton = q(dialog, 'button[type="submit"]') as HTMLButtonElement;
    confirmButton.click();
    await vi.waitFor(() => expect(togglePin).toHaveBeenCalledOnce());
  });

  it('does not render a pin indicator for unpinned messages', () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        action: buildAction({ canPin: true, isPinned: false })
      }
    });

    expect(q(container, 'button[aria-label="Unpin message"]')).toBeNull();
  });

  it('keeps the pinned indicator visible when the viewer cannot remove the pin', () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        action: buildAction({ isPinned: true })
      }
    });

    expect(q(container, '[role="img"][aria-label="Pinned message"]')).not.toBeNull();
    expect(q(container, 'button[aria-label="Unpin message"]')).toBeNull();
  });

  it('shows reaction tooltips with the readable reaction name and reacting users', () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        reactions: [reaction()]
      }
    });

    const wrapper = q(container, 'button[aria-label="Add 👍 reaction (2)"]')!
      .parentElement as HTMLElement;

    wrapper.dispatchEvent(new MouseEvent('mouseenter'));
    flushSync();

    const tooltip = q(container, '[role="tooltip"]')!;
    const reactionName = q(tooltip, 'strong')!;
    const userNames = Array.from(
      tooltip.querySelectorAll<HTMLElement>('[data-testid="reaction-tooltip-user"]')
    ).map((el) => el.textContent?.trim());

    expect(reactionName.textContent?.trim()).toBe('Thumbs up');
    expect(userNames).toEqual(['Alice', 'Bob']);
    expect(tooltip.classList.contains('menu')).toBe(true);
    expect(q(tooltip, '.menu-section')).not.toBeNull();
    expect(
      Array.from(
        tooltip.querySelectorAll<HTMLElement>('[data-testid="reaction-tooltip-user"]')
      ).every((el) => el.classList.contains('break-words'))
    ).toBe(true);
    expect(reactionName.classList.contains('font-semibold')).toBe(true);
    expect(tooltip.innerHTML).not.toContain('whitespace-nowrap');
  });

  it('caps long reacting user lists and summarizes the remaining users', () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        reactions: [
          reaction({
            count: 72,
            users: [
              { id: 'user-1', displayName: 'Azerbaijan' },
              { id: 'user-2', displayName: 'German_Noob_With_An_Absurdly_Long_Name' },
              { id: 'user-3', displayName: '2tap2b' },
              { id: 'user-4', displayName: 'muchtin' },
              { id: 'user-5', displayName: 'patry' }
            ]
          })
        ]
      }
    });

    const wrapper = q(container, 'button[aria-label="Add 👍 reaction (72)"]')!
      .parentElement as HTMLElement;

    wrapper.dispatchEvent(new MouseEvent('mouseenter'));
    flushSync();

    const tooltip = q(container, '[role="tooltip"]')!;
    const content = q(tooltip, '.menu-section')!;
    const reactingUsers = q(tooltip, 'span.text-muted')!;
    const userNames = Array.from(
      tooltip.querySelectorAll<HTMLElement>('[data-testid="reaction-tooltip-user"]')
    ).map((el) => el.textContent?.trim());

    expect(content.classList.contains('min-w-0')).toBe(true);
    expect(tooltip.classList.contains('menu')).toBe(true);
    expect(tooltip.classList.contains('w-64')).toBe(true);
    expect(reactingUsers.classList.contains('min-w-0')).toBe(true);
    expect(userNames).toEqual([
      'Azerbaijan',
      'German_Noob_With_An_Absurdly_Long_Name',
      '2tap2b',
      'muchtin',
      'patry'
    ]);
    expect(reactingUsers.textContent).toContain('+ 67 more');
  });

  it('keeps the reaction tooltip available when the reaction button is disabled', () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        reactions: [
          reaction({ emoji: 'heart', count: 1, users: [{ id: 'user-1', displayName: 'Alice' }] })
        ],
        action: buildAction()
      }
    });

    const button = q(container, 'button[aria-label="Add ❤️ reaction (1)"]')! as HTMLButtonElement;
    const wrapper = button.parentElement as HTMLElement;

    expect(button.disabled).toBe(true);

    wrapper.dispatchEvent(new MouseEvent('mouseenter'));
    flushSync();

    const tooltip = q(container, '[role="tooltip"]')!;
    expect(q(tooltip, 'strong')?.textContent?.trim()).toBe('Heart');
    expect(q(tooltip, '[data-testid="reaction-tooltip-user"]')?.textContent?.trim()).toBe('Alice');
  });

  it('vertically aligns custom-emoji reaction pills with unicode ones', async () => {
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        reactions: [
          reaction({ emoji: 'thumbsup', count: 2 }),
          reaction({ emoji: 'custom', count: 1 })
        ]
      }
    });

    const unicodeButton = q(container, 'button[aria-label="Add 👍 reaction (2)"]') as HTMLElement;
    const customButton = q(
      container,
      'button[aria-label="Add custom reaction (1)"]'
    ) as HTMLElement;
    expect(unicodeButton).not.toBeNull();
    expect(customButton).not.toBeNull();

    // Let the custom-emoji image resolve so layout settles.
    const img = q(customButton, 'img') as HTMLImageElement;
    if (!img.complete) {
      await new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }
    flushSync();

    const unicodeRect = unicodeButton.getBoundingClientRect();
    const customRect = customButton.getBoundingClientRect();
    const unicodeCenter = unicodeRect.top + unicodeRect.height / 2;
    const customCenter = customRect.top + customRect.height / 2;

    // Before the wrapper became `inline-flex`, the custom pill floated ~1px
    // above the unicode pill because its inline-flex button sat at the top of
    // an oversized text line box. Guard that they stay centered together.
    expect(Math.abs(customCenter - unicodeCenter)).toBeLessThan(0.75);
  });

  it('routes reaction pill clicks through shared reaction actions', async () => {
    const messageStore = { beginOptimisticReaction: vi.fn() };
    const { container } = render(MessageMetaBar, {
      props: {
        ...baseProps,
        reactions: [reaction({ hasReacted: true })],
        action: buildAction({
          canReact: true,
          reactions: [reaction({ hasReacted: true })],
          messageStore: messageStore as never
        })
      }
    });

    (q(container, 'button[aria-label="Remove 👍 reaction (2)"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(mocks.actions.toggleReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: 'room-1',
          messageEventId: 'thread-1',
          messageStore
        }),
        'thumbsup',
        true
      );
    });
  });
});
