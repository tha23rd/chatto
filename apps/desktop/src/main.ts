import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  shell,
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  NATIVE_RENDERER_ORIGIN,
  NativeIpc,
  type NativeDeepLink,
  type NativeOAuthCallback,
  type NativeOAuthFlowRequest,
  type NativePushToTalkBinding,
} from "@chatto/native-bridge";
import {
  installRendererProtocol,
  registerPrivilegedRendererScheme,
} from "./appProtocol.js";
import { installCorsShim, RegisteredOriginPolicy } from "./corsShim.js";
import { deepLinkFromArgv, parseDeepLink } from "./deepLinks.js";
import { LastRouteStore } from "./lastRoute.js";
import { OAuthLoopbackReceiver } from "./oauthCallback.js";
import { PushToTalkController } from "./pushToTalk.js";
import { ScreenCaptureController } from "./screenCapture.js";
import {
  NativeNotificationController,
  setApplicationBadge,
  TrayController,
  validNotificationRequest,
  validTrayState,
} from "./shellFeatures.js";
import { DesktopUpdater } from "./updater.js";
import {
  boundedNonEmptyString,
  finiteInteger,
  isAllowedRendererPermission,
  isRendererUrl,
  isSafeExternalUrl,
  normalizeServerOrigin,
} from "./validation.js";

registerPrivilegedRendererScheme();
app.setName("Chatto");

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const MAX_PENDING_DEEP_LINKS = 32;
const rendererRoot = app.isPackaged
  ? path.join(process.resourcesPath, "renderer")
  : path.resolve(moduleDirectory, "../../frontend/build");
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.resolve(moduleDirectory, "../../frontend/static/icons/icon-512.png");

let mainWindow: BrowserWindow | null = null;
let tray: TrayController | null = null;
let notifications: NativeNotificationController | null = null;
let rendererReady = false;
let quitting = false;
const pendingDeepLinks: NativeDeepLink[] = [];
let pendingOAuthCallback: NativeOAuthCallback | null = null;
const originPolicy = new RegisteredOriginPolicy();
const screenCapture = new ScreenCaptureController();

let lastRouteStore: LastRouteStore | null = null;
function getLastRouteStore(): LastRouteStore {
  lastRouteStore ??= new LastRouteStore(
    path.join(app.getPath("userData"), "last-route.json"),
  );
  return lastRouteStore;
}

function sendToRenderer(channel: string, value: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, value);
}

const oauthReceiver = new OAuthLoopbackReceiver((callback) => {
  showMainWindow();
  if (rendererReady) sendToRenderer(NativeIpc.OAuthCallback, callback);
  else pendingOAuthCallback = callback;
});

const pushToTalk = new PushToTalkController(
  (event) => sendToRenderer(NativeIpc.PushToTalk, event),
  {
    hasPermission: () =>
      process.platform !== "darwin" ||
      systemPreferences.isTrustedAccessibilityClient(true),
  },
);

const updater = new DesktopUpdater((state) =>
  sendToRenderer(NativeIpc.UpdateState, state),
);

const launchDeepLink = deepLinkFromArgv(process.argv);
const launchDeepLinkArgument = process.argv.find(
  (argument) =>
    argument.startsWith("chatto:") && parseDeepLink(argument) !== null,
);
const hasSingleInstanceLock = app.requestSingleInstanceLock(
  launchDeepLinkArgument ? { deepLink: launchDeepLinkArgument } : {},
);
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  configureApplicationLifecycle();
}

function configureApplicationLifecycle(): void {
  app.on(
    "second-instance",
    (_event, argv, _workingDirectory, additionalData) => {
      showMainWindow();
      const dataLink = deepLinkFromSingleInstanceData(additionalData);
      const link = dataLink ?? deepLinkFromArgv(argv);
      if (link) deliverDeepLink(link);
    },
  );

  app.on("open-url", (event, url) => {
    event.preventDefault();
    const link = parseDeepLink(url);
    if (link) deliverDeepLink(link);
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("will-quit", () => {
    pushToTalk.dispose();
    notifications?.closeAll();
    tray?.destroy();
    tray = null;
    void oauthReceiver.close();
  });

  app.on("activate", showMainWindow);

  void app
    .whenReady()
    .then(initializeApplication)
    .catch(() => {
      console.error("The native client could not start.");
      app.quit();
    });
}

async function initializeApplication(): Promise<void> {
  if (process.platform === "win32") app.setAppUserModelId("org.chatto.desktop");
  registerDeepLinkHandler();
  Menu.setApplicationMenu(null);

  await installRendererProtocol(rendererRoot);
  installSessionSecurity();
  installCorsShim(session.defaultSession, originPolicy, () =>
    mainWindow
      ? {
          webContentsId: mainWindow.webContents.id,
          mainFrame: mainWindow.webContents.mainFrame,
        }
      : null,
  );
  screenCapture.install(session.defaultSession, () => mainWindow);
  registerIpcHandlers();
  createMainWindow();

  tray = new TrayController(
    iconPath,
    () => mainWindow,
    (action) => sendToRenderer(NativeIpc.TrayAction, action),
    () => {
      quitting = true;
      app.quit();
    },
  );
  notifications = new NativeNotificationController(
    iconPath,
    () => mainWindow,
    (action) => sendToRenderer(NativeIpc.NotificationAction, action),
  );

  if (launchDeepLink) deliverDeepLink(launchDeepLink);
  updater.start();
}

function registerDeepLinkHandler(): void {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("chatto");
    return;
  }
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient("chatto", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: "#313338",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      navigateOnDragDrop: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererReady = false;
  });

  const contents = mainWindow.webContents;
  // DevTools access. The application menu is nulled, so the default F12 /
  // Ctrl+Shift+I accelerators are gone; re-add them here so they work in every
  // build, packaged or not. The inspector stays closed until the user presses
  // the shortcut, so nothing ships open to end users, but anyone can open it to
  // diagnose issues (e.g. startup presence) without a special launch flag.
  // Re-add the standard reload (Ctrl/Cmd+R, F5) and DevTools (F12,
  // Ctrl/Cmd+Shift+I) accelerators. Reload lets a user capture startup traffic
  // (e.g. the first presence RPC and realtime WebSocket upgrade) with DevTools
  // already open, without relaunching the app.
  contents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const modifier = input.control || input.meta;
    const isReload =
      input.key === "F5" || (modifier && input.key.toLowerCase() === "r");
    const isDevTools =
      input.key === "F12" ||
      (modifier && input.shift && input.key.toLowerCase() === "i");
    if (isReload) contents.reloadIgnoringCache();
    else if (isDevTools) contents.toggleDevTools();
  });
  // Optional auto-open (docked, so it cannot open off-screen) for launches that
  // opt in via `--devtools` or CHATTO_DEVTOOLS=1, so state that exists from
  // launch — like the initial presence report — is visible without a reload.
  const devtoolsAutoOpen =
    process.env.CHATTO_DEVTOOLS === "1" || process.argv.includes("--devtools");
  if (devtoolsAutoOpen) {
    contents.once("did-finish-load", () => {
      if (!contents.isDevToolsOpened()) contents.openDevTools({ mode: "right" });
    });
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isRendererUrl(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url).catch(() => {});
  });
  contents.on("will-redirect", (event, url) => {
    if (isRendererUrl(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url).catch(() => {});
  });
  contents.on("context-menu", (_event, parameters) =>
    showSpellcheckMenu(contents, parameters),
  );
  contents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) rendererReady = false;
    },
  );
  // Remember the current in-app location so the next cold launch restores it
  // rather than resetting to `/` (which, with no origin server, would land on
  // the login/welcome screen). Covers full page loads and SvelteKit's
  // client-side navigations (did-navigate-in-page).
  const persistRoute = (): void => getLastRouteStore().save(contents.getURL());
  contents.on("did-navigate", persistRoute);
  contents.on("did-navigate-in-page", persistRoute);
  contents.on("render-process-gone", () => {
    rendererReady = false;
  });

  // Restore the last in-app location if there is one, mirroring how a browser
  // keeps its URL across restarts; otherwise start at the app root.
  void mainWindow.loadURL(
    getLastRouteStore().read() ?? `${NATIVE_RENDERER_ORIGIN}/`,
  );
}

function installSessionSecurity(): void {
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) =>
      webContents?.id === mainWindow?.webContents.id &&
      isRendererUrl(requestingOrigin) &&
      isAllowedRendererPermission(permission),
  );
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const allowed =
        webContents.id === mainWindow?.webContents.id &&
        isRendererUrl(details.requestingUrl) &&
        isAllowedRendererPermission(permission);
      callback(allowed);
    },
  );
  session.defaultSession.setDevicePermissionHandler(() => false);
}

function showSpellcheckMenu(
  contents: Electron.WebContents,
  parameters: Electron.ContextMenuParams,
): void {
  if (!parameters.isEditable && !parameters.misspelledWord) return;
  const template: Electron.MenuItemConstructorOptions[] = [];
  for (const suggestion of parameters.dictionarySuggestions.slice(0, 6)) {
    template.push({
      label: suggestion,
      click: () => contents.replaceMisspelling(suggestion),
    });
  }
  if (template.length > 0) template.push({ type: "separator" });
  template.push(
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "selectAll" },
  );
  Menu.buildFromTemplate(template).popup({ window: mainWindow ?? undefined });
}

function registerIpcHandlers(): void {
  ipcMain.on(NativeIpc.RendererReady, (event) => {
    if (!isTrustedSender(event)) return;
    rendererReady = true;
    for (const link of pendingDeepLinks.splice(0)) {
      sendToRenderer(NativeIpc.DeepLink, link);
    }
    if (pendingOAuthCallback) {
      sendToRenderer(NativeIpc.OAuthCallback, pendingOAuthCallback);
      pendingOAuthCallback = null;
    }
  });
  ipcMain.on(NativeIpc.SetRegisteredServerOrigins, (event, origins) => {
    event.returnValue =
      isTrustedSender(event) && originPolicy.setRegistered(origins);
  });
  ipcMain.on(NativeIpc.AllowServerOriginProbe, (event, origin) => {
    event.returnValue =
      isTrustedSender(event) && originPolicy.allowProbe(origin);
  });

  ipcMain.on(NativeIpc.SetTrayState, (event, state) => {
    if (isTrustedSender(event) && validTrayState(state)) tray?.setState(state);
  });
  ipcMain.on(NativeIpc.SetScreenShareLabels, (event, labels) => {
    // Per-field validation and English fallback happen in the controller.
    if (isTrustedSender(event)) screenCapture.setLabels(labels);
  });
  ipcMain.on(NativeIpc.SetBadgeCount, (event, count, description) => {
    if (!isTrustedSender(event)) return;
    const normalized = finiteInteger(count, 0, 9999);
    const normalizedDescription = boundedNonEmptyString(description, 128);
    if (normalized !== null && normalizedDescription !== null) {
      setApplicationBadge(mainWindow, normalized, normalizedDescription);
    }
  });
  ipcMain.on(NativeIpc.FlashFrame, (event, enabled) => {
    if (isTrustedSender(event) && typeof enabled === "boolean")
      mainWindow?.flashFrame(enabled);
  });
  ipcMain.on(NativeIpc.ShowNotification, (event, request) => {
    if (isTrustedSender(event) && validNotificationRequest(request))
      notifications?.show(request);
  });
  ipcMain.on(NativeIpc.InstallUpdate, (event) => {
    if (isTrustedSender(event)) updater.install();
  });

  handleIpc(NativeIpc.GetLaunchOnStartup, () =>
    process.platform === "linux"
      ? false
      : app.getLoginItemSettings().openAtLogin,
  );
  handleIpc(NativeIpc.SetLaunchOnStartup, (_event, enabled) => {
    if (typeof enabled !== "boolean" || process.platform === "linux")
      return false;
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin === enabled;
  });
  handleIpc(NativeIpc.RegisterPushToTalk, (_event, binding) => {
    if (!validPushToTalkBinding(binding)) {
      return { registered: false, reason: "unsupported-key" } as const;
    }
    return pushToTalk.register(binding);
  });
  handleIpc(NativeIpc.PrepareOAuthFlow, (_event, request) =>
    prepareOAuthFlow(request),
  );
  handleIpc(NativeIpc.OpenExternalAuth, async (_event, url) => {
    if (!isSafeExternalUrl(url))
      throw new TypeError("Invalid external authorization URL");
    const origin = new URL(url).origin;
    if (!originPolicy.isOAuthOrigin(origin))
      throw new TypeError("Authorization origin is not allowed");
    await shell.openExternal(url);
  });
  handleIpc(NativeIpc.CheckForUpdates, () => updater.check());
  handleIpc(NativeIpc.GetUpdateState, () => updater.state);
}

async function prepareOAuthFlow(value: unknown): Promise<string> {
  if (!validOAuthFlowRequest(value))
    throw new TypeError("Invalid native OAuth flow request");
  if (!originPolicy.allowOAuthFlow(value.serverOrigin)) {
    throw new TypeError("OAuth server origin is not allowed");
  }
  return oauthReceiver.prepare(value.callbackLabels);
}

function handleIpc<T extends unknown[], R>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: T) => R | Promise<R>,
): void {
  ipcMain.handle(channel, (event, ...args: T) => {
    if (!isTrustedSender(event))
      throw new Error("Untrusted native bridge sender");
    return handler(event, ...args);
  });
}

function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id)
    return false;
  const senderFrame = event.senderFrame;
  return (
    senderFrame === mainWindow.webContents.mainFrame &&
    isRendererUrl(senderFrame.url)
  );
}

function validPushToTalkBinding(
  value: unknown,
): value is NativePushToTalkBinding {
  if (!value || typeof value !== "object") return false;
  return (
    boundedNonEmptyString((value as Record<string, unknown>).key, 64) !== null
  );
}

function validOAuthFlowRequest(
  value: unknown,
): value is NativeOAuthFlowRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!normalizeServerOrigin(record.serverOrigin)) return false;
  if (!record.callbackLabels || typeof record.callbackLabels !== "object")
    return false;
  const labels = record.callbackLabels as Record<string, unknown>;
  return (
    boundedNonEmptyString(labels.title, 256) !== null &&
    boundedNonEmptyString(labels.message, 1000) !== null
  );
}

function deliverDeepLink(link: NativeDeepLink): void {
  showMainWindow();
  if (!rendererReady) {
    if (pendingDeepLinks.length >= MAX_PENDING_DEEP_LINKS)
      pendingDeepLinks.shift();
    pendingDeepLinks.push(link);
    return;
  }
  sendToRenderer(NativeIpc.DeepLink, link);
}

function deepLinkFromSingleInstanceData(value: unknown): NativeDeepLink | null {
  if (!value || typeof value !== "object") return null;
  const rawLink = (value as Record<string, unknown>).deepLink;
  return typeof rawLink === "string" ? parseDeepLink(rawLink) : null;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
