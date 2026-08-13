<!--
@component

Shared icon button for the call panel and persistent current-user call controls.
Keeps labels, pending state, and icon presentation consistent across both surfaces.
-->
<script lang="ts">
  import type { MouseEventHandler } from 'svelte/elements';

  let {
    label,
    testId,
    icon,
    class: className,
    iconClass,
    pending = false,
    pressed,
    haspopup,
    expanded,
    onclick
  }: {
    label: string;
    testId: string;
    icon: string;
    class: string;
    iconClass?: string;
    pending?: boolean;
    /** Toggle controls (deafen, soundboard) expose their on/off state. */
    pressed?: boolean;
    /** Controls that open a menu or dialog rather than toggling immediately. */
    haspopup?: 'dialog' | 'menu';
    /** Whether this control's popup is open. Pair with `haspopup`. */
    expanded?: boolean;
    onclick: MouseEventHandler<HTMLButtonElement>;
  } = $props();
</script>

<button
  type="button"
  class={className}
  title={label}
  aria-label={label}
  aria-pressed={pressed}
  aria-haspopup={haspopup}
  aria-expanded={haspopup ? !!expanded : undefined}
  data-testid={testId}
  {onclick}
  disabled={pending}
  aria-busy={pending || undefined}
>
  <span
    class={['iconify', iconClass, pending ? 'animate-spin icon-[uil--spinner]' : icon]}
    aria-hidden="true"
  ></span>
</button>
