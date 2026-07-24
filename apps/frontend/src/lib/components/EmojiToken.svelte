<!--
@component

Renders a single emoji reference as either a unicode glyph or, when it is a
server custom-emoji shortcode, that emoji's image.

Quick-reaction surfaces and the picker's "Recently Used" row all store emoji as
bare strings that may be either form, so they share this component rather than
each re-deriving the glyph-vs-image decision.

Renders nothing when the entry looks like a custom shortcode but does not
resolve — a bare `partyparrot` is never useful to show. Callers that must not
leave a hole should filter through `RecentEmojisStore.renderable` first.

**Props:**
- `serverId` - Server whose custom emojis the shortcode is resolved against.
- `emoji` - A unicode glyph or a custom-emoji shortcode name.
- `imgClass` - Sizing/layout classes applied to the custom-emoji `<img>`.
-->
<script lang="ts">
	import { isCustomEmojiName } from '$lib/emoji';
	import { getCustomEmoji } from '$lib/state/customEmojis.svelte';

	let {
		serverId,
		emoji,
		imgClass = 'h-[1.35rem] w-auto'
	}: {
		serverId: string;
		emoji: string;
		imgClass?: string;
	} = $props();

	const custom = $derived(isCustomEmojiName(emoji) ? getCustomEmoji(serverId, emoji) : undefined);
	const isUnresolvedCustom = $derived(!custom && isCustomEmojiName(emoji));
</script>

{#if custom}
	<img src={custom.url} alt=":{custom.name}:" class="inline-block object-contain {imgClass}" />
{:else if !isUnresolvedCustom}
	{emoji}
{/if}
