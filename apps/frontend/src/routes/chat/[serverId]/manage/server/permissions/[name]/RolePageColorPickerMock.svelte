<script lang="ts">
  // Stands in for RoleColorPicker. The role page binds `color`, so the prop has
  // to be declared bindable even though this spec does not drive colour
  // selection; a plain prop would make Svelte throw on `bind:`.
  let { color = $bindable(0) }: { color?: number } = $props();
</script>

<div data-testid="role-color-picker" data-color={color}></div>
