import { PresenceStatus } from '@chatto/api-types/api/v1/presence_pb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

import { q } from '$lib/test-utils';
import type { MentionRole } from '$lib/state/room';
import UserContextMenu from './UserContextMenu.svelte';

const mentionRoles = vi.hoisted(() => ({
  roles: [] as MentionRole[],
  load: vi.fn(() => Promise.resolve(true))
}));

vi.mock('$lib/state/server/scope.svelte', () => ({
  useServerScope: () => ({ store: { mentionRoles } })
}));

vi.mock('$lib/state/userProfiles.svelte', () => ({
  getLiveDisplayName: (_userId: string, fallback: string) => fallback,
  getLiveLogin: (_userId: string, fallback: string) => fallback,
  getLiveAvatarUrl: (_userId: string, fallback: string | null) => fallback,
  getLiveCustomStatus: (_userId: string, fallback: unknown) => fallback
}));

vi.mock('$lib/state/presenceCache.svelte', () => ({
  getPresenceCache: () => ({
    get: (_scope: { serverId: string; userId: string }, fallback: string) => fallback
  })
}));

const user = {
  id: 'user-1',
  login: 'alice',
  displayName: 'Alice Example',
  avatarUrl: null,
  presenceStatus: PresenceStatus.ONLINE,
  customStatus: null
};

let originalShowPopover: typeof HTMLElement.prototype.showPopover;

function renderMenu(props: Record<string, unknown> = {}) {
  return render(UserContextMenu, {
    props: {
      user,
      anchorRect: { top: 10, bottom: 30, left: 20 },
      onClose: vi.fn(),
      ...props
    }
  });
}

beforeAll(() => {
  originalShowPopover = HTMLElement.prototype.showPopover;
  HTMLElement.prototype.showPopover = function showPopover() {
    this.setAttribute('popover-open', '');
  };
});

afterAll(() => {
  HTMLElement.prototype.showPopover = originalShowPopover;
});

describe('UserContextMenu', () => {
  it('renders the user profile content', async () => {
    const { container } = renderMenu();

    await expect.element(q(container, '[role="dialog"]')).toBeInTheDocument();
    expect(container.textContent).toContain('Alice Example');
    expect(container.textContent).toContain('@alice');
  });

  it('renders custom status as its own profile line', async () => {
    const { container } = renderMenu({
      user: {
        ...user,
        customStatus: {
          emoji: '🍜',
          text: 'chatto:status:out_for_lunch',
          expiresAt: null
        }
      }
    });

    await expect.element(q(container, '[role="dialog"]')).toBeInTheDocument();
    expect(container.querySelector('[role="dialog"] .flex-1 > .font-semibold')?.textContent).toBe(
      'Alice Example'
    );
    expect(q(container, '[aria-label="🍜 Out for lunch"]')).toBeTruthy();
    expect(container.textContent).toContain('Out for lunch');
  });

  it('shows Send Message only when allowed', async () => {
    const hidden = renderMenu({ canSendMessage: false });
    expect(hidden.container.textContent).not.toContain('Send Message');
    hidden.unmount();

    const visible = renderMenu({ canSendMessage: true });
    await expect.element(q(visible.container, 'button')).toHaveTextContent('Send Message');
  });

  it('calls send and close callbacks when sending a message', () => {
    const onSendMessage = vi.fn();
    const onClose = vi.fn();
    const { container } = renderMenu({ canSendMessage: true, onSendMessage, onClose });

    (q(container, 'button') as HTMLButtonElement).click();

    expect(onSendMessage).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderMenu({ onClose });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders the member roles as pills, highest role first', async () => {
    mentionRoles.roles = [
      { name: 'moderator', displayName: 'Moderator', isSystem: false, position: 100, pingable: false },
      {
        name: 'support',
        displayName: 'Support',
        isSystem: false,
        position: 50,
        pingable: false,
        color: 0x5865f2
      }
    ];
    const { container } = renderMenu({ roles: ['support', 'moderator'] });

    await expect.element(q(container, '[role="dialog"]')).toBeInTheDocument();
    const pills = [...container.querySelectorAll('.role-pills > span')].map((el) =>
      el.textContent?.trim()
    );
    expect(pills).toEqual(['Moderator', 'Support']);
    // Coloured roles paint their dot with the role colour.
    expect((q(container, '.role-pills > span span') as HTMLElement).style.background).toBe(
      'rgb(88, 101, 242)'
    );
    expect(mentionRoles.load).toHaveBeenCalled();
  });

  it('hides the roles section when the member has no explicit roles', async () => {
    mentionRoles.roles = [
      { name: 'moderator', displayName: 'Moderator', isSystem: false, position: 100, pingable: false }
    ];
    const { container } = renderMenu();

    await expect.element(q(container, '[role="dialog"]')).toBeInTheDocument();
    expect(container.querySelector('.role-pills')).toBeNull();
  });

  it('skips role names missing from the catalogue', async () => {
    mentionRoles.roles = [
      { name: 'moderator', displayName: 'Moderator', isSystem: false, position: 100, pingable: false }
    ];
    const { container } = renderMenu({ roles: ['moderator', 'deleted-role'] });

    await expect.element(q(container, '[role="dialog"]')).toBeInTheDocument();
    const pills = [...container.querySelectorAll('.role-pills > span')].map((el) =>
      el.textContent?.trim()
    );
    expect(pills).toEqual(['Moderator']);
  });
});
