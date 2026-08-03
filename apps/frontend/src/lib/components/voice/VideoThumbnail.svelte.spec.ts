import { describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import { PresenceStatus } from '@chatto/api-types/api/v1/presence_pb';
import type { Track } from 'livekit-client';
import VideoThumbnail from './VideoThumbnail.svelte';

function track() {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as Track & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
}

const user = {
  id: 'user-1',
  login: 'bob',
  displayName: 'Bob',
  avatarUrl: null,
  presenceStatus: PresenceStatus.ONLINE
};

describe('VideoThumbnail', () => {
  it('renders a feed that the platform can pop out', () => {
    const { container } = render(VideoThumbnail, {
      props: { track: track(), name: 'Bob', user, showIdentityOverlay: false }
    });

    const video = q(container, 'video') as HTMLVideoElement;

    // Picture-in-Picture is how a viewer floats a feed above other windows. Opting the
    // element out — via the attribute or the property — removes that everywhere at once,
    // including the browser's own pop-out affordances.
    expect(video.hasAttribute('disablepictureinpicture')).toBe(false);
    expect(video.disablePictureInPicture).toBe(false);
    // Inline playback and autoplay keep the tile a live feed rather than a paused poster,
    // which a pop-out window would otherwise inherit.
    expect(video.autoplay).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.muted).toBe(true);
  });

  it('keeps the same video element when unrelated props change', async () => {
    const videoTrack = track();
    const rendered = render(VideoThumbnail, {
      props: { track: videoTrack, name: 'Bob', user, showIdentityOverlay: false }
    });

    const video = q(rendered.container, 'video') as HTMLVideoElement;
    expect(videoTrack.attach).toHaveBeenCalledOnce();
    expect(videoTrack.attach).toHaveBeenCalledWith(video);

    // The panel re-derives participants every 60ms for the speaking indicator. Replacing the
    // element on those re-renders would tear down any active pop-out or fullscreen window.
    await rendered.rerender({
      track: videoTrack,
      name: 'Bob (poor connection)',
      user,
      showIdentityOverlay: false
    });
    flushSync();

    expect(q(rendered.container, 'video')).toBe(video);
    expect(videoTrack.detach).not.toHaveBeenCalled();
    expect(videoTrack.attach).toHaveBeenCalledOnce();
  });

  it('reattaches only when the track itself changes', async () => {
    const first = track();
    const second = track();
    const rendered = render(VideoThumbnail, {
      props: { track: first, name: 'Bob', user, showIdentityOverlay: false }
    });

    const video = q(rendered.container, 'video') as HTMLVideoElement;

    await rendered.rerender({ track: second, name: 'Bob', user, showIdentityOverlay: false });
    flushSync();

    expect(first.detach).toHaveBeenCalledWith(video);
    expect(second.attach).toHaveBeenCalledWith(video);
  });
});
