<script lang="ts">
  import SoundboardSettings from '$lib/SoundboardSettings.svelte';
  import PaneHeader from '$lib/ui/PaneHeader.svelte';
  import PageTitle from '$lib/ui/PageTitle.svelte';
  import * as m from '$lib/i18n/messages';
</script>

<PageTitle
  title={m['admin.common.server_admin_page_title']({
    title: m['soundboard.title']()
  })}
/>

<PaneHeader
  title={m['soundboard.title']()}
  subtitle={m['soundboard.subtitle']()}
  showMobileNav
/>

<div class="flex flex-col gap-6 overflow-y-auto p-6">
  <SoundboardSettings />
</div>
