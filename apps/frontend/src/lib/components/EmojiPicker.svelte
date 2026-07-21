<!--
@component

Full emoji picker with search and categories.
Pure content component — rendered inside a ContextMenu by the parent.
Uses the same section styling as MessageContextMenu (rounded-md bg-background sections).

**Props:**
- `serverId` - The active server. Used to scope the per-server "Recently Used" list.
- `includeCustom` - Offer the server's custom emojis. Set `false` on surfaces
  that can only render a unicode glyph, since a custom emoji is emitted as a
  bare shortcode name rather than something displayable on its own.
- `onSelect` - Callback when an emoji is selected
- `onClose` - Callback to dismiss the picker (Escape key)
-->
<script lang="ts">
  import * as m from '$lib/i18n/messages';
  import { searchEmojis, EMOJI_BY_CATEGORY, type EmojiResult } from '$lib/emoji';
  import { supportsHoverActions } from '$lib/utils/inputCapabilities';
  import { getRecentEmojis, MAX_RECENT_EMOJIS } from '$lib/state/recentEmojis.svelte';
  import { getCustomEmojis } from '$lib/state/customEmojis.svelte';
  import { useConnection } from '$lib/state/server/connection.svelte';

  let {
    serverId,
    includeCustom = true,
    onSelect,
    onClose
  }: {
    serverId: string;
    includeCustom?: boolean;
    onSelect: (emoji: string) => void;
    onClose: () => void;
  } = $props();

  let query = $state('');
  const canUseHoverActions = supportsHoverActions();

  const recentStore = $derived(getRecentEmojis(serverId));
  const recent = $derived(recentStore.recent.slice(0, MAX_RECENT_EMOJIS));

  // The picker renders in a few surfaces; most sit inside a server connection,
  // but some (e.g. the custom-status editor) do not. Guard so those still work;
  // custom emojis are simply unavailable without a connection.
  let connection: ReturnType<typeof useConnection> | null = null;
  try {
    connection = useConnection();
  } catch {
    connection = null;
  }

  const customStore = $derived(getCustomEmojis(serverId));

  // Load the server's custom emojis when the picker opens (mounts).
  $effect(() => {
    if (!includeCustom) return;
    const conn = connection?.();
    if (!conn) return;
    customStore.ensureLoaded({
      serverId: conn.serverId,
      baseUrl: conn.connectBaseUrl,
      bearerToken: conn.bearerToken
    });
  });

  // Synthetic "Custom" category, prepended to the standard categories. Each
  // entry carries a `url`, which switches rendering from glyph to <img>.
  const customEntries = $derived(
    includeCustom
      ? customStore.emojis.map((emoji) => ({
          name: emoji.name,
          emoji: emoji.name,
          url: emoji.url
        }))
      : []
  );
  const categories = $derived(
    customEntries.length > 0
      ? [
          { name: m['emoji.custom_emoji.category'](), icon: '', emojis: customEntries },
          ...EMOJI_BY_CATEGORY
        ]
      : EMOJI_BY_CATEGORY
  );

  const customSearchResults: EmojiResult[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!includeCustom || !q) return [];
    return customStore.emojis
      .filter((emoji) => emoji.name.toLowerCase().includes(q))
      .map((emoji) => ({ name: emoji.name, emoji: emoji.name, tags: [], url: emoji.url }));
  });
  const searchResults = $derived(
    query.trim() ? [...customSearchResults, ...searchEmojis(query.trim(), 50)] : []
  );
  const isSearching = $derived(query.trim().length > 0);

  function focusSearchInput(node: HTMLInputElement) {
    if (canUseHoverActions) queueMicrotask(() => node.focus());
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (query) {
        query = '';
        e.stopPropagation();
      } else {
        onClose();
      }
    }
  }

  function selectEmoji(emoji: string) {
    recentStore.record(emoji);
    onSelect(emoji);
  }

  function selectEntry(entry: { emoji: string; name: string; url?: string }) {
    if (entry.url) {
      // Custom emoji: emit the shortcode name so it flows through as a reaction
      // key. Not recorded in recents, which can only render unicode glyphs.
      onSelect(entry.name);
    } else {
      selectEmoji(entry.emoji);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex w-full flex-col gap-2 md:w-72 md:gap-1" onkeydown={handleKeydown}>
  <!-- Search section -->
  <div class="menu-section p-2 md:p-1">
    <input
      {@attach focusSearchInput}
      bind:value={query}
      type="text"
      placeholder={m['emoji.search_placeholder']()}
      class="w-full rounded bg-surface px-3 py-2.5 text-base outline-none placeholder:text-muted md:px-2.5 md:py-1.5 md:text-sm"
    />
  </div>

  <!-- Emoji grid section -->
  <div class="menu-section p-2 md:p-1">
    <!-- Emoji grid -->
    <div class="max-h-[50vh] overflow-y-auto md:max-h-72">
      {#if isSearching}
        {#if searchResults.length === 0}
          <div class="py-6 text-center text-sm text-muted">{m['emoji.no_results']()}</div>
        {:else}
          <div class="grid grid-cols-7 md:grid-cols-8">
            {#each searchResults as result (result.name)}
              <button
                class="flex aspect-square cursor-pointer items-center justify-center rounded text-3xl hover:bg-surface active:bg-surface md:h-8 md:w-8 md:text-base"
                onclick={() => selectEntry(result)}
                title={result.name}
              >
                {#if result.url}
                  <img src={result.url} alt={result.name} class="h-6 w-6 object-contain" />
                {:else}
                  {result.emoji}
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        {#if recent.length > 0}
          <div
            class="mt-1 mb-1 px-1 text-sm font-medium text-muted md:mt-0 md:mb-0.5 md:px-0 md:text-xs"
          >
            Recently Used
          </div>
          <div class="grid grid-cols-7 md:grid-cols-8">
            {#each recent as emoji (emoji)}
              <button
                class="flex aspect-square cursor-pointer items-center justify-center rounded text-3xl hover:bg-surface active:bg-surface md:h-8 md:w-8 md:text-base"
                onclick={() => selectEmoji(emoji)}
              >
                {emoji}
              </button>
            {/each}
          </div>
        {/if}
        {#each categories as cat (cat.name)}
          <div
            class="mt-3 mb-1 px-1 text-sm font-medium text-muted md:mt-1 md:mb-0.5 md:px-0 md:text-xs"
          >
            {cat.name}
          </div>
          <div class="grid grid-cols-7 md:grid-cols-8">
            {#each cat.emojis as entry (entry.name)}
              <button
                class="flex aspect-square cursor-pointer items-center justify-center rounded text-3xl hover:bg-surface active:bg-surface md:h-8 md:w-8 md:text-base"
                onclick={() => selectEntry(entry)}
                title={entry.name}
              >
                {#if entry.url}
                  <img src={entry.url} alt={entry.name} class="h-6 w-6 object-contain" />
                {:else}
                  {entry.emoji}
                {/if}
              </button>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>
