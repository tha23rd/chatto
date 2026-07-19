import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type NativeImage,
} from "electron";
import type {
  NativeNotificationAction,
  NativeNotificationRequest,
  NativeTrayAction,
  NativeTrayState,
} from "@chatto/native-bridge";
import {
  boundedNonEmptyString,
  boundedString,
  finiteInteger,
} from "./validation.js";

export class TrayController {
  #tray: Tray;
  #window: () => BrowserWindow | null;
  #emit: (action: NativeTrayAction) => void;
  #requestQuit: () => void;

  constructor(
    iconPath: string,
    window: () => BrowserWindow | null,
    emit: (action: NativeTrayAction) => void,
    requestQuit: () => void,
  ) {
    this.#window = window;
    this.#emit = emit;
    this.#requestQuit = requestQuit;
    this.#tray = new Tray(iconPath);
    this.#tray.setToolTip("Chatto");
    this.#tray.on("click", () => this.showWindow());
  }

  setState(state: NativeTrayState): void {
    const labels = state.labels;
    this.#tray.setToolTip(
      state.unreadCount > 0 ? `Chatto (${state.unreadCount})` : "Chatto",
    );
    this.#tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: labels.open,
          click: () => {
            this.showWindow();
            this.#emit("open");
          },
        },
        { type: "separator" },
        {
          label: state.muted ? labels.unmute : labels.mute,
          enabled: state.callActive,
          click: () => this.#emit("toggle-mute"),
        },
        {
          label: state.deafened ? labels.undeafen : labels.deafen,
          enabled: state.callActive,
          click: () => this.#emit("toggle-deafen"),
        },
        { type: "separator" },
        { label: labels.quit, click: this.#requestQuit },
      ]),
    );
  }

  showWindow(): void {
    const window = this.#window();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  destroy(): void {
    this.#tray.destroy();
  }
}

export class NativeNotificationController {
  #window: () => BrowserWindow | null;
  #emit: (action: NativeNotificationAction) => void;
  #iconPath: string;
  #notifications = new Map<string, Notification>();

  constructor(
    iconPath: string,
    window: () => BrowserWindow | null,
    emit: (action: NativeNotificationAction) => void,
  ) {
    this.#iconPath = iconPath;
    this.#window = window;
    this.#emit = emit;
  }

  show(request: NativeNotificationRequest): void {
    if (!Notification.isSupported()) return;
    this.#notifications.get(request.id)?.close();

    const notification = new Notification({
      title: request.title,
      body: request.body,
      icon: this.#iconPath,
      hasReply: request.canReply,
      replyPlaceholder: request.replyPlaceholder,
      timeoutType: "default",
    });
    notification.on("click", () => {
      this.#focusWindow();
      this.#emit({ type: "click", id: request.id });
    });
    notification.on("reply", (_event, reply) => {
      this.#focusWindow();
      this.#emit({
        type: "reply",
        id: request.id,
        reply: reply.slice(0, 4000),
      });
    });
    notification.on("close", () => {
      if (this.#notifications.get(request.id) === notification) {
        this.#notifications.delete(request.id);
      }
    });
    this.#notifications.set(request.id, notification);
    notification.show();
  }

  closeAll(): void {
    for (const notification of this.#notifications.values())
      notification.close();
    this.#notifications.clear();
  }

  #focusWindow(): void {
    const window = this.#window();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

export function setApplicationBadge(
  window: BrowserWindow | null,
  count: number,
  description: string,
): void {
  const normalized = Math.max(0, Math.min(9999, Math.floor(count)));
  if (process.platform === "win32") {
    window?.setOverlayIcon(
      normalized > 0 ? unreadOverlayIcon() : null,
      normalized > 0 ? `${normalized} ${description}` : "",
    );
    return;
  }
  app.setBadgeCount(normalized);
}

export function validTrayState(value: unknown): value is NativeTrayState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.callActive !== "boolean" ||
    typeof record.muted !== "boolean" ||
    typeof record.deafened !== "boolean"
  )
    return false;
  if (finiteInteger(record.unreadCount, 0, 9999) === null) return false;
  if (!record.labels || typeof record.labels !== "object") return false;
  const labels = record.labels as Record<string, unknown>;
  return ["open", "mute", "unmute", "deafen", "undeafen", "quit"].every(
    (name) => boundedNonEmptyString(labels[name], 128) !== null,
  );
}

export function validNotificationRequest(
  value: unknown,
): value is NativeNotificationRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    boundedNonEmptyString(record.id, 256) !== null &&
    boundedNonEmptyString(record.title, 256) !== null &&
    boundedString(record.body, 4000) !== null &&
    typeof record.canReply === "boolean" &&
    boundedString(record.replyPlaceholder, 256) !== null
  );
}

let cachedOverlayIcon: NativeImage | null = null;

function unreadOverlayIcon(): NativeImage {
  cachedOverlayIcon ??= nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="13" fill="#e5484d" stroke="#ffffff" stroke-width="4"/></svg>',
    ).toString("base64")}`,
  );
  return cachedOverlayIcon;
}
