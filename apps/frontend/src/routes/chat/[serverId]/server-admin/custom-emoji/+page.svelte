<script lang="ts">
  import CustomEmojiSettings from '$lib/CustomEmojiSettings.svelte';
  import PaneHeader from '$lib/ui/PaneHeader.svelte';
  import PageTitle from '$lib/ui/PageTitle.svelte';
  import * as m from '$lib/i18n/messages';
</script>

<PageTitle
  title={m['admin.common.server_admin_page_title']({
    title: m['server_settings.custom_emoji.title']()
  })}
/>

<PaneHeader
  title={m['server_settings.custom_emoji.title']()}
  subtitle={m['server_settings.custom_emoji.subtitle']()}
  showMobileNav
/>

<div class="flex flex-col gap-6 overflow-y-auto p-6">
  <CustomEmojiSettings />
</div>
