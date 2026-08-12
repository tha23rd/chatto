<!--
@component

Anchored popover for choosing screen-share quality: Resolution, Frame Rate, and whether to
share the window's audio. Modelled on Discord's Stream Quality menu.

This is the single home for stream controls; the Share Screen button opens it in both
states, so there is no separate stream-settings gear competing with the call's device gear:

- **Pre-flight** (`mode="preflight"`): opened *before* capture starts. The primary action is
  Go Live; confirming it triggers `getDisplayMedia()`.
- **Live** (`mode="live"`): opened while sharing. Quality changes retune the running share in
  place, and the primary action becomes Stop sharing, replacing Go Live.

Unlike Discord, the bitrate each choice needs is shown rather than hidden. Discord's picker
lets you select 1080p60 on a tier whose bitrate cannot carry it, which is the single most
common cause of "why is my stream blocky" — showing the number makes the tradeoff legible.

**Props:**
- `anchor` - Position rect for the FloatingPopover
- `quality` - Current preference (resolution / framerate / shareAudio)
- `ceiling` - Server's advisory quality ceiling; tiers above it are not offered
- `mode` - `'preflight'` (Go Live action) or `'live'` (applies immediately, Stop action)
- `retuneFailed` - Show the "applies to your next share" notice
- `diagnosticsAvailable` - Whether a bounded stats sample is ready to copy
- `onchange` - Called with the new preference whenever a control changes
- `oncopydiagnostics` - Copies privacy-safe local WebRTC stats (`live` mode only)
- `ongolive` - Called when Go Live is pressed (`preflight` only)
- `onstop` - Called when Stop sharing is pressed (`live` only)
- `onclose` - Called when the popover should dismiss
-->
<script lang="ts">
  import FloatingPopover from '$lib/ui/FloatingPopover.svelte';
  import { m } from '$lib/i18n/messages';
  import {
    availableFramerates,
    availableResolutions,
    formatBitrateMbps,
    requiredBitrate,
    type ScreenShareCeiling,
    type ScreenShareFramerate,
    type ScreenShareQualityPrefs
  } from '$lib/state/server/screenShareQuality';

  let {
    anchor,
    quality,
    ceiling,
    mode,
    retuneFailed = false,
    diagnosticsAvailable = false,
    onchange,
    ongolive,
    oncopydiagnostics,
    onstop,
    onclose
  }: {
    anchor: { top: number; bottom: number; left: number };
    quality: ScreenShareQualityPrefs;
    ceiling: ScreenShareCeiling;
    mode: 'preflight' | 'live';
    retuneFailed?: boolean;
    diagnosticsAvailable?: boolean;
    onchange: (prefs: ScreenShareQualityPrefs) => void;
    ongolive?: () => void;
    oncopydiagnostics?: () => void;
    onstop?: () => void;
    onclose: () => void;
  } = $props();

  const resolutions = $derived(availableResolutions(ceiling));
  const framerates = $derived(availableFramerates(ceiling));

  // What the current choice needs, and what the server ceiling will actually allow through.
  const needed = $derived(requiredBitrate(quality.resolution, quality.framerate));
  const effective = $derived(Math.min(needed, ceiling.maxBitrate));
  // The ceiling is biting: the chosen resolution/framerate cannot get the bitrate it wants,
  // so the encoder will shed resolution to hold the frame rate. Say so rather than let the
  // user wonder why 1080p looks soft.
  const clampedByCeiling = $derived(effective < needed);

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose();
    }
  }
</script>

<FloatingPopover
  {anchor}
  {onclose}
  role="dialog"
  ariaLabel={m('voice.stream_quality')}
  class="menu w-64 p-3"
>
  <div {onkeydown} role="presentation" class="flex flex-col gap-3">
    <div class="text-sm font-medium">{m('voice.stream_quality')}</div>

    <label class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted">{m('voice.stream_resolution')}</span>
      <select
        data-testid="stream-quality-resolution"
        class="input w-full cursor-pointer"
        value={quality.resolution}
        onchange={(event) =>
          onchange({
            ...quality,
            resolution: event.currentTarget.value as ScreenShareQualityPrefs['resolution']
          })}
      >
        {#each resolutions as resolution (resolution)}
          <option value={resolution}>{resolution}</option>
        {/each}
      </select>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted">{m('voice.stream_framerate')}</span>
      <select
        data-testid="stream-quality-framerate"
        class="input w-full cursor-pointer"
        value={String(quality.framerate)}
        onchange={(event) =>
          onchange({
            ...quality,
            framerate: Number(event.currentTarget.value) as ScreenShareFramerate
          })}
      >
        {#each framerates as framerate (framerate)}
          <option value={String(framerate)}>{m('voice.stream_fps', { fps: framerate })}</option>
        {/each}
      </select>
    </label>

    <p class="text-xs text-muted tabular-nums" data-testid="stream-quality-bitrate">
      {m('voice.stream_bitrate_estimate', { mbps: formatBitrateMbps(effective) })}
    </p>

    {#if clampedByCeiling}
      <p class="text-xs text-warning" data-testid="stream-quality-ceiling-notice">
        {m('voice.stream_bitrate_capped', {
          mbps: formatBitrateMbps(ceiling.maxBitrate)
        })}
      </p>
    {/if}

    <label class="flex cursor-pointer items-center gap-2 text-sm">
      <input
        data-testid="stream-quality-share-audio"
        type="checkbox"
        class="cursor-pointer accent-accent"
        checked={quality.shareAudio}
        onchange={(event) => onchange({ ...quality, shareAudio: event.currentTarget.checked })}
      />
      <span>{m('voice.stream_share_audio')}</span>
    </label>

    {#if retuneFailed}
      <p class="text-xs text-muted" data-testid="stream-quality-retune-failed">
        {m('voice.stream_quality_next_share')}
      </p>
    {/if}

    {#if mode === 'live'}
      <button
        type="button"
        class="btn btn-secondary w-full cursor-pointer"
        data-testid="stream-quality-copy-diagnostics"
        disabled={!diagnosticsAvailable}
        onclick={() => oncopydiagnostics?.()}
      >
        <span class="icon-[uil--clipboard-notes]" aria-hidden="true"></span>
        {m('common.copy_to_clipboard')}
      </button>
    {/if}

    <!-- One primary action, flipped by state: start the share, or stop the running one.
         Stopping lives here (rather than on the toolbar button) so the toolbar keeps a
         single stream control instead of a button plus a competing settings gear. -->
    {#if mode === 'preflight'}
      <button
        type="button"
        class="btn-action w-full cursor-pointer"
        data-testid="stream-quality-go-live"
        onclick={() => ongolive?.()}
      >
        {m('voice.stream_go_live')}
      </button>
    {:else}
      <button
        type="button"
        class="btn-danger w-full cursor-pointer"
        data-testid="stream-quality-stop"
        onclick={() => onstop?.()}
      >
        {m('voice.stop_share_screen')}
      </button>
    {/if}
  </div>
</FloatingPopover>
