import { app } from "electron";
import electronUpdater from "electron-updater";
import type { NativeUpdateState } from "@chatto/native-bridge";

// electron-updater is CommonJS. Use its default namespace so Electron's ESM
// loader does not rely on synthetic named exports at runtime.
const { autoUpdater } = electronUpdater;

/** Whole-application update coordinator for packaged builds. */
export class DesktopUpdater {
  #emit: (state: NativeUpdateState) => void;
  #started = false;
  #downloaded = false;
  #state: NativeUpdateState = { kind: "idle" };

  constructor(emit: (state: NativeUpdateState) => void) {
    this.#emit = emit;
  }

  start(): void {
    if (this.#started || !app.isPackaged) return;
    this.#started = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () =>
      this.#setState({ kind: "checking" }),
    );
    autoUpdater.on("update-available", (info) =>
      this.#setState({ kind: "available", version: info.version }),
    );
    autoUpdater.on("update-not-available", () =>
      this.#setState({ kind: "not-available" }),
    );
    autoUpdater.on("download-progress", (progress) =>
      this.#setState({
        kind: "downloading",
        percent: Math.max(0, Math.min(100, progress.percent)),
      }),
    );
    autoUpdater.on("update-downloaded", (info) => {
      this.#downloaded = true;
      this.#setState({ kind: "downloaded", version: info.version });
    });
    autoUpdater.on("error", () => this.#setState({ kind: "error" }));

    void this.check();
  }

  async check(): Promise<void> {
    if (!app.isPackaged) {
      this.#setState({ kind: "not-available" });
      return;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      this.#setState({ kind: "error" });
    }
  }

  install(): void {
    if (this.#downloaded) autoUpdater.quitAndInstall(false, true);
  }

  get state(): NativeUpdateState {
    return this.#state;
  }

  #setState(state: NativeUpdateState): void {
    this.#state = state;
    this.#emit(state);
  }
}
