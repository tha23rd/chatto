<!--
@component

One root-level prompt for a downloaded desktop update. Deferring remembers
only the current candidate for this component lifetime; installation is never
started by navigation, a timer, or a state transition.
-->
<script lang="ts">
  import { m } from '$lib/i18n/messages';
  import { desktopUpdates } from '$lib/native/desktopUpdates.svelte';
  import { idleState } from '$lib/state/idle.svelte';
  import { Dialog } from '$lib/ui';
  import { Button } from '$lib/ui/form';
  import { toast } from '$lib/ui/toast';

  let dismissedCandidate = $state<string | null>(null);

  const readyCandidate = $derived(
    desktopUpdates.snapshot.supported && desktopUpdates.snapshot.phase === 'ready'
      ? desktopUpdates.snapshot.candidateVersion
      : undefined
  );
  const promptVisible = $derived(
    readyCandidate !== undefined && readyCandidate !== dismissedCandidate && !idleState.isInAnyCall
  );

  function deferCandidate(): void {
    if (readyCandidate) dismissedCandidate = readyCandidate;
  }

  async function restartNow(): Promise<void> {
    try {
      await desktopUpdates.installNow();
    } catch {
      toast.error(m('ui.desktop_updates.error.install'));
    }
  }
</script>

{#if promptVisible && readyCandidate}
  <Dialog visible size="sm" title={m('ui.desktop_updates.prompt.title')} onclose={deferCandidate}>
    <p class="text-muted">
      {m('ui.desktop_updates.prompt.body', { version: readyCandidate })}
    </p>

    {#snippet footer()}
      <div class="flex justify-end gap-2 border-t border-text/10 pt-3">
        <Button variant="secondary" onclick={deferCandidate} disabled={desktopUpdates.installing}>
          {m('ui.desktop_updates.later')}
        </Button>
        <Button onclick={() => void restartNow()} loading={desktopUpdates.installing}>
          {m('ui.desktop_updates.restart_now')}
        </Button>
      </div>
    {/snippet}
  </Dialog>
{/if}
