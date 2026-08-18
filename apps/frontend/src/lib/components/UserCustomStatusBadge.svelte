<!--
@component

Displays a user's custom status emoji with optional text. The status is
independent of presence and hides itself after its expiry timestamp.

**Props:**
- `status` - The custom user status to display.
- `showText` - Whether to show the status text next to the emoji.
-->
<script lang="ts">
  import type { CustomUserStatus } from '$lib/state/userProfiles.svelte';
  import { formatCustomStatusText } from '$lib/customStatusTemplates';
  import { isCustomEmojiName } from '$lib/emoji';
  import { getCustomEmoji, getCustomEmojis } from '$lib/state/customEmojis.svelte';
  import { useServerScope } from '$lib/state/server/scope.svelte';

  const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

  let {
    status,
    showText = false,
    class: className = ''
  }: {
    status?: CustomUserStatus | null;
    showText?: boolean;
    class?: string;
  } = $props();

  let expiryTick = $state(0);

  // Most badge surfaces sit inside a server scope; outside one, custom
  // shortcodes fall back to their readable `:name:` form.
  let serverScope: ReturnType<typeof useServerScope> | null = null;
  try {
    serverScope = useServerScope();
  } catch {
    serverScope = null;
  }

  const activeStatus = $derived.by(() => {
    void expiryTick;
    if (!status) return null;
    if (!status.expiresAt) return status;
    return new Date(status.expiresAt).getTime() > Date.now() ? status : null;
  });
  const displayText = $derived(activeStatus?.text ? formatCustomStatusText(activeStatus.text) : '');
  const customEmoji = $derived(
    serverScope && activeStatus && isCustomEmojiName(activeStatus.emoji)
      ? getCustomEmoji(serverScope.serverId, activeStatus.emoji)
      : undefined
  );
  const emojiLabel = $derived(
    activeStatus && isCustomEmojiName(activeStatus.emoji)
      ? `:${activeStatus.emoji}:`
      : (activeStatus?.emoji ?? '')
  );
  const title = $derived(
    activeStatus ? `${emojiLabel}${displayText ? ` ${displayText}` : ''}` : undefined
  );

  // Load the server's custom-emoji catalog on demand so a shortcode status
  // renders as an image even on surfaces that never load it themselves.
  $effect(() => {
    if (!serverScope || !activeStatus || !isCustomEmojiName(activeStatus.emoji)) return;
    const conn = serverScope.connection;
    getCustomEmojis(serverScope.serverId).ensureLoaded({
      serverId: conn.serverId,
      baseUrl: conn.connectBaseUrl,
      bearerToken: conn.bearerToken
    });
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

{#if activeStatus}
  <span
    class={[
      'inline-flex min-w-0 shrink-0 items-center align-middle leading-none',
      showText ? 'gap-1 text-xs text-muted' : 'text-sm',
      className
    ]}
    {title}
    aria-label={title}
  >
    <span aria-hidden="true">
      {#if customEmoji}
        <img
          src={customEmoji.url}
          alt=":{customEmoji.name}:"
          class="inline-block h-[1.35em] w-auto object-contain"
        />
      {:else}
        {emojiLabel}
      {/if}
    </span>
    {#if showText && displayText}
      <bdi class="min-w-0 truncate">{displayText}</bdi>
    {/if}
  </span>
{/if}
