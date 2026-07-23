/**
 * Picture-in-Picture ("pop out") support for call video feeds.
 *
 * Popping a feed out of the app used to come for free from the host browser: Chrome offers
 * "Picture in picture" in its own context menu for any `<video>`. The bundled desktop client
 * renders the same frontend inside a WebView2 webview, which does not expose that menu, so
 * the only way to float a feed above other windows there is an explicit in-app control.
 *
 * Element-level Picture-in-Picture is deliberate: the PiP surface is created inside the
 * content layer, so it does not go through the desktop shell's `on_new_window` handler (which
 * denies every new window on purpose — see `apps/desktop/src-tauri/src/shell.rs`). A
 * `window.open`-based pop-out, or Document Picture-in-Picture, would be denied there.
 *
 * Every entry point is feature-detected instead of assumed: Firefox and WebKit-based webviews
 * do not implement the API, and an embedder can disable it per document.
 */

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

/**
 * Whether this document can host a Picture-in-Picture window at all.
 *
 * Use it to decide whether to *offer* a pop-out control; a hidden control is much better
 * than one that always fails on platforms without the API.
 */
export function isPictureInPictureAvailable(doc: PictureInPictureDocument | null): boolean {
  return doc?.pictureInPictureEnabled === true;
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
