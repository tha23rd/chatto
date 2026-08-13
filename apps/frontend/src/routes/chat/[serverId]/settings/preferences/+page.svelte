<script lang="ts">
  import { m } from '$lib/i18n/messages';
  import { localeDisplayName, selectableLocales } from '$lib/i18n/locales';
  import { getLocale, setLocale, type Locale } from '$lib/i18n/runtime';
  import { useServerScope } from '$lib/state/server/scope.svelte';
  import { createAccountAPI } from '$lib/api-client/account';
  import { TimeFormat } from '@chatto/api-types/api/v1/viewer_pb';
  import { userPreferences, type DisplayTheme } from '$lib/state/userPreferences.svelte';
  import { ChoiceRow, PaneHeader, FormSection } from '$lib/ui';
  import { Button, Combobox, FormError, RangeField, Checkbox } from '$lib/ui/form';
  import { toast } from '$lib/ui/toast';
  import {
    formatMessageTime,
    hour12ForTimeFormat,
    timeFormatSettingsFor
  } from '$lib/utils/formatTime';
  import DesktopUpdateSettings from '$lib/components/settings/DesktopUpdateSettings.svelte';
  import NoiseSuppressionSettings from '$lib/components/voice/NoiseSuppressionSettings.svelte';
  import { NoiseSuppressionController } from '$lib/voice/noiseSuppression.svelte';

  // Standalone controller for this settings view: no call to attach to, but
  // the mode/strength preference it reads and writes is client-wide, so it
  // stays in sync with (and applies to) any in-progress call on any server.
  const noiseSuppressionController = new NoiseSuppressionController(() => {});
  const serverScope = useServerScope();
  const currentUser = $derived(serverScope.store.currentUser);
  const savedSettings = $derived(currentUser.user?.settings);
  const timeSettings = $derived(timeFormatSettingsFor(savedSettings));
  const activeLocale = $derived(getLocale());

  function accountAPI() {
    return serverScope.connection.getAPI(createAccountAPI);
  }

  // All available IANA timezone names
  const allTimezones = Intl.supportedValuesOf('timeZone');

  // These are edit buffers rather than mirrors. Initialize them once the
  // scoped viewer has resolved, then preserve any edits made on this mount.
  let settingsInitialized = $state(false);
  let timezoneSearch = $state('');
  let selectedTimezone = $state('');
  let selectedTimeFormat = $state<TimeFormat>(TimeFormat.TIME_FORMAT_AUTO);
  let isSaving = $state(false);
  let error = $state('');

  $effect(() => {
    if (settingsInitialized || currentUser.loading) return;

    const timezone = savedSettings?.timezone ?? '';
    timezoneSearch = timezone;
    selectedTimezone = timezone;
    selectedTimeFormat = savedSettings?.timeFormat ?? TimeFormat.TIME_FORMAT_AUTO;
    settingsInitialized = true;
  });

  // Filter timezone list based on search input
  let filteredTimezones = $derived(
    timezoneSearch
      ? allTimezones.filter((tz) => tz.toLowerCase().includes(timezoneSearch.toLowerCase()))
      : allTimezones
  );

  // Cap displayed results to avoid rendering 400+ items
  let displayedTimezones = $derived(filteredTimezones.slice(0, 50));

  // Track if the form has been modified
  const isModified = $derived(
    settingsInitialized &&
      ((selectedTimezone || null) !== (savedSettings?.timezone ?? null) ||
        selectedTimeFormat !== (savedSettings?.timeFormat ?? TimeFormat.TIME_FORMAT_AUTO))
  );

  // Timezone validation
  const timezoneError = $derived.by(() => {
    if (!timezoneSearch) return undefined;
    if (allTimezones.includes(timezoneSearch)) return undefined;
    return m('settings.preferences.timezone.invalid');
  });

  const selectedTimezoneTime = $derived.by(() => {
    if (!selectedTimezone) return null;

    return formatMessageTime(
      new Date(),
      {
        effectiveTimezone: selectedTimezone,
        effectiveHour12: hour12ForTimeFormat(selectedTimeFormat)
      },
      activeLocale
    );
  });

  function handleTimezoneTextChange(text: string) {
    if (!text || allTimezones.includes(text)) selectedTimezone = text;
  }

  function handleLocaleSelect(locale: Locale) {
    if (locale === activeLocale) return;
    void setLocale(locale);
  }

  async function handleSave() {
    // Validate timezone if set
    if (timezoneSearch && !allTimezones.includes(timezoneSearch)) {
      error = m('settings.preferences.timezone.invalid');
      return;
    }

    isSaving = true;
    error = '';

    try {
      const settings = await accountAPI().updateSettings({
        timezone: selectedTimezone || null,
        timeFormat: selectedTimeFormat
      });
      if (!serverScope.isCurrent()) return;
      if (currentUser.user) {
        currentUser.user = {
          ...currentUser.user,
          settings
        };
      }

      toast.success(m('settings.preferences.saved'));
    } catch (err) {
      if (!serverScope.isCurrent()) return;
      error = err instanceof Error ? err.message : m('settings.preferences.save_failed');
    } finally {
      if (serverScope.isCurrent()) isSaving = false;
    }
  }

  const themeOptions = $derived([
    {
      value: 'system',
      label: m('settings.preferences.theme.system.label'),
      description: m('settings.preferences.theme.system.description')
    },
    {
      value: 'light',
      label: m('settings.preferences.theme.light.label'),
      description: m('settings.preferences.theme.light.description')
    },
    {
      value: 'dark',
      label: m('settings.preferences.theme.dark.label'),
      description: m('settings.preferences.theme.dark.description')
    }
  ] satisfies Array<{
    value: DisplayTheme;
    label: string;
    description: string;
  }>);

  const languageOptions = $derived(
    selectableLocales.map((locale) => ({
      value: locale,
      label: localeDisplayName(locale, activeLocale)
    }))
  );

  const timeFormatOptions = $derived([
    {
      value: TimeFormat.TIME_FORMAT_AUTO,
      label: m('settings.preferences.time_format.browser_default.label'),
      description: m('settings.preferences.time_format.browser_default.description')
    },
    {
      value: TimeFormat.TIME_FORMAT_12_HOUR,
      label: m('settings.preferences.time_format.12h.label'),
      description: m('settings.preferences.time_format.12h.description')
    },
    {
      value: TimeFormat.TIME_FORMAT_24_HOUR,
      label: m('settings.preferences.time_format.24h.label'),
      description: m('settings.preferences.time_format.24h.description')
    }
  ] satisfies Array<{
    value: TimeFormat;
    label: string;
    description: string;
  }>);
</script>

<PaneHeader
  title={m('settings.preferences.title')}
  subtitle={m('settings.preferences.subtitle')}
  showMobileNav
/>

<div class="flex flex-col gap-6 overflow-y-auto p-6">
  <!-- Theme -->
  <FormSection title={m('settings.preferences.theme.title')} maxWidth="max-w-md">
    <div
      class="flex flex-col gap-2"
      role="radiogroup"
      aria-label={m('settings.preferences.theme.title')}
    >
      {#each themeOptions as option (option.value)}
        {@const isSelected = userPreferences.displayTheme === option.value}
        <ChoiceRow
          label={option.label}
          description={option.description}
          selected={isSelected}
          onclick={() => (userPreferences.displayTheme = option.value)}
        />
      {/each}
    </div>
  </FormSection>

  <DesktopUpdateSettings timeSettings={timeSettings} />

  <!-- Language -->
  <FormSection title={m('settings.preferences.language.title')} maxWidth="max-w-md" bordered>
    <p class="mb-3 text-sm text-muted">{m('settings.preferences.language.description')}</p>

    <div
      class="flex flex-col gap-2"
      role="radiogroup"
      aria-label={m('settings.preferences.language.title')}
    >
      {#each languageOptions as option (option.value)}
        {@const isSelected = activeLocale === option.value}
        <ChoiceRow
          label={option.label}
          selected={isSelected}
          onclick={() => handleLocaleSelect(option.value)}
        />
      {/each}
    </div>
  </FormSection>

  <!-- Timezone -->
  <FormSection title={m('settings.preferences.timezone.title')} maxWidth="max-w-md" bordered>
    <Combobox
      id="timezone"
      testid="timezone-input"
      label={m('settings.preferences.timezone.title')}
      labelHidden
      description={m('settings.preferences.timezone.description')}
      error={timezoneError}
      items={displayedTimezones}
      getValue={(timezone) => timezone}
      getLabel={(timezone) => timezone}
      placeholder={m('settings.preferences.timezone.browser_default')}
      clearLabel={m('settings.preferences.timezone.clear')}
      allowFreeform={false}
      disabled={!settingsInitialized}
      bind:value={selectedTimezone}
      bind:text={timezoneSearch}
      ontextchange={handleTimezoneTextChange}
    />

    {#if selectedTimezoneTime}
      <p class="mt-1 text-sm text-muted">
        {m('settings.preferences.timezone.current_time', { time: selectedTimezoneTime })}
      </p>
    {/if}
  </FormSection>

  <!-- Time Format -->
  <FormSection title={m('settings.preferences.time_format.title')} maxWidth="max-w-md" bordered>
    <div
      class="flex flex-col gap-2"
      role="radiogroup"
      aria-label={m('settings.preferences.time_format.title')}
    >
      {#each timeFormatOptions as option (option.value)}
        {@const isSelected = selectedTimeFormat === option.value}
        <ChoiceRow
          label={option.label}
          description={option.description}
          selected={isSelected}
          disabled={!settingsInitialized}
          onclick={() => (selectedTimeFormat = option.value)}
        />
      {/each}
    </div>
  </FormSection>

  <!-- Soundboard playback -->
  <FormSection title={m('settings.preferences.soundboard.title')} maxWidth="max-w-md" bordered>
    <p class="mb-3 text-sm text-muted">{m('settings.preferences.soundboard.description')}</p>

    <div class="flex flex-col gap-3">
      <RangeField
        id="soundboard-volume"
        testid="soundboard-volume"
        label={m('settings.preferences.soundboard.volume')}
        icon="icon-[uil--volume]"
        min={0}
        max={100}
        step={5}
        value={Math.round(userPreferences.soundboardVolume * 100)}
        displayValue={`${Math.round(userPreferences.soundboardVolume * 100)}%`}
        disabled={userPreferences.soundboardMuted}
        oninput={(e) =>
          (userPreferences.soundboardVolume =
            Number((e.currentTarget as HTMLInputElement).value) / 100)}
      />

      <Checkbox
        id="soundboard-muted"
        label={m('settings.preferences.soundboard.mute.label')}
        description={m('settings.preferences.soundboard.mute.description')}
        checked={userPreferences.soundboardMuted}
        onchange={(e) =>
          (userPreferences.soundboardMuted = (e.currentTarget as HTMLInputElement).checked)}
      />
    </div>
  </FormSection>

  <!-- Noise suppression -->
  <FormSection title={m('voice.noise_suppression')} maxWidth="max-w-md" bordered>
    <NoiseSuppressionSettings controller={noiseSuppressionController} />
  </FormSection>

  <!-- Save -->
  {#if error}
    <div class="max-w-md">
      <FormError {error} />
    </div>
  {/if}

  <div class="flex max-w-md gap-2">
    <Button
      onclick={handleSave}
      disabled={!isModified || isSaving || !!timezoneError}
      loading={isSaving}
    >
      {m('settings.preferences.save_button')}
    </Button>
  </div>
</div>
