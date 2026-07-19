/** Stable origin used by the bundled renderer. */
export const NATIVE_RENDERER_ORIGIN = "chatto-app://app";

/** Operating-system deep-link scheme. */
export const NATIVE_DEEP_LINK_SCHEME = "chatto";

/**
 * Private IPC channel names shared by the main process and preload bridge.
 *
 * These names are not renderer capabilities by themselves. The preload exposes
 * only the typed methods in {@link ChattoNativeClient}, and the main process
 * validates both the sender and every argument.
 */
export const NativeIpc = {
  SetRegisteredServerOrigins: "chatto-native:servers:set-origins",
  AllowServerOriginProbe: "chatto-native:servers:allow-probe",
  SetTrayState: "chatto-native:tray:set-state",
  SetScreenShareLabels: "chatto-native:screen-share:set-labels",
  SetBadgeCount: "chatto-native:badge:set-count",
  FlashFrame: "chatto-native:window:flash-frame",
  ShowNotification: "chatto-native:notification:show",
  GetLaunchOnStartup: "chatto-native:startup:get",
  SetLaunchOnStartup: "chatto-native:startup:set",
  RegisterPushToTalk: "chatto-native:ptt:register",
  PrepareOAuthFlow: "chatto-native:oauth:prepare-flow",
  OpenExternalAuth: "chatto-native:oauth:open-external",
  CheckForUpdates: "chatto-native:update:check",
  GetUpdateState: "chatto-native:update:get-state",
  InstallUpdate: "chatto-native:update:install",
  TrayAction: "chatto-native:event:tray-action",
  NotificationAction: "chatto-native:event:notification-action",
  PushToTalk: "chatto-native:event:ptt",
  DeepLink: "chatto-native:event:deep-link",
  OAuthCallback: "chatto-native:event:oauth-callback",
  UpdateState: "chatto-native:event:update-state",
  RendererReady: "chatto-native:renderer:ready",
} as const;

export type NativePlatform = "darwin" | "linux" | "win32";

export type NativeTrayLabels = {
  open: string;
  mute: string;
  unmute: string;
  deafen: string;
  undeafen: string;
  quit: string;
};

export type NativeTrayState = {
  callActive: boolean;
  muted: boolean;
  deafened: boolean;
  unreadCount: number;
  labels: NativeTrayLabels;
};

export type NativeTrayAction = "open" | "toggle-mute" | "toggle-deafen";

/**
 * Localized strings for the shell-rendered screen-share picker.
 *
 * The picker is a hardened main-process window, so it cannot reach the
 * renderer's i18n runtime. The renderer pushes translated labels the same way
 * it pushes {@link NativeTrayLabels}; the shell keeps the latest set and falls
 * back to English if none has been provided yet.
 */
export type NativeScreenShareLabels = {
  title: string;
  subtitle: string;
  /** Shown when system audio will be captured (Windows). */
  audioShared: string;
  /** Shown when system audio was requested but is unavailable (non-Windows). */
  audioUnavailable: string;
  cancel: string;
};

export type NativeNotificationRequest = {
  id: string;
  title: string;
  body: string;
  canReply: boolean;
  replyPlaceholder: string;
};

export type NativeNotificationAction =
  | { type: "click"; id: string }
  | { type: "reply"; id: string; reply: string };

/** A physical-key binding understood by the native low-level keyboard hook. */
export type NativePushToTalkBinding = {
  key: string;
};

export type NativePushToTalkRegistration =
  | { registered: true }
  | {
      registered: false;
      reason: "unsupported-key" | "permission-denied" | "hook-failed";
    };

export type NativePushToTalkEvent = "pressed" | "released";

export type NativeDeepLink =
  | {
      kind: "join";
      serverUrl: string;
    }
  | {
      kind: "message";
      serverUrl: string;
      roomId: string;
      eventId: string | null;
      threadId: string | null;
    };

export type NativeOAuthCallback = {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
};

export type NativeOAuthCallbackLabels = {
  title: string;
  message: string;
};

export type NativeOAuthFlowRequest = {
  serverOrigin: string;
  callbackLabels: NativeOAuthCallbackLabels;
};

export type NativeUpdateState =
  | { kind: "idle" | "checking" | "not-available" }
  | { kind: "available" | "downloaded"; version: string }
  | { kind: "downloading"; percent: number }
  | { kind: "error" };

export type NativeUnsubscribe = () => void;

/**
 * The complete privileged API exposed to the bundled renderer.
 *
 * Keep this interface narrow. It intentionally has no generic IPC, filesystem,
 * process, command-execution, or arbitrary-navigation primitive.
 */
export interface ChattoNativeClient {
  readonly platform: NativePlatform;

  /** Signal that renderer event subscriptions are installed and queued links can be delivered. */
  rendererReady(): void;
  setRegisteredServerOrigins(origins: string[]): void;
  allowServerOriginForProbe(origin: string): void;
  setTrayState(state: NativeTrayState): void;
  /** Provide translated labels for the shell-rendered screen-share picker. */
  setScreenShareLabels(labels: NativeScreenShareLabels): void;
  /** Update the application badge with a localized accessibility description. */
  setBadgeCount(count: number, description: string): void;
  flashFrame(enabled: boolean): void;
  showNotification(request: NativeNotificationRequest): void;

  getLaunchOnStartup(): Promise<boolean>;
  setLaunchOnStartup(enabled: boolean): Promise<boolean>;

  registerPushToTalk(
    binding: NativePushToTalkBinding,
  ): Promise<NativePushToTalkRegistration>;

  prepareOAuthFlow(request: NativeOAuthFlowRequest): Promise<string>;
  openExternalAuth(url: string): Promise<void>;

  checkForUpdates(): Promise<void>;
  getUpdateState(): Promise<NativeUpdateState>;
  installUpdate(): void;

  onTrayAction(listener: (action: NativeTrayAction) => void): NativeUnsubscribe;
  onNotificationAction(
    listener: (action: NativeNotificationAction) => void,
  ): NativeUnsubscribe;
  onPushToTalk(
    listener: (event: NativePushToTalkEvent) => void,
  ): NativeUnsubscribe;
  onDeepLink(listener: (link: NativeDeepLink) => void): NativeUnsubscribe;
  onOAuthCallback(
    listener: (callback: NativeOAuthCallback) => void,
  ): NativeUnsubscribe;
  onUpdateState(
    listener: (state: NativeUpdateState) => void,
  ): NativeUnsubscribe;
}
