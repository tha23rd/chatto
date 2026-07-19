import {
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { NativeScreenShareLabels } from "@chatto/native-bridge";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** A capture source offered to the user, with pre-rendered preview images. */
export type PickerSource = {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
};

/** Payload the picker preload requests once its document is ready. */
export type PickerData = {
  sources: PickerSource[];
  audioRequested: boolean;
  labels: NativeScreenShareLabels;
};

/**
 * Renders the screen/window chooser and resolves to the chosen source id, or
 * `null` when the user cancels. Abstracted so the display-media handler can be
 * unit-tested with a fake chooser instead of a real window.
 */
export interface ScreenSourcePicker {
  pick(
    parent: BrowserWindow,
    sources: PickerSource[],
    audioRequested: boolean,
    labels: NativeScreenShareLabels,
  ): Promise<string | null>;
}

const CHANNEL_SOURCES = "chatto-picker:sources";
const CHANNEL_CHOOSE = "chatto-picker:choose";
const CHANNEL_CANCEL = "chatto-picker:cancel";

// A script-less document: the sandboxed preload builds the whole UI in the DOM,
// so the page CSP needs to permit nothing but the data-URL preview images.
const PICKER_DOCUMENT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:"><title>Choose what to share</title></head><body></body></html>`;
const PICKER_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PICKER_DOCUMENT)}`;

/**
 * A main-process screen/window picker rendered in a hardened child window.
 *
 * The bundled renderer calls `navigator.mediaDevices.getDisplayMedia()` from the
 * ordinary web voice UI, exactly as on the web. On the web the browser draws its
 * own picker; Electron replaces that with our display-media handler, so the shell
 * supplies an equivalent picker here instead of shipping any picker UI in the
 * frontend. macOS uses the OS system picker (see {@link ScreenCaptureController});
 * this covers Windows and Linux.
 */
export class ScreenPicker implements ScreenSourcePicker {
  #active = false;

  pick(
    parent: BrowserWindow,
    sources: PickerSource[],
    audioRequested: boolean,
    labels: NativeScreenShareLabels,
  ): Promise<string | null> {
    // One chooser at a time; a display-media request is always user-initiated.
    if (this.#active || parent.isDestroyed() || sources.length === 0) {
      return Promise.resolve(null);
    }
    this.#active = true;

    const window = new BrowserWindow({
      parent,
      modal: true,
      show: false,
      width: 760,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      backgroundColor: "#1e1f22",
      webPreferences: {
        preload: path.join(moduleDirectory, "pickerPreload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    });

    const allowedIds = new Set(sources.map((source) => source.id));

    return new Promise<string | null>((resolve) => {
      let settled = false;

      const fromPicker = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
        !window.isDestroyed() && event.sender === window.webContents;

      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        ipcMain.removeHandler(CHANNEL_SOURCES);
        ipcMain.removeListener(CHANNEL_CHOOSE, onChoose);
        ipcMain.removeListener(CHANNEL_CANCEL, onCancel);
        this.#active = false;
        if (!window.isDestroyed()) window.close();
        resolve(value);
      };

      const onChoose = (event: IpcMainEvent, id: unknown): void => {
        if (!fromPicker(event)) return;
        finish(typeof id === "string" && allowedIds.has(id) ? id : null);
      };
      const onCancel = (event: IpcMainEvent): void => {
        if (fromPicker(event)) finish(null);
      };

      ipcMain.handle(CHANNEL_SOURCES, (event): PickerData | null =>
        fromPicker(event) ? { sources, audioRequested, labels } : null,
      );
      ipcMain.on(CHANNEL_CHOOSE, onChoose);
      ipcMain.on(CHANNEL_CANCEL, onCancel);

      window.once("ready-to-show", () => window.show());
      window.on("closed", () => finish(null));

      void window.loadURL(PICKER_URL).catch(() => finish(null));
    });
  }
}
