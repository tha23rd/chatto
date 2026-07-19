export const NATIVE_HOST_API_VERSION = 1 as const;

export type Unsubscribe = () => void;

export interface NativeCapabilities {
  readonly nativeOAuth: boolean;
  readonly nativeHttp: boolean;
  readonly nativeRealtime: boolean;
  readonly globalPushToTalk: boolean;
  readonly tray: boolean;
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
  quit(): Promise<void>;
}
