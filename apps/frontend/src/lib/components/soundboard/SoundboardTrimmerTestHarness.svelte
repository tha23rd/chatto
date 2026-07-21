<!--
@component

Test-only wrapper that owns the bindable trim selection so specs can assert on
`start`/`end` after driving the trimmer's pointer and keyboard affordances.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import SoundboardTrimmer from './SoundboardTrimmer.svelte';

  let {
    buffer,
    start = 0,
    end,
    maxSelectionSeconds = Infinity
  }: {
    buffer: AudioBuffer;
    /** Initial selection start; the harness owns the value from then on. */
    start?: number;
    /** Initial selection end; the harness owns the value from then on. */
    end: number;
    maxSelectionSeconds?: number;
  } = $props();

  // Seed once: the trimmer, not the caller, drives the selection afterwards.
  let selectionStart = $state(untrack(() => start));
  let selectionEnd = $state(untrack(() => end));
</script>

<SoundboardTrimmer
  {buffer}
  bind:start={selectionStart}
  bind:end={selectionEnd}
  {maxSelectionSeconds}
/>

<output data-testid="selection">{selectionStart.toFixed(3)}–{selectionEnd.toFixed(3)}</output>
