<script lang="ts">
  import * as m from '$lib/i18n/messages';
  import { roleColorFromInputValue, roleColorToCSS, roleColorToInputValue } from '$lib/roleColors';
  import { Button } from '$lib/ui/form';

  let {
    color = $bindable(0),
    disabled = false,
    onchange
  }: {
    color?: number;
    disabled?: boolean;
    onchange?: (color: number) => void;
  } = $props();

  const inputValue = $derived(roleColorToInputValue(color));
  const previewColor = $derived(roleColorToCSS(color));

  function chooseColor(event: Event) {
    color = roleColorFromInputValue((event.currentTarget as HTMLInputElement).value);
    onchange?.(color);
  }

  function clearColor() {
    color = 0;
    onchange?.(color);
  }
</script>

<div class="flex flex-col gap-2">
  <label class="text-sm font-medium" for="roleColor">{m['rbac.role_form.colour']()}</label>
  <div class="flex flex-wrap items-center gap-3">
    <input
      id="roleColor"
      data-testid="role-color-input"
      type="color"
      value={inputValue}
      onchange={chooseColor}
      {disabled}
      class="h-10 w-14 cursor-pointer rounded border border-border bg-surface p-1 disabled:cursor-not-allowed disabled:opacity-50"
    />
    <span
      class="inline-flex h-8 min-w-20 items-center justify-center rounded bg-surface-emphasized px-3 text-sm font-semibold"
      style:color={previewColor}
      data-testid="role-color-preview"
    >
      Aa
    </span>
    <Button type="button" variant="secondary" onclick={clearColor} {disabled}>
      {m['rbac.role_form.default_colour']()}
    </Button>
  </div>
  <p class="text-xs text-muted">{m['rbac.role_form.colour_description']()}</p>
</div>
