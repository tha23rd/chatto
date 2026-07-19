import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationItemKind, type NotificationItem } from '$lib/api-client/notifications';
import {
  __nativeNotificationsTest,
  handleNativeNotificationAction,
  showNativeNotification
} from './notifications';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(() => Promise.resolve()),
  dismiss: vi.fn(() => Promise.resolve()),
  goto: vi.fn(() => Promise.resolve()),
  pendingHighlight: vi.fn(),
  showNotification: vi.fn(),
  flashFrame: vi.fn(),
  toastError: vi.fn(),
  // Server ids the registry considers still registered. Defaults to "all".
  registeredServers: null as Set<string> | null
}));

const stateStore = {
  pendingHighlights: { set: mocks.pendingHighlight },
  notifications: {
    dismiss: mocks.dismiss,
    getCleanPath: () => '/chat/-/room-1'
  }
};

function tryGetStore(serverId: string): typeof stateStore | undefined {
  if (mocks.registeredServers && !mocks.registeredServers.has(serverId)) return undefined;
  return stateStore;
}

vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('./client', () => ({
  getNativeClient: () => ({
    showNotification: mocks.showNotification,
    flashFrame: mocks.flashFrame
  })
}));
vi.mock('$lib/state/server/registry.svelte', () => ({
  serverRegistry: {
    tryGetStore: (id: string) => tryGetStore(id),
    handleAuthenticationRequired: vi.fn()
  }
}));
vi.mock('$lib/state/server/serverConnection.svelte', () => ({
  serverConnectionManager: {
    getClient: () => ({ connectBaseUrl: 'https://chat.example/api', bearerToken: 'token' })
  }
}));
vi.mock('$lib/api-client/messages', () => ({
  createMessageAPI: () => ({ createMessage: mocks.createMessage })
}));
vi.mock('$lib/i18n/messages', () => ({
  'native.notification.reply_placeholder': () => 'Reply',
  'native.notification.reply_failed': () => 'Reply failed'
}));
vi.mock('$lib/ui/toast', () => ({ toast: { error: mocks.toastError } }));

const notification = {
  kind: NotificationItemKind.Reply,
  id: 'notification-1',
  createdAt: new Date('2026-07-18T12:00:00Z').toISOString(),
  actor: {
    id: 'user-1',
    login: 'member',
    displayName: 'Member',
    deleted: false,
    avatarUrl: null,
    presenceStatus: 'OFFLINE'
  },
  summary: 'Replied to your message',
  replyRoom: { id: 'room-1', name: 'General' },
  replyEventId: 'event-1',
  inReplyToId: 'event-0',
  replyInThread: null
} as unknown as NotificationItem;

describe('native notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registeredServers = null;
    __nativeNotificationsTest.reset();
  });

  it('publishes a hydrated notification and routes a click', async () => {
    showNativeNotification(
      { id: 'server-1', name: 'Community' },
      notification,
      false
    );

    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'server-1:notification-1',
        title: 'Member',
        body: 'Replied to your message',
        canReply: true
      })
    );

    const appUi = { disableRoomCallWideFor: vi.fn() };
    await handleNativeNotificationAction(
      { type: 'click', id: 'server-1:notification-1' },
      appUi
    );

    expect(appUi.disableRoomCallWideFor).toHaveBeenCalledWith('server-1', 'room-1');
    expect(mocks.pendingHighlight).toHaveBeenCalledWith('room-1', null, 'event-1');
    expect(mocks.dismiss).toHaveBeenCalledWith('notification-1');
    expect(mocks.goto).toHaveBeenCalledWith('/chat/-/room-1');
  });

  it('sends an inline reply to the notification room', async () => {
    showNativeNotification(
      { id: 'server-1', name: 'Community' },
      notification,
      false
    );

    await handleNativeNotificationAction(
      { type: 'reply', id: 'server-1:notification-1', reply: '  Thanks  ' },
      { disableRoomCallWideFor: vi.fn() }
    );

    expect(mocks.createMessage).toHaveBeenCalledWith({
      roomId: 'room-1',
      body: 'Thanks',
      threadRootEventId: null,
      inReplyTo: 'event-1'
    });
    expect(mocks.dismiss).toHaveBeenCalledWith('notification-1');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('bounds retained targets, evicting oldest-first', () => {
    const max = __nativeNotificationsTest.MAX_NOTIFICATION_TARGETS;
    for (let i = 0; i < max + 5; i++) {
      showNativeNotification(
        { id: 'server-1', name: 'Community' },
        { ...notification, id: `notification-${i}` } as NotificationItem,
        false
      );
    }

    expect(__nativeNotificationsTest.targetCount()).toBe(max);
    // The five oldest were evicted; the newest are retained.
    expect(__nativeNotificationsTest.hasTarget('server-1', 'notification-0')).toBe(false);
    expect(__nativeNotificationsTest.hasTarget('server-1', 'notification-4')).toBe(false);
    expect(__nativeNotificationsTest.hasTarget('server-1', 'notification-5')).toBe(true);
    expect(__nativeNotificationsTest.hasTarget('server-1', `notification-${max + 4}`)).toBe(true);
  });

  it('drops targets for servers that are no longer registered', () => {
    mocks.registeredServers = new Set(['server-1', 'server-2']);
    showNativeNotification({ id: 'server-2', name: 'Other' }, notification, false);
    expect(__nativeNotificationsTest.hasTarget('server-2', 'notification-1')).toBe(true);

    // server-2 is removed; the next notification prunes its lingering target.
    mocks.registeredServers = new Set(['server-1']);
    showNativeNotification(
      { id: 'server-1', name: 'Community' },
      { ...notification, id: 'notification-2' } as NotificationItem,
      false
    );

    expect(__nativeNotificationsTest.hasTarget('server-2', 'notification-1')).toBe(false);
    expect(__nativeNotificationsTest.hasTarget('server-1', 'notification-2')).toBe(true);
  });
});
