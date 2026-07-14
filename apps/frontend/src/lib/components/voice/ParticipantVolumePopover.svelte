<!--
@component

Anchored popover with a 0–100% playback-volume slider for a single remote call
participant. The percentage is a per-viewer local playback volume, independent
of the participant's own microphone. Local mute overrides playback audibly
without discarding the stored slider value.

**Props:**
- `anchor` - Position rect for the FloatingPopover
- `participant` - The participant being adjusted (needs `volume` percent + `isLocallyMuted`)
- `onclose` - Called when the popover should dismiss
- `oninput` - Called on each slider input event
-->
<script lang="ts">
  import FloatingPopover from '$lib/ui/FloatingPopover.svelte';
  import * as m from '$lib/i18n/messages';

  let {
    anchor,
    participant,
    onclose,
    oninput
  }: {
    anchor: { top: number; bottom: number; left: number };
    participant: { volume: number; isLocallyMuted: boolean };
    onclose: () => void;
    oninput: (event: Event) => void;
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
  <div {onkeydown} role="presentation">
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
      {#if participant.isLocallyMuted}
        <span class="text-xs text-muted">{m['voice.participant_volume_muted_hint']()}</span>
      {/if}
    </label>
  </div>
</FloatingPopover>
