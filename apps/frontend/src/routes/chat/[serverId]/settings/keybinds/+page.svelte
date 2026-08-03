<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    type CallKeybindingAction,
    callKeybindingAcceleratorFromEvent,
    callKeybindingActionForAccelerator,
    formatCallKeybindingAccelerator,
    setCallKeybindingCaptureActive
  } from '$lib/callKeybindings';
  import * as m from '$lib/i18n/messages';
  import { getNativeHost } from '$lib/native/host';
  import { userPreferences } from '$lib/state/userPreferences.svelte';
  import { FormSection, Hint, PaneHeader } from '$lib/ui';
  import { Button } from '$lib/ui/form';
  import { toast } from '$lib/ui/toast';

  const voiceActions: readonly CallKeybindingAction[] = [
    'push-to-talk',
    'push-to-mute',
    'toggle-mute',
    'mute',
    'unmute',
    'toggle-deafen',
    'deafen',
    'undeafen'
  ];
  const videoActions: readonly CallKeybindingAction[] = [
    'toggle-camera',
    'camera-on',
    'camera-off',
    'toggle-screen-share',
    'start-screen-share',
    'stop-screen-share'
  ];
  const callActions: readonly CallKeybindingAction[] = ['leave-call'];

  const isDesktop = getNativeHost().capabilities.globalCallKeybindings;
  let recordingAction = $state<CallKeybindingAction | null>(null);

  function actionLabel(action: CallKeybindingAction): string {
    switch (action) {
      case 'push-to-talk':
        return m['settings.keybinds.actions.push_to_talk']();
      case 'push-to-mute':
        return m['settings.keybinds.actions.push_to_mute']();
      case 'toggle-mute':
        return m['settings.keybinds.actions.toggle_mute']();
      case 'mute':
        return m['settings.keybinds.actions.mute']();
      case 'unmute':
        return m['settings.keybinds.actions.unmute']();
      case 'toggle-deafen':
        return m['settings.keybinds.actions.toggle_deafen']();
      case 'deafen':
        return m['settings.keybinds.actions.deafen']();
      case 'undeafen':
        return m['settings.keybinds.actions.undeafen']();
      case 'toggle-camera':
        return m['settings.keybinds.actions.toggle_camera']();
      case 'camera-on':
        return m['settings.keybinds.actions.camera_on']();
      case 'camera-off':
        return m['settings.keybinds.actions.camera_off']();
      case 'toggle-screen-share':
        return m['settings.keybinds.actions.toggle_screen_share']();
      case 'start-screen-share':
        return m['settings.keybinds.actions.start_screen_share']();
      case 'stop-screen-share':
        return m['settings.keybinds.actions.stop_screen_share']();
      case 'leave-call':
        return m['settings.keybinds.actions.leave_call']();
    }
  }

  function stopRecording(): void {
    recordingAction = null;
    setCallKeybindingCaptureActive(false);
  }

  function startRecording(action: CallKeybindingAction): void {
    if (recordingAction === action) {
      stopRecording();
      return;
    }
    recordingAction = action;
    setCallKeybindingCaptureActive(true);
  }

  function handleKeydown(event: KeyboardEvent): void {
    const action = recordingAction;
    if (!action) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.code === 'Escape') {
      stopRecording();
      return;
    }

    const accelerator = callKeybindingAcceleratorFromEvent(event);
    if (!accelerator) return;

    const previousAction = callKeybindingActionForAccelerator(
      userPreferences.callKeybindings,
      accelerator
    );
    userPreferences.setCallKeybinding(action, accelerator);
    stopRecording();

    if (previousAction && previousAction !== action) {
      toast.success(
        m['settings.keybinds.reassigned']({
          keybind: formatCallKeybindingAccelerator(accelerator),
          action: actionLabel(previousAction)
        })
      );
    }
  }

  function clearBinding(action: CallKeybindingAction): void {
    if (recordingAction === action) stopRecording();
    userPreferences.setCallKeybinding(action, null);
  }

  function resetBindings(): void {
    stopRecording();
    userPreferences.resetCallKeybindings();
    toast.success(m['settings.keybinds.reset_success']());
  }

  onDestroy(stopRecording);
</script>

<svelte:window onkeydown={handleKeydown} onblur={stopRecording} />

{#snippet actionRows(actions: readonly CallKeybindingAction[])}
  <div class="selectable-list">
    {#each actions as action (action)}
      {@const accelerator = userPreferences.callKeybindings[action]}
      {@const isRecording = recordingAction === action}
      <div class="selectable-list-item flex min-h-14 items-center gap-3 px-3 py-2">
        <span class="min-w-0 flex-1 font-medium">{actionLabel(action)}</span>
        <button
          type="button"
          class={[
            'control-frame min-h-10 min-w-36 cursor-pointer bg-background px-3 py-2 text-left font-mono transition-[background-color,border-color,color,scale] active:scale-[0.98]',
            isRecording
              ? 'border-action text-action'
              : 'border-input text-text hover:bg-surface hover:text-text-top'
          ]}
          aria-label={m['settings.keybinds.record_for']({ action: actionLabel(action) })}
          aria-pressed={isRecording}
          data-call-keybinding-recorder
          data-testid={`keybind-recorder-${action}`}
          onclick={() => startRecording(action)}
        >
          {isRecording
            ? m['settings.keybinds.recording']()
            : accelerator
              ? formatCallKeybindingAccelerator(accelerator)
              : m['settings.keybinds.unassigned']()}
        </button>
        <button
          type="button"
          class="icon-action"
          aria-label={m['settings.keybinds.clear_for']({ action: actionLabel(action) })}
          title={m['settings.keybinds.clear_for']({ action: actionLabel(action) })}
          disabled={!accelerator}
          data-testid={`keybind-clear-${action}`}
          onclick={() => clearBinding(action)}
        >
          <span class="iconify uil--times" aria-hidden="true"></span>
        </button>
      </div>
    {/each}
  </div>
{/snippet}

<PaneHeader
  title={m['settings.keybinds.title']()}
  subtitle={m['settings.keybinds.subtitle']()}
  showMobileNav
/>

<div class="flex flex-col gap-6 overflow-y-auto p-6">
  <div class="max-w-2xl">
    <Hint icon="uil--keyboard">
      <p>{m['settings.keybinds.instructions']()}</p>
      <p class="mt-1">
        {isDesktop
          ? m['settings.keybinds.desktop_note']()
          : m['settings.keybinds.browser_note']()}
      </p>
    </Hint>
  </div>

  <FormSection title={m['settings.keybinds.groups.voice']()} maxWidth="max-w-2xl">
    {@render actionRows(voiceActions)}
  </FormSection>

  <FormSection
    title={m['settings.keybinds.groups.video_streaming']()}
    maxWidth="max-w-2xl"
    bordered
  >
    {@render actionRows(videoActions)}
  </FormSection>

  <FormSection title={m['settings.keybinds.groups.call']()} maxWidth="max-w-2xl" bordered>
    {@render actionRows(callActions)}
  </FormSection>

  <div class="max-w-2xl">
    <Button variant="secondary" onclick={resetBindings}>
      {m['settings.keybinds.reset']()}
    </Button>
  </div>
</div>
