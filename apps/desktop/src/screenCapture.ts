import {
  desktopCapturer,
  type DesktopCapturerSource,
  type BrowserWindow,
  type Session,
} from "electron";
import type { NativeScreenShareLabels } from "@chatto/native-bridge";
import { isRendererUrl } from "./validation.js";
import {
  ScreenPicker,
  type PickerSource,
  type ScreenSourcePicker,
} from "./screenPicker.js";

const MAX_LABEL_LENGTH = 200;

/**
 * English fallback labels. Used until the renderer pushes translated labels via
 * {@link ScreenCaptureController.setLabels}, and per-field whenever a pushed
 * value is missing or invalid, so the picker is never blank.
 */
export const DEFAULT_SCREEN_SHARE_LABELS: NativeScreenShareLabels = {
  title: "Choose what to share",
  subtitle: "Select a screen or application window to share.",
  audioShared: "System audio will be shared along with the screen.",
  audioUnavailable: "System audio sharing is available on Windows only.",
  cancel: "Cancel",
};

function boundedLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LABEL_LENGTH
    ? value
    : fallback;
}

/** Validate renderer-supplied labels, falling back field-by-field to English. */
export function normalizeScreenShareLabels(
  value: unknown,
): NativeScreenShareLabels {
  const input = (value ?? {}) as Partial<NativeScreenShareLabels>;
  return {
    title: boundedLabel(input.title, DEFAULT_SCREEN_SHARE_LABELS.title),
    subtitle: boundedLabel(input.subtitle, DEFAULT_SCREEN_SHARE_LABELS.subtitle),
    audioShared: boundedLabel(
      input.audioShared,
      DEFAULT_SCREEN_SHARE_LABELS.audioShared,
    ),
    audioUnavailable: boundedLabel(
      input.audioUnavailable,
      DEFAULT_SCREEN_SHARE_LABELS.audioUnavailable,
    ),
    cancel: boundedLabel(input.cancel, DEFAULT_SCREEN_SHARE_LABELS.cancel),
  };
}

/**
 * Display-media authorization for the bundled renderer.
 *
 * The renderer calls `navigator.mediaDevices.getDisplayMedia()` from the ordinary
 * web voice UI — the shell adds no screen-share UI to the frontend. macOS defers
 * to the OS system picker (`useSystemPicker`), so this handler is not invoked
 * there. On Windows and Linux Electron has no system picker, so the handler
 * enumerates sources and shows the shell's own chooser (see {@link ScreenPicker}).
 *
 * The audio intent already rides on `getDisplayMedia`'s constraints, surfaced as
 * `request.audioRequested`; no separate frontend signal is needed. System audio
 * loopback is offered only on Windows, where Electron supports it.
 */
export class ScreenCaptureController {
  readonly #picker: ScreenSourcePicker;
  #labels: NativeScreenShareLabels = DEFAULT_SCREEN_SHARE_LABELS;

  constructor(picker: ScreenSourcePicker = new ScreenPicker()) {
    this.#picker = picker;
  }

  /** Store the latest translated picker labels pushed by the renderer. */
  setLabels(labels: unknown): void {
    this.#labels = normalizeScreenShareLabels(labels);
  }

  install(session: Session, getParentWindow: () => BrowserWindow | null): void {
    // `useSystemPicker` is macOS-only in Electron 43. Passing it elsewhere is at
    // best a no-op, and on Linux it has been observed to let Electron resolve the
    // request itself, so our handler then double-invokes the one-time callback.
    // Only enable it where the OS picker actually exists.
    const opts =
      process.platform === "darwin" ? { useSystemPicker: true } : undefined;
    session.setDisplayMediaRequestHandler((request, callback) => {
      // The Electron callback must fire exactly once. Guard every path (early
      // return, picker result, thrown error) so it can never be called twice.
      let settled = false;
      const respond = (streams: Electron.Streams): void => {
        if (settled) return;
        settled = true;
        callback(streams);
      };
      void this.#handleRequest(request, respond, getParentWindow).catch(() =>
        respond({}),
      );
    }, opts);
  }

  async #handleRequest(
    request: Electron.DisplayMediaRequestHandlerHandlerRequest,
    callback: (streams: Electron.Streams) => void,
    getParentWindow: () => BrowserWindow | null,
  ): Promise<void> {
    const parent = getParentWindow();
    const trustedFrame = parent?.webContents.mainFrame ?? null;
    if (
      !parent ||
      !trustedFrame ||
      !request.frame ||
      request.frame !== trustedFrame ||
      !isRendererUrl(request.frame.url) ||
      request.userGesture !== true
    ) {
      callback({});
      return;
    }

    const sources = await this.#getSources();
    if (sources.length === 0) {
      callback({});
      return;
    }

    const chosenId = await this.#picker.pick(
      parent,
      sources.map(toPickerSource),
      request.audioRequested === true,
      this.#labels,
    );
    const source = chosenId
      ? sources.find((candidate) => candidate.id === chosenId)
      : undefined;
    if (!source) {
      callback({});
      return;
    }

    callback({
      video: source,
      audio:
        request.audioRequested && process.platform === "win32"
          ? "loopback"
          : undefined,
    });
  }

  #getSources(): Promise<DesktopCapturerSource[]> {
    return desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
  }
}

export function toPickerSource(source: DesktopCapturerSource): PickerSource {
  return {
    id: source.id,
    name: source.name.slice(0, 256),
    thumbnailDataUrl: source.thumbnail.toDataURL(),
    appIconDataUrl:
      source.appIcon && !source.appIcon.isEmpty()
        ? source.appIcon.toDataURL()
        : null,
  };
}
