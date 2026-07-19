import { base } from '$app/paths';
import { getNativeClient } from '$lib/native/client';

/**
 * Register the PWA worker only in browser-hosted builds.
 *
 * The native shell owns notifications, badges, and whole-app updates, so a
 * second shell cache or push listener inside its renderer would duplicate work.
 */
export async function registerBrowserServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (getNativeClient() || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  return navigator.serviceWorker.register(`${base}/service-worker.js`);
}
