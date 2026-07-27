<!--
@component

Call settings menu section for the viewer's layout choices: grid vs featured
layout, and which of their own/low-value tiles are worth screen space.

Every option here is local to this viewer and persists per device. None of them
change what other participants see or what media is published.

Rendered inside `AudioDeviceMenu`, which owns the in-call settings menu.
-->
<script lang="ts">
  import { userPreferences, type CallViewPreferenceKey } from '$lib/state/userPreferences.svelte';
  import * as m from '$lib/i18n/messages';

  type ViewOption = {
    key: CallViewPreferenceKey;
    label: string;
    testId: string;
  };

  const options = $derived<ViewOption[]>([
    { key: 'grid', label: m['voice.grid_view'](), testId: 'call-view-option-grid' },
    {
      key: 'showOwnCamera',
      label: m['voice.show_own_camera'](),
      testId: 'call-view-option-own-camera'
    },
    {
      key: 'showNonVideoParticipants',
      label: m['voice.show_non_video_participants'](),
      testId: 'call-view-option-non-video'
    },
    {
      key: 'showOwnScreenShare',
      label: m['voice.show_own_screen_share'](),
      testId: 'call-view-option-own-screen-share'
    }
  ]);
</script>

<div class="menu-section">
  <div class="px-3 py-1.5 text-xs font-medium text-muted">{m['voice.view_options']()}</div>
  <nav class="sidebar-nav">
    {#each options as option (option.key)}
      {@const checked = userPreferences.callView[option.key]}
      <button
        class="sidebar-item"
        role="menuitemcheckbox"
        aria-checked={checked}
        data-testid={option.testId}
        onclick={() => {
          // Keep the menu open: these options are usually adjusted together,
          // and each one re-lays out the call behind the menu, so the effect is
          // visible without reopening it.
          userPreferences.toggleCallViewPreference(option.key);
        }}
      >
        {#if checked}
          <span class="sidebar-icon iconify text-action uil--check"></span>
        {:else}
          <span class="sidebar-icon"></span>
        {/if}
        <span class="truncate">{option.label}</span>
      </button>
    {/each}
  </nav>
</div>
