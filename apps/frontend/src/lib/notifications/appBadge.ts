/**
 * App badge helper for installed-client attention indicators.
 *
 * Publishes one authoritative intent to optional native handlers and the web
 * Badging API. Safari requires notification permission; Chrome/Edge work
 * without it.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Badging_API
 */

export type AppBadgeIntent =
  | { kind: 'clear' }
  | { kind: 'flag' }
  | { kind: 'count'; count: number };

export type AppBadgeHandler = (intent: AppBadgeIntent) => void | Promise<void>;

const appBadgeHandlers = new Set<AppBadgeHandler>();
let latestAppBadgeIntent: AppBadgeIntent | null = null;

/**
 * Check if the Badging API is supported in this browser context.
 */
export function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'setAppBadge' in navigator;
}

function isInstalledAppContext(): boolean {
  if (typeof window === 'undefined') return false;

  const standaloneDisplayModes = [
    'standalone',
    'fullscreen',
    'minimal-ui',
    'window-controls-overlay'
  ];
  if (
    standaloneDisplayModes.some((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches)
  ) {
    return true;
  }

  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function normalizeBadgeCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

export function normalizeBadgeIntent(intent: AppBadgeIntent): AppBadgeIntent {
  if (intent.kind !== 'count') return intent;
  const count = normalizeBadgeCount(intent.count);
  return count > 0 ? { kind: 'count', count } : { kind: 'clear' };
}

async function deliverBadgeIntent(handler: AppBadgeHandler, intent: AppBadgeIntent): Promise<void> {
  try {
    await handler(intent);
  } catch {
    // Native and third-party badge surfaces are optional and best-effort.
  }
}

function publishBadgeIntent(intent: AppBadgeIntent): AppBadgeIntent {
  const normalized = normalizeBadgeIntent(intent);
  latestAppBadgeIntent = normalized;
  for (const handler of appBadgeHandlers) {
    void deliverBadgeIntent(handler, normalized);
  }
  return normalized;
}

/**
 * Register an optional installed-client badge surface.
 *
 * The latest authoritative intent is replayed so a host initialized after
 * notification hydration cannot leave a stale badge behind.
 */
export function registerAppBadgeHandler(handler: AppBadgeHandler): () => void {
  appBadgeHandlers.add(handler);
  if (latestAppBadgeIntent) {
    void deliverBadgeIntent(handler, latestAppBadgeIntent);
  }

  return () => {
    appBadgeHandlers.delete(handler);
  };
}

function legacyNotificationCount(intent: AppBadgeIntent): number {
  switch (intent.kind) {
    case 'count':
      return normalizeBadgeCount(intent.count);
    case 'flag':
      return 1;
    case 'clear':
      return 0;
  }
}

type ServiceWorkerBadgeStateMessage = {
  type: 'chatto-badge-state';
  badgeIntent: AppBadgeIntent;
  notificationCount: number;
  serviceWorkerAppBadgeEnabled: boolean;
};

let latestServiceWorkerBadgeState: ServiceWorkerBadgeStateMessage | null = null;
let observedServiceWorkerContainer: ServiceWorkerContainer | null = null;

function observeServiceWorkerController(container: ServiceWorkerContainer): void {
  if (observedServiceWorkerContainer === container) return;
  observedServiceWorkerContainer = container;
  container.addEventListener('controllerchange', () => {
    if (observedServiceWorkerContainer !== container) return;
    if (latestServiceWorkerBadgeState) {
      container.controller?.postMessage(latestServiceWorkerBadgeState);
    }
  });
}

/**
 * Share the foreground badge intent with the service worker so stale
 * push/native notification badge state can be reconciled against the app's
 * authoritative pending-notification state.
 */
export function syncServiceWorkerNotificationBadgeState(intent: AppBadgeIntent): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const normalized = normalizeBadgeIntent(intent);
  const message: ServiceWorkerBadgeStateMessage = {
    type: 'chatto-badge-state',
    badgeIntent: normalized,
    // Kept as a best-effort fallback for older active service workers.
    notificationCount: legacyNotificationCount(normalized),
    serviceWorkerAppBadgeEnabled: isSupported() && isInstalledAppContext()
  };
  const container = navigator.serviceWorker;
  latestServiceWorkerBadgeState = message;
  observeServiceWorkerController(container);

  if (container.controller) {
    container.controller.postMessage(message);
    return;
  }

  // A first PWA launch may have an active worker before the page is controlled.
  // Deliver directly to that worker, while controllerchange above covers later
  // worker replacements. Only the newest intent may win this asynchronous path.
  void container.ready
    .then((registration) => {
      if (latestServiceWorkerBadgeState !== message) return;
      (container.controller ?? registration.active)?.postMessage(message);
    })
    .catch(() => {});
}

/**
 * Update the app badge for the given intent.
 * Sets a numeric badge for DMs, a flag/dot for channel notifications, and
 * clears it when notifications are handled.
 *
 * The browser surface silently fails if the Badging API is unsupported, the
 * app is not installed as a PWA, or Safari lacks notification permission.
 * Registered installed-client handlers remain independent and best-effort.
 */
export async function updateBadge(intent: AppBadgeIntent): Promise<void> {
  const normalized = publishBadgeIntent(intent);
  if (!isSupported()) return;

  try {
    switch (normalized.kind) {
      case 'count':
        await navigator.setAppBadge(normalized.count);
        break;
      case 'flag':
        await navigator.setAppBadge();
        break;
      case 'clear':
        await navigator.clearAppBadge();
        break;
    }
  } catch (e) {
    // Silently fail - badge API may not work in all contexts
    // (e.g., not installed as PWA, permission denied on Safari)
    console.debug('Badge update failed:', e);
  }
}

/**
 * Clear the app badge.
 */
export async function clearBadge(): Promise<void> {
  publishBadgeIntent({ kind: 'clear' });
  if (!isSupported()) return;

  try {
    await navigator.clearAppBadge();
  } catch {
    // Silently fail
  }
}
