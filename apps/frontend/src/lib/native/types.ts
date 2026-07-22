import type { AppBadgeIntent } from '$lib/notifications/appBadge';

export const NATIVE_HOST_API_VERSION = 3 as const;

export type Unsubscribe = () => void | Promise<void>;

export interface NativeCapabilities {
  readonly nativeOAuth: boolean;
  readonly nativeHttp: boolean;
  readonly nativeRealtime: boolean;
  readonly globalPushToTalk: boolean;
  readonly tray: boolean;
  readonly appBadge: boolean;
  readonly desktopUpdates: boolean;
}

export type DesktopUpdateChannel = 'stable' | 'nightly';
export type DesktopUpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'failed';

export interface DesktopUpdateSnapshot {
  readonly supported: boolean;
  readonly channel: DesktopUpdateChannel;
  readonly phase: DesktopUpdatePhase;
  readonly currentVersion: string;
  readonly candidateVersion?: string;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number;
  readonly lastCheckedAt?: number;
  readonly errorCode?:
    | 'network'
    | 'metadata'
    | 'signature'
    | 'download'
    | 'install'
    | 'unavailable';
}

export interface NativeOAuthRequest {
  readonly serverUrl: string;
  readonly authorizePath: string;
  readonly codeChallenge: string;
  readonly codeVerifier: string;
  readonly state: string;
}

export interface NativeOAuthUser {
  readonly id: string;
  readonly login: string;
  readonly displayName?: string | null;
  readonly avatarUrl?: string | null;
}

export interface NativeOAuthResult {
  readonly accessToken: string;
  readonly user?: NativeOAuthUser | null;
}

export type NativePushToTalkState = 'pressed' | 'released';
export type NativeTrayAction = 'show' | 'toggle-mute' | 'toggle-deafen';

export interface NativeCallControls {
  readonly connected: boolean;
  readonly muted: boolean;
  readonly deafened: boolean;
}

export type RealtimeMessageData = ArrayBuffer | Blob | Uint8Array;

export interface RealtimeSocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: RealtimeMessageData }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * Frontend-owned boundary for optional desktop behavior.
 *
 * Application code selects behavior from `capabilities`; it never inspects a
 * platform global or imports a Tauri package directly.
 */
export interface NativeHost {
  readonly apiVersion: typeof NATIVE_HOST_API_VERSION;
  readonly kind: 'browser' | 'tauri';
  readonly capabilities: NativeCapabilities;

  /** Temporarily allow one validated Chatto server origin for native networking. */
  registerServerOrigin(url: string): Unsubscribe;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  createRealtimeSocket(url: string): RealtimeSocketLike;
  startServerOAuth(request: NativeOAuthRequest): Promise<NativeOAuthResult>;
  openExternal(url: string): Promise<void>;
  registerPushToTalk(
    accelerator: string,
    listener: (state: NativePushToTalkState) => void
  ): Promise<Unsubscribe>;
  onTrayAction(listener: (action: NativeTrayAction) => void): Promise<Unsubscribe>;
  setCallControls(controls: NativeCallControls): Promise<void>;
  /** Show or clear the host's installed-app attention indicator. */
  setAppBadge(intent: AppBadgeIntent): Promise<void>;
  getDesktopUpdateState(): Promise<DesktopUpdateSnapshot>;
  setDesktopUpdateChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateSnapshot>;
  checkForDesktopUpdate(): Promise<DesktopUpdateSnapshot>;
  installDesktopUpdate(): Promise<void>;
  onDesktopUpdateState(listener: (snapshot: DesktopUpdateSnapshot) => void): Promise<Unsubscribe>;
  quit(): Promise<void>;
}
