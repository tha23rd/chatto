import { describe, expect, it, vi } from 'vitest';
import {
  canPopOutVideo,
  closeActiveVideoPopOut,
  isPictureInPictureAvailable,
  isVideoPopOutAvailable,
  togglePictureInPicture,
  toggleVideoPopOut,
  type PictureInPictureDocument,
  type PictureInPictureVideo
} from './pictureInPicture';
import { browserNativeHost } from '$lib/native/browserHost';
import type { NativeHost } from '$lib/native/types';

function supportingDocument(
  overrides: Partial<PictureInPictureDocument> = {}
): PictureInPictureDocument {
  return {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    exitPictureInPicture: vi.fn(async () => {}),
    ...overrides
  };
}

function supportingVideo(overrides: Partial<PictureInPictureVideo> = {}): PictureInPictureVideo {
  return {
    disablePictureInPicture: false,
    requestPictureInPicture: vi.fn(async () => ({})),
    ...overrides
  };
}

function nativeVideoPopOutHost(): Pick<NativeHost, 'capabilities'> {
  return {
    capabilities: {
      ...browserNativeHost.capabilities,
      managedVideoPopOut: true
    }
  };
}

function managedVideoFixture() {
  const trackListeners = new Map<string, EventListener>();
  const track = {
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      trackListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => {
      trackListeners.delete(name);
    })
  };
  const stream = {
    getVideoTracks: () => [track]
  };
  const sourceVideo = { srcObject: stream } as unknown as HTMLVideoElement;
  const popupVideo = {
    autoplay: false,
    muted: false,
    playsInline: false,
    srcObject: null,
    style: { cssText: '' },
    play: vi.fn(async () => {})
  };
  const popupListeners = new Map<string, EventListener>();
  const popup = {
    closed: false,
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
    document: {
      title: '',
      documentElement: { style: { cssText: '' } },
      body: {
        style: { cssText: '' },
        replaceChildren: vi.fn()
      },
      createElement: vi.fn(() => popupVideo)
    },
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      popupListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => {
      popupListeners.delete(name);
    })
  };
  const opener = {
    open: vi.fn<Window['open']>(() => popup as unknown as Window)
  };

  return {
    opener,
    popup,
    popupListeners,
    popupVideo,
    sourceVideo,
    stream,
    track,
    trackListeners
  };
}

describe('isPictureInPictureAvailable', () => {
  it('requires the document to advertise support', () => {
    expect(isPictureInPictureAvailable(supportingDocument())).toBe(true);
    expect(isPictureInPictureAvailable({ pictureInPictureEnabled: false })).toBe(false);
    expect(isPictureInPictureAvailable({})).toBe(false);
    expect(isPictureInPictureAvailable(null)).toBe(false);
  });
});

describe('isVideoPopOutAvailable', () => {
  it('offers the managed desktop pop-out when element Picture-in-Picture is unavailable', () => {
    expect(isVideoPopOutAvailable(nativeVideoPopOutHost(), null)).toBe(true);
  });

  it('falls back to element Picture-in-Picture in a browser', () => {
    expect(isVideoPopOutAvailable(browserNativeHost, supportingDocument())).toBe(true);
    expect(isVideoPopOutAvailable(browserNativeHost, null)).toBe(false);
  });
});

describe('canPopOutVideo', () => {
  it('accepts a normal video in a supporting document', () => {
    expect(canPopOutVideo(supportingVideo(), supportingDocument())).toBe(true);
  });

  it('rejects a video that opted out of Picture-in-Picture', () => {
    expect(canPopOutVideo(supportingVideo({ disablePictureInPicture: true }), supportingDocument()))
      .toBe(false);
  });

  it('rejects a webview without the API', () => {
    expect(canPopOutVideo({ disablePictureInPicture: false }, supportingDocument())).toBe(false);
    expect(canPopOutVideo(supportingVideo(), { pictureInPictureEnabled: false })).toBe(false);
  });
});

describe('togglePictureInPicture', () => {
  it('pops the feed out when nothing is popped out', async () => {
    const video = supportingVideo();
    const doc = supportingDocument();

    await expect(togglePictureInPicture(video, doc)).resolves.toBe('entered');
    expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
    expect(doc.exitPictureInPicture).not.toHaveBeenCalled();
  });

  it('puts the same feed back instead of failing', async () => {
    const video = supportingVideo();
    const doc = supportingDocument({ pictureInPictureElement: video as unknown as Element });

    await expect(togglePictureInPicture(video, doc)).resolves.toBe('exited');
    expect(doc.exitPictureInPicture).toHaveBeenCalledOnce();
    expect(video.requestPictureInPicture).not.toHaveBeenCalled();
  });

  it('pops out even when a different feed is already popped out', async () => {
    const video = supportingVideo();
    const doc = supportingDocument({
      pictureInPictureElement: supportingVideo() as unknown as Element
    });

    await expect(togglePictureInPicture(video, doc)).resolves.toBe('entered');
    expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
  });

  it('reports an unsupported host rather than throwing', async () => {
    await expect(togglePictureInPicture(null, supportingDocument())).resolves.toBe('unsupported');
    await expect(togglePictureInPicture(supportingVideo(), null)).resolves.toBe('unsupported');
    await expect(
      togglePictureInPicture(supportingVideo(), { pictureInPictureEnabled: false })
    ).resolves.toBe('unsupported');
  });

  it('reports a rejected request as a failure', async () => {
    const video = supportingVideo({
      requestPictureInPicture: vi.fn(async () => {
        throw new Error('Metadata for the video element are not loaded yet.');
      })
    });

    await expect(togglePictureInPicture(video, supportingDocument())).resolves.toBe('failed');
  });
});

describe('toggleVideoPopOut', () => {
  it('opens a lightweight managed window over the existing video stream', async () => {
    const owner = {};
    const fixture = managedVideoFixture();

    await expect(
      toggleVideoPopOut(
        fixture.sourceVideo,
        owner,
        nativeVideoPopOutHost(),
        null,
        fixture.opener
      )
    ).resolves.toBe('entered');

    expect(fixture.opener.open).toHaveBeenCalledWith(
      'about:blank#chatto-video-pop-out',
      'chatto-video-pop-out',
      'popup=yes,width=640,height=360,resizable=yes'
    );
    expect(fixture.popupVideo.srcObject).toBe(fixture.stream);
    expect(fixture.popupVideo.autoplay).toBe(true);
    expect(fixture.popupVideo.muted).toBe(true);
    expect(fixture.popupVideo.playsInline).toBe(true);
    expect(fixture.popupVideo.play).toHaveBeenCalledOnce();

    closeActiveVideoPopOut(owner);
  });

  it('toggles the same managed feed closed', async () => {
    const owner = {};
    const fixture = managedVideoFixture();

    await toggleVideoPopOut(
      fixture.sourceVideo,
      owner,
      nativeVideoPopOutHost(),
      null,
      fixture.opener
    );
    await expect(
      toggleVideoPopOut(
        fixture.sourceVideo,
        owner,
        nativeVideoPopOutHost(),
        null,
        fixture.opener
      )
    ).resolves.toBe('exited');

    expect(fixture.popup.close).toHaveBeenCalledOnce();
    expect(fixture.opener.open).toHaveBeenCalledOnce();
  });

  it('reuses the managed window for another feed and transfers cleanup ownership', async () => {
    const owner = {};
    const nextOwner = {};
    const fixture = managedVideoFixture();
    const nextFixture = managedVideoFixture();

    await toggleVideoPopOut(
      fixture.sourceVideo,
      owner,
      nativeVideoPopOutHost(),
      null,
      fixture.opener
    );
    await toggleVideoPopOut(
      nextFixture.sourceVideo,
      nextOwner,
      nativeVideoPopOutHost(),
      null,
      fixture.opener
    );

    expect(fixture.opener.open).toHaveBeenCalledOnce();
    expect(fixture.popupVideo.srcObject).toBe(nextFixture.stream);
    closeActiveVideoPopOut(owner);
    expect(fixture.popup.close).not.toHaveBeenCalled();
    closeActiveVideoPopOut(nextOwner);
    expect(fixture.popup.close).toHaveBeenCalledOnce();
  });

  it('closes a managed pop-out when its video track ends', async () => {
    const owner = {};
    const fixture = managedVideoFixture();

    await toggleVideoPopOut(
      fixture.sourceVideo,
      owner,
      nativeVideoPopOutHost(),
      null,
      fixture.opener
    );
    fixture.trackListeners.get('ended')?.(new Event('ended'));

    expect(fixture.popup.close).toHaveBeenCalledOnce();
    closeActiveVideoPopOut(owner);
    expect(fixture.popup.close).toHaveBeenCalledOnce();
  });

  it('forgets a managed pop-out that the user closes', async () => {
    const owner = {};
    const fixture = managedVideoFixture();

    await toggleVideoPopOut(
      fixture.sourceVideo,
      owner,
      nativeVideoPopOutHost(),
      null,
      fixture.opener
    );
    fixture.popupListeners.get('pagehide')?.(new Event('pagehide'));
    closeActiveVideoPopOut(owner);

    expect(fixture.popup.close).not.toHaveBeenCalled();
  });

  it('only lets the owning call close the active pop-out', async () => {
    const owner = {};
    const otherCall = {};
    const fixture = managedVideoFixture();

    await toggleVideoPopOut(
      fixture.sourceVideo,
      owner,
      nativeVideoPopOutHost(),
      null,
      fixture.opener
    );
    closeActiveVideoPopOut(otherCall);
    expect(fixture.popup.close).not.toHaveBeenCalled();

    closeActiveVideoPopOut(owner);
    expect(fixture.popup.close).toHaveBeenCalledOnce();
  });

  it('never lets a native close failure escape into call cleanup', async () => {
    const owner = {};
    const fixture = managedVideoFixture();
    fixture.popup.close.mockImplementation(() => {
      throw new Error('The window was already destroyed.');
    });

    await toggleVideoPopOut(
      fixture.sourceVideo,
      owner,
      nativeVideoPopOutHost(),
      null,
      fixture.opener
    );

    expect(() => closeActiveVideoPopOut(owner)).not.toThrow();
  });

  it('reports a blocked managed pop-up as a failure', async () => {
    const owner = {};
    const fixture = managedVideoFixture();
    fixture.opener.open.mockReturnValue(null);

    await expect(
      toggleVideoPopOut(
        fixture.sourceVideo,
        owner,
        nativeVideoPopOutHost(),
        null,
        fixture.opener
      )
    ).resolves.toBe('failed');
  });

  it('uses element Picture-in-Picture in a browser and closes only its owner', async () => {
    const owner = {};
    const otherCall = {};
    const video = {
      ...supportingVideo(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    const doc = supportingDocument();

    await expect(
      toggleVideoPopOut(
        video as unknown as HTMLVideoElement,
        owner,
        browserNativeHost,
        doc,
        null
      )
    ).resolves.toBe('entered');
    closeActiveVideoPopOut(otherCall);
    expect(doc.exitPictureInPicture).not.toHaveBeenCalled();

    doc.pictureInPictureElement = video as unknown as Element;
    closeActiveVideoPopOut(owner);
    expect(doc.exitPictureInPicture).toHaveBeenCalledOnce();
  });
});
