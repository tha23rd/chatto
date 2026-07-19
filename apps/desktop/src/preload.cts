const { contextBridge, ipcRenderer } =
  require("electron") as typeof import("electron");
type ChattoNativeClient = import("@chatto/native-bridge").ChattoNativeClient;
type NativeDeepLink = import("@chatto/native-bridge").NativeDeepLink;
type NativeNotificationAction =
  import("@chatto/native-bridge").NativeNotificationAction;
type NativeOAuthCallback = import("@chatto/native-bridge").NativeOAuthCallback;
type NativePushToTalkEvent =
  import("@chatto/native-bridge").NativePushToTalkEvent;
type NativeTrayAction = import("@chatto/native-bridge").NativeTrayAction;
type NativeUpdateState = import("@chatto/native-bridge").NativeUpdateState;

// Sandboxed preloads cannot load arbitrary local modules. Keep this exact list
// beside the exposed methods and verify parity in the Electron smoke test.
const channel = {
  setRegisteredServerOrigins: "chatto-native:servers:set-origins",
  allowServerOriginProbe: "chatto-native:servers:allow-probe",
  setTrayState: "chatto-native:tray:set-state",
  setScreenShareLabels: "chatto-native:screen-share:set-labels",
  setBadgeCount: "chatto-native:badge:set-count",
  flashFrame: "chatto-native:window:flash-frame",
  showNotification: "chatto-native:notification:show",
  getLaunchOnStartup: "chatto-native:startup:get",
  setLaunchOnStartup: "chatto-native:startup:set",
  registerPushToTalk: "chatto-native:ptt:register",
  prepareOAuthFlow: "chatto-native:oauth:prepare-flow",
  openExternalAuth: "chatto-native:oauth:open-external",
  checkForUpdates: "chatto-native:update:check",
  getUpdateState: "chatto-native:update:get-state",
  installUpdate: "chatto-native:update:install",
  trayAction: "chatto-native:event:tray-action",
  notificationAction: "chatto-native:event:notification-action",
  pushToTalk: "chatto-native:event:ptt",
  deepLink: "chatto-native:event:deep-link",
  oauthCallback: "chatto-native:event:oauth-callback",
  updateState: "chatto-native:event:update-state",
  rendererReady: "chatto-native:renderer:ready",
} as const;

function sendSyncChecked(name: string, value: unknown): void {
  if (ipcRenderer.sendSync(name, value) !== true) {
    throw new TypeError(
      "The native client rejected a security-sensitive bridge update.",
    );
  }
}

function subscribe<T>(name: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T): void =>
    listener(value);
  ipcRenderer.on(name, handler);
  return () => ipcRenderer.removeListener(name, handler);
}

const nativeClient: ChattoNativeClient = {
  platform: process.platform as ChattoNativeClient["platform"],

  rendererReady() {
    ipcRenderer.send(channel.rendererReady);
  },
  setRegisteredServerOrigins(origins) {
    sendSyncChecked(channel.setRegisteredServerOrigins, origins);
  },
  allowServerOriginForProbe(origin) {
    sendSyncChecked(channel.allowServerOriginProbe, origin);
  },
  setTrayState(state) {
    ipcRenderer.send(channel.setTrayState, state);
  },
  setScreenShareLabels(labels) {
    ipcRenderer.send(channel.setScreenShareLabels, labels);
  },
  setBadgeCount(count, description) {
    ipcRenderer.send(channel.setBadgeCount, count, description);
  },
  flashFrame(enabled) {
    ipcRenderer.send(channel.flashFrame, enabled);
  },
  showNotification(request) {
    ipcRenderer.send(channel.showNotification, request);
  },

  getLaunchOnStartup() {
    return ipcRenderer.invoke(channel.getLaunchOnStartup);
  },
  setLaunchOnStartup(enabled) {
    return ipcRenderer.invoke(channel.setLaunchOnStartup, enabled);
  },
  registerPushToTalk(binding) {
    return ipcRenderer.invoke(channel.registerPushToTalk, binding);
  },
  prepareOAuthFlow(request) {
    return ipcRenderer.invoke(channel.prepareOAuthFlow, request);
  },
  openExternalAuth(url) {
    return ipcRenderer.invoke(channel.openExternalAuth, url);
  },

  checkForUpdates() {
    return ipcRenderer.invoke(channel.checkForUpdates);
  },
  getUpdateState() {
    return ipcRenderer.invoke(channel.getUpdateState);
  },
  installUpdate() {
    ipcRenderer.send(channel.installUpdate);
  },

  onTrayAction(listener) {
    return subscribe<NativeTrayAction>(channel.trayAction, listener);
  },
  onNotificationAction(listener) {
    return subscribe<NativeNotificationAction>(
      channel.notificationAction,
      listener,
    );
  },
  onPushToTalk(listener) {
    return subscribe<NativePushToTalkEvent>(channel.pushToTalk, listener);
  },
  onDeepLink(listener) {
    return subscribe<NativeDeepLink>(channel.deepLink, listener);
  },
  onOAuthCallback(listener) {
    return subscribe<NativeOAuthCallback>(channel.oauthCallback, listener);
  },
  onUpdateState(listener) {
    return subscribe<NativeUpdateState>(channel.updateState, listener);
  },
};

contextBridge.exposeInMainWorld("chattoNative", Object.freeze(nativeClient));
