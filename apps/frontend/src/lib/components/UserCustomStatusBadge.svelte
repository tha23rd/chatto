<!--
@component

Displays a user's custom status emoji with optional text. The status is
independent of presence and hides itself after its expiry timestamp.

**Props:**
- `serverId` - Server whose custom emoji catalog resolves the status marker.
- `status` - The custom user status to display.
- `showText` - Whether to show the status text next to the emoji.
-->
<script lang="ts">
  import { isCustomEmojiName } from '$lib/emoji';
  import { getCustomEmoji } from '$lib/state/customEmojis.svelte';
  import type { CustomUserStatus } from '$lib/state/userProfiles.svelte';
  import { formatCustomStatusText } from '$lib/customStatusTemplates';
  import EmojiToken from './EmojiToken.svelte';

  const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

  let {
    serverId,
    status,
    showText = false,
    class: className = ''
  }: {
    serverId: string;
    status?: CustomUserStatus | null;
    showText?: boolean;
    class?: string;
  } = $props();

  let expiryTick = $state(0);

  const activeStatus = $derived.by(() => {
    void expiryTick;
    if (!status) return null;
    if (!status.expiresAt) return status;
    return new Date(status.expiresAt).getTime() > Date.now() ? status : null;
  });
  const displayText = $derived(activeStatus?.text ? formatCustomStatusText(activeStatus.text) : '');
  const customEmoji = $derived(
    activeStatus && isCustomEmojiName(activeStatus.emoji)
      ? getCustomEmoji(serverId, activeStatus.emoji)
      : undefined
  );
  const hasEmojiMarker = $derived(
    !!activeStatus && (!isCustomEmojiName(activeStatus.emoji) || !!customEmoji)
  );
  const shouldRender = $derived(!!activeStatus && (hasEmojiMarker || (showText && !!displayText)));
  const title = $derived.by(() => {
    if (!activeStatus) return undefined;
    const markerLabel = customEmoji
      ? `:${customEmoji.name}:`
      : hasEmojiMarker
        ? activeStatus.emoji
        : '';
    return [markerLabel, displayText].filter(Boolean).join(' ') || undefined;
  });

  $effect(() => {
    const expiresAt = status?.expiresAt;
    if (!expiresAt) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      const expiresAtMs = new Date(expiresAt).getTime();
      if (Number.isNaN(expiresAtMs)) return;
      const delay = expiresAtMs - Date.now();
      if (delay <= 0) {
        expiryTick += 1;
        return;
      }
      timeout = setTimeout(schedule, Math.min(delay, MAX_TIMEOUT_DELAY_MS));
    };

    schedule();
    return () => {
      if (timeout) clearTimeout(timeout);
    };
  });
</script>

{#if activeStatus && shouldRender}
  <span
    class={[
      'inline-flex min-w-0 shrink-0 items-center align-middle leading-none',
      showText ? 'gap-1 text-xs text-muted' : 'text-sm',
      className
    ]}
    {title}
    aria-label={title}
  >
    {#if hasEmojiMarker}
      <span aria-hidden="true">
        <EmojiToken {serverId} emoji={activeStatus.emoji} imgClass="h-[1em] w-auto" />
      </span>
    {/if}
    {#if showText && displayText}
      <span class="min-w-0 truncate">{displayText}</span>
    {/if}
  </span>
{/if}
