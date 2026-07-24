export const APP_BADGE_REFRESH_MESSAGE_TYPE = 'app-badge-refresh';

export type AppBadgeIntent =
  | { kind: 'clear' }
  | { kind: 'flag' }
  | { kind: 'count'; count: number };

type AppBadgeRefreshMessage = {
  type: typeof APP_BADGE_REFRESH_MESSAGE_TYPE;
};

export type AppBadgeHandler = (intent: AppBadgeIntent) => void | Promise<void>;

// Native shells (the Tauri desktop app) drive an OS taskbar/dock badge the web
// Badging API cannot reach. They register a handler here so the single
// authoritative intent passed to updateAppBadge() is mirrored to the OS badge.
// This block is the only fork-specific addition to this module; the rest tracks
// upstream so main -> main-native syncs stay clean.
const appBadgeHandlers = new Set<AppBadgeHandler>();
let latestAppBadgeIntent: AppBadgeIntent | null = null;

async function deliverToNativeBadgeSurface(
  handler: AppBadgeHandler,
  intent: AppBadgeIntent
): Promise<void> {
  try {
    await handler(intent);
  } catch {
    // Native badge surfaces are optional and best-effort.
  }
}

/**
 * Register an optional native badge surface, such as the Tauri desktop taskbar.
 * The latest authoritative intent is replayed so a host initialised after
 * notification hydration cannot leave a stale badge behind. Returns an
 * unregister function.
 */
export function registerAppBadgeHandler(handler: AppBadgeHandler): () => void {
  appBadgeHandlers.add(handler);
  if (latestAppBadgeIntent) void deliverToNativeBadgeSurface(handler, latestAppBadgeIntent);
  return () => {
    appBadgeHandlers.delete(handler);
  };
}

/** Updates the installed app badge from Chatto's authoritative notification state. */
export async function updateAppBadge(intent: AppBadgeIntent): Promise<void> {
  // Mirror the authoritative intent to native badge surfaces (Tauri desktop)
  // before the web Badging API, so the OS badge updates even where navigator is
  // unavailable.
  latestAppBadgeIntent = intent;
  for (const handler of appBadgeHandlers) void deliverToNativeBadgeSurface(handler, intent);

  if (typeof navigator === 'undefined') return;

  try {
    switch (intent.kind) {
      case 'count':
        await navigator.setAppBadge?.(intent.count);
        break;
      case 'flag':
        await navigator.setAppBadge?.();
        break;
      case 'clear':
        await navigator.clearAppBadge?.();
        break;
    }
  } catch {
    // Badge support and permission vary by browser and installation context.
  }
}

/** Replays the visible page's aggregate badge when a regular push may have replaced it. */
export function listenForAppBadgeRefresh(refresh: () => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  const handler = (event: MessageEvent<unknown>) => {
    if (!isAppBadgeRefreshMessage(event.data)) return;
    refresh();
  };

  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}

function isAppBadgeRefreshMessage(value: unknown): value is AppBadgeRefreshMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === APP_BADGE_REFRESH_MESSAGE_TYPE
  );
}
