<!--
@component

Anchored popover with 0–100% playback-volume sliders for a single remote call
participant. The percentages are per-viewer local playback volumes, independent
of the participant's own microphone. Local mute overrides playback audibly
without discarding the stored slider values.

A participant sharing their screen with audio gets a second, independent slider:
game and music audio is routinely much louder than the voice mixed alongside it,
so turning the stream down must not also turn the person down.

**Props:**
- `anchor` - Position rect for the FloatingPopover
- `participant` - The participant being adjusted (needs `volume`, `screenShareVolume`, `hasScreenShareAudio` + `isLocallyMuted`)
- `onclose` - Called when the popover should dismiss
- `oninput` - Called on each voice slider input event
- `onscreensharinput` - Called on each stream-audio slider input event
-->
<script lang="ts">
  import FloatingPopover from '$lib/ui/FloatingPopover.svelte';
  import * as m from '$lib/i18n/messages';

  let {
    anchor,
    participant,
    onclose,
    oninput,
    onscreensharinput
  }: {
    anchor: { top: number; bottom: number; left: number };
    participant: {
      volume: number;
      screenShareVolume: number;
      hasScreenShareAudio: boolean;
      isLocallyMuted: boolean;
    };
    onclose: () => void;
    oninput: (event: Event) => void;
    onscreensharinput?: (event: Event) => void;
  } = $props();

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
  ariaLabel={m['voice.participant_volume']()}
  class="menu w-56 p-3"
>
  <div {onkeydown} role="presentation" class="flex flex-col gap-3">
    <label class="flex flex-col gap-2">
      <span class="flex items-center justify-between gap-3 text-sm">
        <span class="flex min-w-0 items-center gap-2 font-medium">
          <span class="iconify shrink-0 text-base text-muted uil--volume" aria-hidden="true"></span>
          <span class="truncate">{m['voice.participant_volume']()}</span>
        </span>
        <span class="text-muted tabular-nums">{Math.round(participant.volume)}%</span>
      </span>
      <input
        data-testid="call-participant-volume-slider"
        type="range"
        min="0"
        max="100"
        step="1"
        value={participant.volume}
        {oninput}
        aria-label={m['voice.participant_volume_value']({ percent: Math.round(participant.volume) })}
        class="w-full cursor-pointer accent-accent"
      />
    </label>

    {#if participant.hasScreenShareAudio}
      <label class="flex flex-col gap-2">
        <span class="flex items-center justify-between gap-3 text-sm">
          <span class="flex min-w-0 items-center gap-2 font-medium">
            <span
              class="iconify shrink-0 text-base text-muted uil--desktop"
              aria-hidden="true"
            ></span>
            <span class="truncate">{m['voice.stream_volume']()}</span>
          </span>
          <span class="text-muted tabular-nums">{Math.round(participant.screenShareVolume)}%</span>
        </span>
        <input
          data-testid="call-stream-volume-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          value={participant.screenShareVolume}
          oninput={onscreensharinput}
          aria-label={m['voice.stream_volume_value']({
            percent: Math.round(participant.screenShareVolume)
          })}
          class="w-full cursor-pointer accent-accent"
        />
      </label>
    {/if}

    {#if participant.isLocallyMuted}
      <span class="text-xs text-muted">{m['voice.participant_volume_muted_hint']()}</span>
    {/if}
  </div>
</FloatingPopover>
