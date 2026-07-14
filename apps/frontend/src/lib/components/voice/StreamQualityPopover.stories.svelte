<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import StreamQualityPopover from './StreamQualityPopover.svelte';
  import type { ScreenShareCeiling } from '$lib/state/server/screenShareQuality';

  const { Story } = defineMeta({
    title: 'Voice/Stream quality',
    component: StreamQualityPopover,
    tags: ['autodocs'],
    parameters: {
      docs: {
        description: {
          component:
            'Discord-style screen-share quality picker. Opened from the Share Screen button before capture starts (preflight, with Go Live) and from the gear beside it while a share is live (applies immediately). Unlike Discord, the bitrate each choice needs is shown rather than hidden behind a tier.'
        }
      }
    }
  });

  // Anchored near the top-left so the popover is visible in the story canvas.
  const anchor = { top: 80, bottom: 108, left: 32 };

  // The Go default: 1080p60 @ 8 Mbps, matching Discord's highest Go Live tier.
  const ceiling: ScreenShareCeiling = {
    maxWidth: 1920,
    maxHeight: 1080,
    maxFramerate: 60,
    maxBitrate: 8_000_000
  };

  // A self-hoster protecting a thin uplink: 720p30 @ 2 Mbps.
  const cappedCeiling: ScreenShareCeiling = {
    maxWidth: 1280,
    maxHeight: 720,
    maxFramerate: 30,
    maxBitrate: 2_000_000
  };
</script>

<!-- Pre-flight: the default 1080p60 choice, with the bitrate it needs and the Go Live action. -->
<Story name="Before going live" asChild>
  <div class="h-96 bg-background">
    <StreamQualityPopover
      {anchor}
      {ceiling}
      quality={{ resolution: '1080p', framerate: 60, shareAudio: false }}
      mode="preflight"
      onchange={() => {}}
      ongolive={() => {}}
      onclose={() => {}}
    />
  </div>
</Story>

<!-- Live: no Go Live action, because changes retune the running share in place. -->
<Story name="While sharing" asChild>
  <div class="h-96 bg-background">
    <StreamQualityPopover
      {anchor}
      {ceiling}
      quality={{ resolution: '720p', framerate: 60, shareAudio: true }}
      mode="live"
      onchange={() => {}}
      onclose={() => {}}
    />
  </div>
</Story>

<!-- The server ceiling bites: 1080p and 60fps are not offered at all, and the chosen tier's
     bitrate is clamped, so the picker says the picture will soften to hold the frame rate. -->
<Story name="Capped by the server" asChild>
  <div class="h-96 bg-background">
    <StreamQualityPopover
      {anchor}
      ceiling={cappedCeiling}
      quality={{ resolution: '720p', framerate: 30, shareAudio: false }}
      mode="preflight"
      onchange={() => {}}
      ongolive={() => {}}
      onclose={() => {}}
    />
  </div>
</Story>

<!-- A quality change that could not be applied to the live share. -->
<Story name="Applies to next share" asChild>
  <div class="h-96 bg-background">
    <StreamQualityPopover
      {anchor}
      {ceiling}
      quality={{ resolution: '1080p', framerate: 30, shareAudio: false }}
      mode="live"
      retuneFailed
      onchange={() => {}}
      onclose={() => {}}
    />
  </div>
</Story>
