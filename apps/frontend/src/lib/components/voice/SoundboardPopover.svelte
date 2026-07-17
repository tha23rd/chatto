<!--
@component

Anchored in-call soundboard panel. Lists the server's sounds (emoji + name);
clicking one plays it into the call for every participant. Throttled triggers
flash a subtle notice driven by the caller's `throttled` flag.

**Props:**
- `anchor` - Position rect for the FloatingPopover
- `sounds` - The server's soundboard catalog
- `throttled` - True while the client-side rate limiter is rejecting triggers
- `onplay` - Called with a sound when it is triggered
- `onclose` - Called when the popover should dismiss
-->
<script lang="ts">
  import FloatingPopover from '$lib/ui/FloatingPopover.svelte';
  import * as m from '$lib/i18n/messages';
  import type { Sound } from '$lib/api-client/soundboard';

  let {
    anchor,
    sounds,
    throttled = false,
    onplay,
    onclose
  }: {
    anchor: { top: number; bottom: number; left: number };
    sounds: Sound[];
    throttled?: boolean;
    onplay: (sound: Sound) => void;
    onclose: () => void;
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
  anchorPlacement="top"
  role="dialog"
  ariaLabel={m['soundboard.panel_title']()}
  class="menu w-64 p-3"
>
  <div {onkeydown} role="presentation" class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <div class="text-sm font-medium">{m['soundboard.panel_title']()}</div>
      {#if throttled}
        <span class="text-xs text-warning" data-testid="soundboard-throttled">
          {m['soundboard.throttled']()}
        </span>
      {/if}
    </div>

    {#if sounds.length === 0}
      <p class="text-xs text-muted">{m['soundboard.panel_empty']()}</p>
    {:else}
      <div class="grid grid-cols-3 gap-2" data-testid="soundboard-sound-grid">
        {#each sounds as sound (sound.id)}
          <button
            type="button"
            class="btn-secondary btn-sm flex h-16 flex-col items-center justify-center gap-1 !px-1"
            data-testid="soundboard-sound-button"
            title={sound.name}
            onclick={() => onplay(sound)}
          >
            <span class="text-xl leading-none">
              {#if sound.emoji}{sound.emoji}{:else}<span class="iconify uil--music"></span>{/if}
            </span>
            <span class="w-full truncate text-center text-[0.65rem] leading-tight">
              {sound.name}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</FloatingPopover>
