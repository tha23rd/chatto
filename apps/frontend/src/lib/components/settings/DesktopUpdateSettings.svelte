<!--
@component

Native Windows update controls for the Preferences screen. The shared
coordinator owns update lifecycle and state; this component only presents the
current snapshot and explicit user actions.
-->
<script lang="ts">
  import { getLocale } from '$lib/i18n/runtime';
  import { m } from '$lib/i18n/messages';
  import { desktopUpdates } from '$lib/native/desktopUpdates.svelte';
  import type { DesktopUpdateSnapshot } from '$lib/native/types';
  import { idleState } from '$lib/state/idle.svelte';
  import type { TimeFormatSettings } from '$lib/utils/formatTime';
  import { ChoiceRow, ConfirmDialog, FormSection, Hint } from '$lib/ui';
  import { Button } from '$lib/ui/form';
  import { toast } from '$lib/ui/toast';
  import { formatDateTime } from '$lib/utils/formatTime';

  // Time formatting is the viewer's, so it is passed in rather than reached for
  // through a server scope: this panel is not otherwise server-scoped. Omitting
  // it falls back to the browser's own timezone and clock.
  const BROWSER_TIME_SETTINGS: TimeFormatSettings = {
    effectiveTimezone: undefined,
    effectiveHour12: undefined
  };
  let { timeSettings = BROWSER_TIME_SETTINGS }: { timeSettings?: TimeFormatSettings } = $props();
  const userSettings = $derived(timeSettings);
  const activeLocale = $derived(getLocale());

  let nightlyConfirmationVisible = $state(false);
  let activeCallConfirmationVisible = $state(false);
  let channelPending = $state(false);
  let manualCheckPending = $state(false);

  const waitingForStable = $derived(
    desktopUpdates.snapshot.channel === 'stable' &&
      desktopUpdates.snapshot.currentVersion.includes('-nightly.') &&
      desktopUpdates.snapshot.candidateVersion === undefined
  );

  function formatBytes(bytes: number): string {
    const value = Math.max(0, bytes);
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
    const unitIndex = Math.min(
      Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)),
      units.length - 1
    );
    const scaled = value / 1024 ** unitIndex;
    return new Intl.NumberFormat(activeLocale, {
      style: 'unit',
      unit: units[unitIndex],
      unitDisplay: 'short',
      maximumFractionDigits: unitIndex === 0 ? 0 : 1
    }).format(scaled);
  }

  function updateStatus(snapshot: DesktopUpdateSnapshot): string {
    if (snapshot.phase !== 'downloading') {
      return {
        idle: m('ui.desktop_updates.status.idle'),
        checking: m('ui.desktop_updates.status.checking'),
        ready: m('ui.desktop_updates.status.ready'),
        failed: m('ui.desktop_updates.status.failed')
      }[snapshot.phase];
    }

    const total = snapshot.totalBytes;
    const downloaded = snapshot.downloadedBytes ?? 0;
    if (total === undefined || total <= 0) return m('ui.desktop_updates.status.downloading');

    const percent = Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
    return m('ui.desktop_updates.status.downloading_progress_bytes', {
      percent,
      downloaded: formatBytes(downloaded),
      total: formatBytes(total)
    });
  }

  function liveUpdateStatus(snapshot: DesktopUpdateSnapshot): string {
    return snapshot.phase === 'downloading'
      ? m('ui.desktop_updates.status.downloading')
      : updateStatus(snapshot);
  }

  function downloadProgress(
    snapshot: DesktopUpdateSnapshot
  ): { value: number; max: number } | null {
    const total = snapshot.totalBytes;
    if (snapshot.phase !== 'downloading' || total === undefined || total <= 0) return null;

    return {
      value: Math.min(total, Math.max(0, snapshot.downloadedBytes ?? 0)),
      max: total
    };
  }

  function updateError(errorCode: DesktopUpdateSnapshot['errorCode']): string | null {
    if (!errorCode) return null;
    return {
      network: m('ui.desktop_updates.error.network'),
      metadata: m('ui.desktop_updates.error.metadata'),
      signature: m('ui.desktop_updates.error.signature'),
      download: m('ui.desktop_updates.error.download'),
      install: m('ui.desktop_updates.error.install'),
      unavailable: m('ui.desktop_updates.error.unavailable')
    }[errorCode];
  }

  function lastChecked(snapshot: DesktopUpdateSnapshot): string {
    if (snapshot.lastCheckedAt === undefined) {
      return m('settings.preferences.desktop_updates.last_checked_unavailable');
    }
    return m('settings.preferences.desktop_updates.last_checked', {
      time: formatDateTime(new Date(snapshot.lastCheckedAt), userSettings, activeLocale)
    });
  }

  async function saveChannel(channel: 'stable' | 'nightly'): Promise<void> {
    if (channelPending || desktopUpdates.snapshot.channel === channel) return;
    channelPending = true;
    try {
      await desktopUpdates.setChannel(channel);
    } finally {
      channelPending = false;
    }
  }

  function chooseStable(): void {
    void saveChannel('stable');
  }

  function chooseNightly(): void {
    if (channelPending || desktopUpdates.snapshot.channel === 'nightly') return;
    nightlyConfirmationVisible = true;
  }

  async function confirmNightly(): Promise<void> {
    nightlyConfirmationVisible = false;
    await saveChannel('nightly');
  }

  async function checkNow(): Promise<void> {
    if (manualCheckPending) return;
    manualCheckPending = true;
    try {
      const snapshot = await desktopUpdates.checkNow();
      if (snapshot.phase === 'failed') {
        toast.error(m('ui.desktop_updates.toast.check_failed'));
      } else if (snapshot.phase === 'idle') {
        toast.success(m('ui.desktop_updates.toast.up_to_date'));
      }
    } catch {
      toast.error(m('ui.desktop_updates.toast.check_failed'));
    } finally {
      manualCheckPending = false;
    }
  }

  async function installUpdate(): Promise<void> {
    try {
      await desktopUpdates.installNow();
    } catch {
      toast.error(m('ui.desktop_updates.error.install'));
    }
  }

  function restartNow(): void {
    if (desktopUpdates.installing) return;
    if (idleState.isInAnyCall) {
      activeCallConfirmationVisible = true;
      return;
    }
    void installUpdate();
  }

  function confirmActiveCallRestart(): void {
    activeCallConfirmationVisible = false;
    void installUpdate();
  }
</script>

{#if desktopUpdates.snapshot.supported}
  <FormSection
    title={m('settings.preferences.desktop_updates.title')}
    maxWidth="max-w-md"
    bordered
  >
    <div class="flex flex-col gap-4">
      <p class="text-sm text-muted">{m('settings.preferences.desktop_updates.description')}</p>
      <p class="text-muted">
        {m('settings.preferences.desktop_updates.current_version', {
          version: desktopUpdates.snapshot.currentVersion
        })}
      </p>

      <div
        class="flex flex-col gap-2"
        role="radiogroup"
        aria-label={m('settings.preferences.desktop_updates.channel.label')}
      >
        <ChoiceRow
          label={m('settings.preferences.desktop_updates.channel.stable.label')}
          description={m('settings.preferences.desktop_updates.channel.stable.description')}
          selected={desktopUpdates.snapshot.channel === 'stable'}
          disabled={channelPending}
          onclick={chooseStable}
        />
        <ChoiceRow
          label={m('settings.preferences.desktop_updates.channel.nightly.label')}
          description={m('settings.preferences.desktop_updates.channel.nightly.description')}
          selected={desktopUpdates.snapshot.channel === 'nightly'}
          disabled={channelPending}
          onclick={chooseNightly}
        />
      </div>

      {#if waitingForStable}
        <Hint>
          <p class="font-medium">
            {m('settings.preferences.desktop_updates.waiting_for_stable.title')}
          </p>
          <p class="mt-1">
            {m('settings.preferences.desktop_updates.waiting_for_stable.body')}
          </p>
        </Hint>
      {/if}

      <div
        class="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="desktop-update-live-status"
      >
        <p>{liveUpdateStatus(desktopUpdates.snapshot)}</p>
        {#if desktopUpdates.snapshot.phase === 'failed'}
          {@const liveErrorMessage = updateError(desktopUpdates.snapshot.errorCode)}
          {#if liveErrorMessage}<p>{liveErrorMessage}</p>{/if}
        {/if}
      </div>

      <div class="flex flex-col gap-2 surface-box">
        <p aria-hidden={desktopUpdates.snapshot.phase === 'downloading'}>
          <span class="font-medium"
            >{m('settings.preferences.desktop_updates.status_label')}:</span
          >
          {updateStatus(desktopUpdates.snapshot)}
        </p>
        {#if desktopUpdates.snapshot.phase === 'downloading'}
          {@const progress = downloadProgress(desktopUpdates.snapshot)}
          {#if progress}
            <progress
              class="w-full"
              aria-label={m('ui.desktop_updates.status.downloading')}
              value={progress.value}
              max={progress.max}
            ></progress>
          {:else}
            <progress class="w-full" aria-label={m('ui.desktop_updates.status.downloading')}
            ></progress>
          {/if}
        {/if}
        <p class="text-sm text-muted">{lastChecked(desktopUpdates.snapshot)}</p>
        {#if desktopUpdates.snapshot.phase === 'failed'}
          {@const errorMessage = updateError(desktopUpdates.snapshot.errorCode)}
          {#if errorMessage}<p class="text-sm text-danger">{errorMessage}</p>{/if}
        {/if}
        {#if desktopUpdates.snapshot.phase === 'ready' && desktopUpdates.snapshot.candidateVersion}
          <p>
            {m('ui.desktop_updates.ready_version', {
              version: desktopUpdates.snapshot.candidateVersion
            })}
          </p>
          <div>
            <Button onclick={restartNow} loading={desktopUpdates.installing}>
              {m('ui.desktop_updates.restart_now')}
            </Button>
          </div>
        {/if}
      </div>

      <div>
        <Button
          variant="secondary"
          onclick={() => void checkNow()}
          loading={manualCheckPending || desktopUpdates.snapshot.phase === 'checking'}
          loadingText={m('settings.preferences.desktop_updates.checking')}
        >
          {m('settings.preferences.desktop_updates.check_now')}
        </Button>
      </div>
    </div>
  </FormSection>

  <ConfirmDialog
    visible={nightlyConfirmationVisible}
    title={m('settings.preferences.desktop_updates.nightly_confirmation.title')}
    tone="warning"
    actionLabel={m('settings.preferences.desktop_updates.nightly_confirmation.confirm')}
    loading={channelPending}
    onconfirm={() => void confirmNightly()}
    onclose={() => (nightlyConfirmationVisible = false)}
  >
    {m('settings.preferences.desktop_updates.nightly_confirmation.body')}
  </ConfirmDialog>

  <ConfirmDialog
    visible={activeCallConfirmationVisible}
    title={m('settings.preferences.desktop_updates.active_call.title')}
    tone="warning"
    actionLabel={m('settings.preferences.desktop_updates.active_call.confirm')}
    loading={desktopUpdates.installing}
    onconfirm={confirmActiveCallRestart}
    onclose={() => (activeCallConfirmationVisible = false)}
  >
    {m('settings.preferences.desktop_updates.active_call.body')}
  </ConfirmDialog>
{/if}
