import { describe, expect, it, vi } from 'vitest';
import {
  canPopOutVideo,
  isPictureInPictureAvailable,
  togglePictureInPicture,
  type PictureInPictureDocument,
  type PictureInPictureVideo
} from './pictureInPicture';

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

describe('isPictureInPictureAvailable', () => {
  it('requires the document to advertise support', () => {
    expect(isPictureInPictureAvailable(supportingDocument())).toBe(true);
    expect(isPictureInPictureAvailable({ pictureInPictureEnabled: false })).toBe(false);
    expect(isPictureInPictureAvailable({})).toBe(false);
    expect(isPictureInPictureAvailable(null)).toBe(false);
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
