<!--
@component

Floating menu for the viewer's call stage layout choices, opened from the call
pane header while the call is maximized.

**Props:**
- `anchor` - Position rect for the ContextMenu
- `onclose` - Called when the menu should dismiss
-->
<script lang="ts">
  import ContextMenu from '$lib/ui/ContextMenu.svelte';
  import CallViewOptionsSection from './CallViewOptionsSection.svelte';

  let {
    anchor,
    onclose
  }: {
    anchor: { top: number; bottom: number; left: number };
    onclose: () => void;
  } = $props();
</script>

<ContextMenu {anchor} {onclose}>
  <CallViewOptionsSection />
</ContextMenu>
