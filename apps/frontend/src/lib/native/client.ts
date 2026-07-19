import type { ChattoNativeClient } from '@chatto/native-bridge';

/** Return the allowlisted desktop bridge when running in the bundled renderer. */
export function getNativeClient(): ChattoNativeClient | null {
  if (typeof window === 'undefined') return null;
  return window.chattoNative ?? null;
}

export function isNativeClient(): boolean {
  return getNativeClient() !== null;
}

/** Temporarily authorize the exact server origin chosen for a discovery probe. */
export function allowNativeServerOriginForProbe(serverUrl: string): void {
  const nativeClient = getNativeClient();
  if (!nativeClient) return;
  nativeClient.allowServerOriginForProbe(new URL(serverUrl).origin);
}
