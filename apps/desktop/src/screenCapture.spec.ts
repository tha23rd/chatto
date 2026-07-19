import {
  desktopCapturer,
  type BrowserWindow,
  type DesktopCapturerSource,
  type Session,
  type WebFrameMain,
} from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCREEN_SHARE_LABELS,
  ScreenCaptureController,
  normalizeScreenShareLabels,
} from "./screenCapture.js";
import type { ScreenSourcePicker } from "./screenPicker.js";

describe("normalizeScreenShareLabels", () => {
  it("passes through a complete, valid label set", () => {
    const labels = {
      title: "Titre",
      subtitle: "Sous-titre",
      audioShared: "Audio partagé",
      audioUnavailable: "Audio indisponible",
      cancel: "Annuler",
    };
    expect(normalizeScreenShareLabels(labels)).toEqual(labels);
  });

  it("falls back to English per-field for missing or invalid values", () => {
    const result = normalizeScreenShareLabels({
      title: "Titre",
      subtitle: "",
      audioShared: 42,
      cancel: "x".repeat(1000),
    });
    expect(result.title).toBe("Titre");
    expect(result.subtitle).toBe(DEFAULT_SCREEN_SHARE_LABELS.subtitle);
    expect(result.audioShared).toBe(DEFAULT_SCREEN_SHARE_LABELS.audioShared);
    expect(result.audioUnavailable).toBe(
      DEFAULT_SCREEN_SHARE_LABELS.audioUnavailable,
    );
    expect(result.cancel).toBe(DEFAULT_SCREEN_SHARE_LABELS.cancel);
  });

  it("returns all English defaults for non-object input", () => {
    expect(normalizeScreenShareLabels(null)).toEqual(DEFAULT_SCREEN_SHARE_LABELS);
    expect(normalizeScreenShareLabels(undefined)).toEqual(
      DEFAULT_SCREEN_SHARE_LABELS,
    );
  });
});

describe("display-media request handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("enables the OS system picker only on macOS", () => {
    withPlatform("darwin", () => {
      expect(installedController().opts?.useSystemPicker).toBe(true);
    });
    withPlatform("linux", () => {
      expect(installedController().opts).toBeUndefined();
    });
    withPlatform("win32", () => {
      expect(installedController().opts).toBeUndefined();
    });
  });

  it("never invokes the one-time callback twice when the picker path throws", async () => {
    vi.spyOn(desktopCapturer, "getSources").mockResolvedValue([fakeSource()]);
    const { request, trustedFrame, picker } = installedController();
    // A picker that resolves a choice but whose downstream callback throws must
    // not cascade into a second callback via the error path.
    picker.pick.mockResolvedValue("window:123:0");
    const callback = vi.fn().mockImplementationOnce(() => {
      throw new Error("callback already consumed");
    });
    request(
      { frame: trustedFrame, userGesture: true, audioRequested: false },
      callback,
    );
    await settle();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("denies a request from an untrusted frame without opening the picker", async () => {
    vi.spyOn(desktopCapturer, "getSources").mockResolvedValue([fakeSource()]);
    const { request, picker } = installedController();

    const callback = vi.fn();
    request(
      {
        frame: { url: "chatto-app://app/" } as WebFrameMain,
        userGesture: true,
        audioRequested: false,
      },
      callback,
    );
    await settle();
    expect(callback).toHaveBeenCalledWith({});
    expect(picker.pick).not.toHaveBeenCalled();
  });

  it("denies a request without a user gesture", async () => {
    vi.spyOn(desktopCapturer, "getSources").mockResolvedValue([fakeSource()]);
    const { request, trustedFrame, picker } = installedController();

    const callback = vi.fn();
    request(
      { frame: trustedFrame, userGesture: false, audioRequested: false },
      callback,
    );
    await settle();
    expect(callback).toHaveBeenCalledWith({});
    expect(picker.pick).not.toHaveBeenCalled();
  });

  it("denies when no sources are available", async () => {
    vi.spyOn(desktopCapturer, "getSources").mockResolvedValue([]);
    const { request, trustedFrame, picker } = installedController();

    const callback = vi.fn();
    request(
      { frame: trustedFrame, userGesture: true, audioRequested: false },
      callback,
    );
    await settle();
    expect(callback).toHaveBeenCalledWith({});
    expect(picker.pick).not.toHaveBeenCalled();
  });

  it("grants the source the user picks from the trusted frame", async () => {
    const source = fakeSource();
    vi.spyOn(desktopCapturer, "getSources").mockResolvedValue([source]);
    const { request, trustedFrame, picker } = installedController(source.id);

    const callback = vi.fn();
    request(
      { frame: trustedFrame, userGesture: true, audioRequested: false },
      callback,
    );
    await settle();
    expect(picker.pick).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ video: source, audio: undefined });
  });

  it("forwards renderer-supplied labels to the picker", async () => {
    const source = fakeSource();
    vi.spyOn(desktopCapturer, "getSources").mockResolvedValue([source]);
    const { request, trustedFrame, picker, controller } = installedController(
      source.id,
    );
    controller.setLabels({
      title: "Que partager ?",
      subtitle: "Sélectionnez un écran.",
      audioShared: "Audio partagé",
      audioUnavailable: "Audio indisponible",
      cancel: "Annuler",
    });

    request(
      { frame: trustedFrame, userGesture: true, audioRequested: false },
      vi.fn(),
    );
    await settle();
    expect(picker.pick).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      false,
      expect.objectContaining({ title: "Que partager ?", cancel: "Annuler" }),
    );
  });

  it("denies when the user cancels the picker", async () => {
    const source = fakeSource();
    vi.spyOn(desktopCapturer, "getSources").mockResolvedValue([source]);
    const { request, trustedFrame, picker } = installedController(null);

    const callback = vi.fn();
    request(
      { frame: trustedFrame, userGesture: true, audioRequested: true },
      callback,
    );
    await settle();
    expect(picker.pick).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({});
  });

  it("grants system loopback audio for a Windows audio share", async () => {
    const source = fakeSource();
    vi.spyOn(desktopCapturer, "getSources").mockResolvedValue([source]);
    const { request, trustedFrame, picker } = installedController(source.id);
    const originalPlatform = process.platform;

    try {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });
      const callback = vi.fn();
      request(
        { frame: trustedFrame, userGesture: true, audioRequested: true },
        callback,
      );
      await settle();
      expect(picker.pick).toHaveBeenCalledWith(
        expect.anything(),
        [expect.objectContaining({ id: source.id })],
        true,
        expect.objectContaining({ title: expect.any(String) }),
      );
      expect(callback).toHaveBeenCalledWith({
        video: source,
        audio: "loopback",
      });
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("fails closed when source enumeration rejects", async () => {
    vi.spyOn(desktopCapturer, "getSources").mockRejectedValue(
      new Error("capture unavailable"),
    );
    const { request, trustedFrame } = installedController();

    const callback = vi.fn();
    request(
      { frame: trustedFrame, userGesture: true, audioRequested: false },
      callback,
    );
    await settle();
    expect(callback).toHaveBeenCalledWith({});
  });
});

type DisplayRequest = Electron.DisplayMediaRequestHandlerHandlerRequest;
type DisplayCallback = (streams: Electron.Streams) => void;

function installedController(chosenId: string | null = null): {
  request: (request: DisplayRequest, callback: DisplayCallback) => void;
  trustedFrame: WebFrameMain;
  opts: Electron.DisplayMediaRequestHandlerOpts | undefined;
  picker: { pick: ReturnType<typeof vi.fn> };
  controller: ScreenCaptureController;
} {
  let requestHandler:
    | ((request: DisplayRequest, callback: DisplayCallback) => void)
    | null = null;
  let capturedOpts: Electron.DisplayMediaRequestHandlerOpts | undefined;
  const session = {
    setDisplayMediaRequestHandler(
      handler: (request: DisplayRequest, callback: DisplayCallback) => void,
      opts?: Electron.DisplayMediaRequestHandlerOpts,
    ) {
      requestHandler = handler;
      capturedOpts = opts;
    },
  } as unknown as Session;

  const trustedFrame = { url: "chatto-app://app/" } as WebFrameMain;
  const parent = {
    isDestroyed: () => false,
    webContents: { mainFrame: trustedFrame },
  } as unknown as BrowserWindow;

  const picker = { pick: vi.fn().mockResolvedValue(chosenId) };
  const controller = new ScreenCaptureController(
    picker as unknown as ScreenSourcePicker,
  );
  controller.install(session, () => parent);
  if (!requestHandler)
    throw new Error("display-media handler was not installed");
  return {
    request: requestHandler,
    trustedFrame,
    opts: capturedOpts,
    picker,
    controller,
  };
}

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: original,
    });
  }
}

function fakeSource(): DesktopCapturerSource {
  return {
    id: "window:123:0",
    name: "Window",
    display_id: "1",
    thumbnail: { toDataURL: () => "data:image/png;base64,thumb" },
    appIcon: null,
  } as unknown as DesktopCapturerSource;
}

// Exhaust the microtask queue so the async handler resolves before assertions.
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
