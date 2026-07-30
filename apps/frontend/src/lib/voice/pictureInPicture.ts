/**
 * Picture-in-Picture ("pop out") support for call video feeds.
 *
 * Popping a feed out of the app used to come for free from the host browser: Chrome offers
 * "Picture in picture" in its own context menu for any `<video>`. The bundled desktop client
 * renders the same frontend inside a WebView2 webview, which does not expose that menu, so
 * the only way to float a feed above other windows there is an explicit in-app control.
 *
 * Browsers use element-level Picture-in-Picture. The desktop host instead admits one exact
 * internal `window.open` sentinel and turns it into a normal, minimisable window. That window
 * receives the existing video's `MediaStream`; it does not create another LiveKit connection.
 *
 * Every entry point is feature-detected instead of assumed: Firefox and WebKit-based webviews
 * do not implement the API, and an embedder can disable it per document.
 */
import type { NativeHost } from '$lib/native/types';

const MANAGED_POP_OUT_URL = 'about:blank#chatto-video-pop-out';
const MANAGED_POP_OUT_NAME = 'chatto-video-pop-out';
const MANAGED_POP_OUT_FEATURES = 'popup=yes,width=640,height=360,resizable=yes';

/** The Picture-in-Picture members of `Document`, all optional so an unsupporting host is representable. */
export type PictureInPictureDocument = {
  pictureInPictureEnabled?: boolean;
  pictureInPictureElement?: Element | null;
  exitPictureInPicture?: () => Promise<void>;
};

/** The Picture-in-Picture members of `HTMLVideoElement`, all optional for the same reason. */
export type PictureInPictureVideo = {
  disablePictureInPicture?: boolean;
  requestPictureInPicture?: () => Promise<unknown>;
};

type VideoPopOutHost = Pick<NativeHost, 'capabilities'>;
type VideoPopOutOpener = Pick<Window, 'open'>;
type VideoTrackLike = Pick<MediaStreamTrack, 'addEventListener' | 'removeEventListener'>;
type MediaStreamLike = {
  getVideoTracks(): VideoTrackLike[];
};

type ManagedVideoPopOut = {
  kind: 'managed';
  owner: object;
  sourceVideo: HTMLVideoElement;
  popup: Window;
  popupVideo: HTMLVideoElement;
  track: VideoTrackLike;
  onPageHide: EventListener;
  onTrackEnded: EventListener;
};

type BrowserVideoPopOut = {
  kind: 'browser';
  owner: object;
  sourceVideo: HTMLVideoElement;
  document: PictureInPictureDocument;
  onLeave: EventListener;
};

type ActiveVideoPopOut = ManagedVideoPopOut | BrowserVideoPopOut;

let activeVideoPopOut: ActiveVideoPopOut | null = null;

/**
 * Whether this document can host a Picture-in-Picture window at all.
 *
 * Use it to decide whether to *offer* a pop-out control; a hidden control is much better
 * than one that always fails on platforms without the API.
 */
export function isPictureInPictureAvailable(doc: PictureInPictureDocument | null): boolean {
  return doc?.pictureInPictureEnabled === true;
}

/** Whether this host can offer either its managed pop-out or browser Picture-in-Picture. */
export function isVideoPopOutAvailable(
  host: VideoPopOutHost,
  doc: PictureInPictureDocument | null
): boolean {
  return host.capabilities.managedVideoPopOut || isPictureInPictureAvailable(doc);
}

/** Whether this specific video element can be popped out right now. */
export function canPopOutVideo(
  video: PictureInPictureVideo | null,
  doc: PictureInPictureDocument | null
): boolean {
  if (!video || !isPictureInPictureAvailable(doc)) return false;
  if (video.disablePictureInPicture === true) return false;

  return typeof video.requestPictureInPicture === 'function';
}

/** Outcome of a pop-out toggle, so callers can stay quiet on success and explain a failure. */
export type PictureInPictureToggleResult = 'entered' | 'exited' | 'unsupported' | 'failed';

/**
 * Pop `video` out into a Picture-in-Picture window, or put it back if it is already out.
 *
 * A single control toggles both directions because the browser's own PiP window can be
 * closed independently; asking again for a video that is already popped out should return
 * it rather than fail.
 *
 * **Must be called from a click handler, and nothing may be awaited before it.**
 * `requestPictureInPicture()` requires transient user activation, so every check here runs
 * synchronously and the request is the first `await` in this function. Adding an `await`
 * ahead of it — or calling this from a timer or a resolved promise — makes Chromium reject
 * with `NotAllowedError` on every platform.
 */
export async function togglePictureInPicture(
  video: PictureInPictureVideo | null,
  doc: PictureInPictureDocument | null
): Promise<PictureInPictureToggleResult> {
  if (!video || !doc) return 'unsupported';

  if (doc.pictureInPictureElement && (doc.pictureInPictureElement as unknown) === video) {
    if (typeof doc.exitPictureInPicture !== 'function') return 'unsupported';
    try {
      await doc.exitPictureInPicture();
      return 'exited';
    } catch {
      return 'failed';
    }
  }

  if (!canPopOutVideo(video, doc)) return 'unsupported';

  try {
    await video.requestPictureInPicture!();
    return 'entered';
  } catch {
    // Denied by permissions policy, or the element has no frames yet.
    return 'failed';
  }
}

function mediaStreamWithVideo(video: HTMLVideoElement): {
  stream: MediaStream;
  track: VideoTrackLike;
} | null {
  const stream = video.srcObject as (MediaStream & MediaStreamLike) | null;
  if (!stream || typeof stream.getVideoTracks !== 'function') return null;

  const track = stream.getVideoTracks()[0];
  return track ? { stream, track } : null;
}

function detachManagedPopOut(popOut: ManagedVideoPopOut, closeWindow: boolean): void {
  if (activeVideoPopOut === popOut) activeVideoPopOut = null;
  try {
    popOut.track.removeEventListener('ended', popOut.onTrackEnded);
  } catch {
    // Continue with the remaining best-effort cleanup.
  }
  try {
    popOut.popup.removeEventListener('pagehide', popOut.onPageHide);
  } catch {
    // Continue with the remaining best-effort cleanup.
  }
  try {
    popOut.popupVideo.srcObject = null;
  } catch {
    // Continue with closing the native window.
  }
  try {
    if (closeWindow && !popOut.popup.closed) popOut.popup.close();
  } catch {
    // Closing a call must not fail because its transient window is already unavailable.
  }
}

function detachBrowserPopOut(popOut: BrowserVideoPopOut, exit: boolean): void {
  popOut.sourceVideo.removeEventListener('leavepictureinpicture', popOut.onLeave);
  if (activeVideoPopOut === popOut) activeVideoPopOut = null;
  if (
    exit &&
    popOut.document.pictureInPictureElement === popOut.sourceVideo &&
    typeof popOut.document.exitPictureInPicture === 'function'
  ) {
    try {
      void popOut.document.exitPictureInPicture().catch(() => {});
    } catch {
      // The call teardown must continue even if the browser rejects PiP cleanup.
    }
  }
}

function closeActivePopOutRegardlessOfOwner(): void {
  const popOut = activeVideoPopOut;
  if (!popOut) return;
  if (popOut.kind === 'managed') detachManagedPopOut(popOut, true);
  else detachBrowserPopOut(popOut, true);
}

function replaceManagedVideo(
  popOut: ManagedVideoPopOut,
  video: HTMLVideoElement,
  owner: object,
  stream: MediaStream,
  track: VideoTrackLike
): void {
  popOut.track.removeEventListener('ended', popOut.onTrackEnded);
  popOut.owner = owner;
  popOut.sourceVideo = video;
  popOut.track = track;
  popOut.popupVideo.srcObject = stream;
  track.addEventListener('ended', popOut.onTrackEnded);
  try {
    void popOut.popupVideo.play().catch(() => {});
  } catch {
    // Autoplay remains enabled, so a later frame can still resume the reused window.
  }
}

function openManagedVideoPopOut(
  video: HTMLVideoElement,
  owner: object,
  opener: VideoPopOutOpener | null
): PictureInPictureToggleResult {
  if (!opener) return 'unsupported';

  const media = mediaStreamWithVideo(video);
  if (!media) return 'unsupported';

  const current = activeVideoPopOut;
  if (current?.kind === 'managed' && current.popup.closed) {
    detachManagedPopOut(current, false);
  } else if (current?.kind === 'managed' && current.sourceVideo === video) {
    detachManagedPopOut(current, true);
    return 'exited';
  } else if (current?.kind === 'managed') {
    replaceManagedVideo(current, video, owner, media.stream, media.track);
    return 'entered';
  } else if (current) {
    closeActivePopOutRegardlessOfOwner();
  }

  let popup: Window | null;
  try {
    popup = opener.open(MANAGED_POP_OUT_URL, MANAGED_POP_OUT_NAME, MANAGED_POP_OUT_FEATURES);
  } catch {
    return 'failed';
  }
  if (!popup) return 'failed';

  try {
    const popupVideo = popup.document.createElement('video');
    popup.document.title = 'Chatto video pop-out';
    popup.document.documentElement.style.cssText =
      'width:100%;height:100%;margin:0;background:#000;overflow:hidden';
    popup.document.body.style.cssText = 'width:100%;height:100%;margin:0;background:#000';
    popupVideo.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:#000';
    popupVideo.autoplay = true;
    popupVideo.playsInline = true;
    // Call audio continues through the main window, avoiding duplicated playback.
    popupVideo.muted = true;
    popupVideo.srcObject = media.stream;
    popup.document.body.replaceChildren(popupVideo);

    const onPageHide: EventListener = () => {
      if (activeVideoPopOut === popOut) detachManagedPopOut(popOut, false);
    };
    const onTrackEnded: EventListener = () => {
      if (activeVideoPopOut === popOut) detachManagedPopOut(popOut, true);
    };
    const popOut: ManagedVideoPopOut = {
      kind: 'managed',
      owner,
      sourceVideo: video,
      popup,
      popupVideo,
      track: media.track,
      onPageHide,
      onTrackEnded
    };
    popup.addEventListener('pagehide', onPageHide);
    media.track.addEventListener('ended', onTrackEnded);
    try {
      void popupVideo.play().catch(() => {});
    } catch {
      // Autoplay remains enabled; a synchronous play failure does not invalidate the window.
    }
    activeVideoPopOut = popOut;
    return 'entered';
  } catch {
    try {
      popup.close();
    } catch {
      // Nothing else to clean up when the host gave us an inaccessible window.
    }
    return 'failed';
  }
}

/**
 * Toggle the best pop-out surface available in this host.
 *
 * This must be invoked directly from a click handler: both `window.open()` and element
 * Picture-in-Picture require the click's transient user activation.
 */
export async function toggleVideoPopOut(
  video: HTMLVideoElement | null,
  owner: object,
  host: VideoPopOutHost,
  doc: PictureInPictureDocument | null,
  opener: VideoPopOutOpener | null
): Promise<PictureInPictureToggleResult> {
  if (host.capabilities.managedVideoPopOut) {
    return video ? openManagedVideoPopOut(video, owner, opener) : 'unsupported';
  }
  if (!video) return 'unsupported';

  const result = await togglePictureInPicture(video, doc);
  if (result === 'entered' && doc) {
    closeActivePopOutRegardlessOfOwner();
    const onLeave: EventListener = () => {
      if (activeVideoPopOut === popOut) detachBrowserPopOut(popOut, false);
    };
    const popOut: BrowserVideoPopOut = {
      kind: 'browser',
      owner,
      sourceVideo: video,
      document: doc,
      onLeave
    };
    video.addEventListener('leavepictureinpicture', onLeave);
    activeVideoPopOut = popOut;
  } else if (result === 'exited' && activeVideoPopOut?.kind === 'browser') {
    detachBrowserPopOut(activeVideoPopOut, false);
  }
  return result;
}

/**
 * Close the active video pop-out when it belongs to `owner`.
 *
 * Ownership prevents cleanup in one server-scoped call store from closing a pop-out that
 * belongs to a simultaneous store lifecycle elsewhere in the app.
 */
export function closeActiveVideoPopOut(owner: object): void {
  const popOut = activeVideoPopOut;
  if (!popOut || popOut.owner !== owner) return;
  if (popOut.kind === 'managed') detachManagedPopOut(popOut, true);
  else detachBrowserPopOut(popOut, true);
}
