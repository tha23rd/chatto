<!--
@component

Discord-style emoji autocomplete popup.
Shows matching emojis when typing :shortcode in chat input. Server-defined
custom emojis (rendered as images) are listed first, then built-in gemoji.

**Props:**
- `query` - Current search query (without the leading colon)
- `customEmojis` - The active server's custom emojis, matched by shortcode name
- `onSelect` - Callback when an emoji is selected. Receives the text to insert
  (a unicode glyph for gemoji, or a `:name:` shortcode for custom emoji) and
  the emoji's shortcode name.
- `onClose` - Callback to close the popup
-->
<script lang="ts">
  import {
    searchCustomEmojis,
    searchEmojis,
    type CustomEmojiLike,
    type EmojiResult
  } from '$lib/emoji';
  import AutocompletePopup from './AutocompletePopup.svelte';

  type Props = {
    query: string;
    customEmojis?: readonly CustomEmojiLike[];
    onSelect: (emoji: string, name: string) => void;
    onClose: () => void;
  };

  let { query, customEmojis = [], onSelect, onClose }: Props = $props();

  // Custom emoji first (server-specific and fewer), then gemoji. Cap the
  // combined list so the popup stays compact.
  let results = $derived(
    [...searchCustomEmojis(customEmojis, query, 10), ...searchEmojis(query, 10)].slice(0, 10)
  );

  let popupRef = $state<{ handleKeyDown: (e: KeyboardEvent) => boolean } | null>(null);

  export function handleKeyDown(event: KeyboardEvent): boolean {
    return popupRef?.handleKeyDown(event) ?? false;
  }

  function handleSelect(result: EmojiResult, _key: string) {
    // Custom emoji have no unicode glyph; insert their `:name:` shortcode so the
    // reference survives round-tripping through the message body as text.
    const insert = result.url ? `:${result.name}:` : result.emoji;
    onSelect(insert, result.name);
  }
</script>

<AutocompletePopup
  bind:this={popupRef}
  items={results}
  getKey={(r) => r.name}
  selectKeys={['Enter', 'Tab']}
  onSelect={handleSelect}
  {onClose}
  class="md:w-64"
>
  {#snippet item({ item: result })}
    {#if result.url}
      <img src={result.url} alt=":{result.name}:" class="h-5 w-5 object-contain" />
    {:else}
      <span class="text-xl">{result.emoji}</span>
    {/if}
    <span class="min-w-0 truncate text-sm text-text">:{result.name}:</span>
  {/snippet}
</AutocompletePopup>
