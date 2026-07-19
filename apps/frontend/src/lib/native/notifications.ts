import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type { NativeNotificationAction } from '@chatto/native-bridge';
import { createMessageAPI } from '$lib/api-client/messages';
import { NotificationItemKind, type NotificationItem } from '$lib/api-client/notifications';
import * as m from '$lib/i18n/messages';
import { prepareUiForNotificationTarget } from '$lib/notifications/notificationNavigationUi';
import type { AppUiState } from '$lib/state/appUi.svelte';
import { notificationTarget } from '$lib/state/server/notifications.svelte';
import { serverConnectionManager } from '$lib/state/server/serverConnection.svelte';
import { serverRegistry } from '$lib/state/server/registry.svelte';
import { toast } from '$lib/ui/toast';
import { getNativeClient } from './client';

type NativeNotificationTarget = {
  serverId: string;
  notification: NotificationItem;
};

// Upper bound on retained notification targets. The OS does not tell us when a
// notification is dismissed without interaction, so without a bound this Map
// would grow for the lifetime of a long-running desktop session.
const MAX_NOTIFICATION_TARGETS = 200;

const targets = new Map<string, NativeNotificationTarget>();

/**
 * Keep {@link targets} bounded. Drops entries for servers that are no longer
 * registered (covers server removal without coupling the shared registry to
 * native code), then evicts oldest-first — `Map` preserves insertion order — to
 * stay within {@link MAX_NOTIFICATION_TARGETS}.
 */
function pruneNotificationTargets(): void {
  for (const [id, target] of targets) {
    if (!serverRegistry.tryGetStore(target.serverId)) targets.delete(id);
  }
  while (targets.size > MAX_NOTIFICATION_TARGETS) {
    const oldest = targets.keys().next().value;
    if (oldest === undefined) break;
    targets.delete(oldest);
  }
}

/** Publish a hydrated realtime notification through the native shell. */
export function showNativeNotification(
  server: { id: string; name: string },
  notification: NotificationItem,
  silent: boolean
): void {
  const nativeClient = getNativeClient();
  if (!nativeClient || silent) return;

  const id = notificationId(server.id, notification.id);
  targets.set(id, { serverId: server.id, notification });
  pruneNotificationTargets();
  const target = notificationTarget(notification);
  nativeClient.showNotification({
    id,
    title: notification.actor?.displayName || server.name,
    body: notification.summary,
    canReply: target.roomId !== null,
    replyPlaceholder: m['native.notification.reply_placeholder']()
  });
  if (notification.kind === NotificationItemKind.Mention && !document.hasFocus()) {
    nativeClient.flashFrame(true);
  }
}

/**
 * Look up a freshly added realtime notification and publish it through the
 * native shell. Keeps the store lookup out of the shared `NotificationSync`
 * component; a no-op on the web (see {@link showNativeNotification}).
 */
export function showCreatedNativeNotification(
  server: { id: string; name: string },
  store: { notifications: NotificationItem[] },
  notificationId: string,
  silent: boolean
): void {
  if (silent || !getNativeClient()) return;
  const hydrated = store.notifications.find((notification) => notification.id === notificationId);
  if (hydrated) showNativeNotification(server, hydrated, silent);
}

export function removeNativeNotificationTarget(serverId: string, notificationIdValue: string): void {
  targets.delete(notificationId(serverId, notificationIdValue));
}

/** Route a click or inline reply from the native shell back into the web app. */
export async function handleNativeNotificationAction(
  action: NativeNotificationAction,
  appUi: Pick<AppUiState, 'disableRoomCallWideFor'>
): Promise<void> {
  const target = targets.get(action.id);
  if (!target) return;
  if (!serverRegistry.tryGetStore(target.serverId)) {
    targets.delete(action.id);
    return;
  }
  if (action.type === 'click') await openNotification(target, appUi);
  else await replyToNotification(target, action.reply);
}

async function openNotification(
  target: NativeNotificationTarget,
  appUi: Pick<AppUiState, 'disableRoomCallWideFor'>
): Promise<void> {
  const stores = serverRegistry.tryGetStore(target.serverId);
  if (!stores) return;
  const targetData = notificationTarget(target.notification);
  prepareUiForNotificationTarget(appUi, target.serverId, targetData);
  if (targetData.eventId && targetData.roomId) {
    stores.pendingHighlights.set(targetData.roomId, targetData.threadRootId, targetData.eventId);
  }
  void stores.notifications.dismiss(target.notification.id).catch(() => {});
  targets.delete(notificationId(target.serverId, target.notification.id));
  const path = stores.notifications.getCleanPath(target.serverId, target.notification);
  await goto(resolve(path as '/'));
}

async function replyToNotification(target: NativeNotificationTarget, reply: string): Promise<void> {
  const body = reply.trim();
  const targetData = notificationTarget(target.notification);
  if (!body || !targetData.roomId) return;
  try {
    const connection = serverConnectionManager.getClient(target.serverId);
    await createMessageAPI({
      serverId: target.serverId,
      baseUrl: connection.connectBaseUrl,
      bearerToken: connection.bearerToken,
      onAuthenticationRequired: () => serverRegistry.handleAuthenticationRequired(target.serverId)
    }).createMessage({
      roomId: targetData.roomId,
      body,
      threadRootEventId: targetData.threadRootId,
      inReplyTo: targetData.eventId
    });
    const stores = serverRegistry.tryGetStore(target.serverId);
    if (stores) void stores.notifications.dismiss(target.notification.id).catch(() => {});
    targets.delete(notificationId(target.serverId, target.notification.id));
  } catch {
    toast.error(m['native.notification.reply_failed']());
  }
}

function notificationId(serverId: string, notificationIdValue: string): string {
  return `${serverId}:${notificationIdValue}`;
}

export const __nativeNotificationsTest = {
  MAX_NOTIFICATION_TARGETS,
  targetCount: (): number => targets.size,
  hasTarget: (serverId: string, notificationIdValue: string): boolean =>
    targets.has(notificationId(serverId, notificationIdValue)),
  reset: (): void => targets.clear()
};
