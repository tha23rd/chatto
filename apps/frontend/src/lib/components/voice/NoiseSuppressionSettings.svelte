<!--
@component

Preferences section for DeepFilterNet3 noise suppression: mode selector,
suppression-strength slider, and a loopback mic test whose preview follows the
selected mode (live level meter on the sensitivity slider).

**Props:**
- `controller` - the `NoiseSuppressionController` backing this view. The
  settings page passes a standalone controller (no attached call); the
  underlying mode/strength preference is client-wide, so changes made here
  still apply to any in-progress call via the module's shared preference.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ChoiceRow } from '$lib/ui';
  import { RangeField } from '$lib/ui/form';
  import {
    NoiseSuppressionController,
    isVoiceIsolationSupported,
    MIN_STRENGTH,
    MAX_STRENGTH,
    MIN_INPUT_GAIN,
    MAX_INPUT_GAIN,
    MIN_SENSITIVITY,
    MAX_SENSITIVITY,
    type NoiseSuppressionMode
  } from '$lib/voice/noiseSuppression.svelte';
  import { MicTest } from '$lib/voice/micTest.svelte';
  import * as m from '$lib/i18n/messages';

  let { controller }: { controller: NoiseSuppressionController } = $props();

  const modeOptions: { mode: NoiseSuppressionMode; label: string }[] = [
    { mode: 'off', label: m['voice.noise_suppression_standard']() },
    { mode: 'voice-isolation', label: m['voice.noise_suppression_voice_isolation']() },
    { mode: 'enhanced', label: m['voice.noise_suppression_enhanced']() }
  ];

  const test = new MicTest();
  // Release the microphone if the user navigates away mid-test without
  // pressing Stop; stop() is idempotent and safe when the test is idle.
  onDestroy(() => test.stop());
  const isEnhanced = $derived(controller.mode === 'enhanced');
  const isRunning = $derived(test.status === 'running');
  const isLoading = $derived(test.status === 'loading');
  // Static browser capability: voice isolation is effectively Safari-only.
  // Surface it here because the standalone settings controller has no call to
  // apply the mode to, so it never reports the unavailability itself.
  const voiceIsolationUnsupported = $derived(
    controller.mode === 'voice-isolation' && !isVoiceIsolationSupported()
  );

  // Live mic level (0..100), shown on the sensitivity slider while the test
  // runs so the gate threshold can be set just below where the voice peaks.
  const micLevelPct = $derived(Math.round(test.inputLevel * 100));
  const gateActive = $derived(controller.sensitivity > 0);
  const gateOpen = $derived(micLevelPct >= controller.sensitivity);
  // Green while the voice clears the gate (passes through), dimmed while it is
  // below the threshold (silenced), plain level when the gate is off.
  const levelFillClass = $derived(!gateActive ? 'bg-action' : gateOpen ? 'bg-success' : 'bg-muted');

  function selectMode(mode: NoiseSuppressionMode) {
    void controller.setMode(mode);
    // Keep a running preview in sync with the selected mode: switching modes is
    // the A/B comparison, so the loopback must follow the choice live.
    test.setNoiseSuppressionEnabled(mode === 'enhanced');
  }

  function toggleTest() {
    if (isRunning) test.stop();
    else if (!isLoading)
      void test.start({
        strength: controller.strength,
        inputGain: controller.inputGain,
        sensitivity: controller.sensitivity,
        // The preview reflects what would actually be sent for the selected mode.
        noiseSuppressionEnabled: controller.mode === 'enhanced'
      });
  }

  function onStrengthInput(e: Event) {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    void controller.setStrength(value);
    // Retune the audible loopback live while the mic test is running (no-op
    // when idle — the test starts from the current values on start()).
    test.setStrength(value);
  }

  function onInputGainInput(e: Event) {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    void controller.setInputGain(value);
    test.setInputGain(value);
  }

  function onSensitivityInput(e: Event) {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    void controller.setSensitivity(value);
    test.setSensitivity(value);
  }
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-col gap-2" role="radiogroup" aria-label={m['voice.noise_suppression']()}>
    {#each modeOptions as option (option.mode)}
      <ChoiceRow
        label={option.label}
        selected={option.mode === controller.mode}
        onclick={() => selectMode(option.mode)}
      />
    {/each}
    {#if voiceIsolationUnsupported}
      <p class="text-sm text-danger">{m['voice.noise_suppression_unavailable']()}</p>
    {/if}
  </div>

  <div class="flex flex-col gap-2">
    <RangeField
      id="dfn3-strength"
      testid="dfn3-strength"
      label={m['voice.tuning.strength_label']()}
      icon="uil--filter"
      min={MIN_STRENGTH}
      max={MAX_STRENGTH}
      step={5}
      value={controller.strength}
      displayValue={String(controller.strength)}
      disabled={!isEnhanced}
      oninput={onStrengthInput}
    />
    <p class="text-sm text-muted">{m['voice.tuning.strength_hint']()}</p>
  </div>

  <div class="flex flex-col gap-2">
    <RangeField
      id="mic-input-gain"
      testid="mic-input-gain"
      label={m['voice.tuning.input_gain_label']()}
      icon="uil--microphone"
      min={MIN_INPUT_GAIN}
      max={MAX_INPUT_GAIN}
      step={5}
      value={controller.inputGain}
      displayValue={`${controller.inputGain}%`}
      oninput={onInputGainInput}
    />
    <p class="text-sm text-muted">{m['voice.tuning.input_gain_hint']()}</p>
  </div>

  <div class="flex flex-col gap-2">
    <RangeField
      id="mic-sensitivity"
      testid="mic-sensitivity"
      label={m['voice.tuning.sensitivity_label']()}
      icon="uil--signal-alt-3"
      min={MIN_SENSITIVITY}
      max={MAX_SENSITIVITY}
      step={5}
      value={controller.sensitivity}
      displayValue={controller.sensitivity === 0
        ? m['voice.tuning.sensitivity_off']()
        : String(controller.sensitivity)}
      oninput={onSensitivityInput}
    />
    {#if isRunning}
      <!-- Live mic level against the gate threshold: fill is your current
           level, the marker is where the gate opens. Set sensitivity just
           below where the fill peaks while speaking. -->
      <div
        class="relative h-2 w-full overflow-hidden rounded-full bg-surface-strong"
        role="meter"
        aria-label={m['voice.mic_test.level']()}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={micLevelPct}
      >
        <div class={['h-full', levelFillClass]} style:width={`${micLevelPct}%`}></div>
        {#if gateActive}
          <div
            class="absolute top-0 h-full w-0.5 bg-text/70"
            style:left={`${controller.sensitivity}%`}
          ></div>
        {/if}
      </div>
    {/if}
    <p class="text-sm text-muted">{m['voice.tuning.sensitivity_hint']()}</p>
  </div>

  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-3">
      <span class="font-medium text-text">{m['voice.mic_test.title']()}</span>
      <button
        type="button"
        class="btn-secondary cursor-pointer"
        onclick={toggleTest}
        disabled={isLoading}
      >
        {#if isLoading}
          {m['voice.mic_test.loading']()}
        {:else if isRunning}
          {m['voice.mic_test.stop']()}
        {:else}
          {m['voice.mic_test.start']()}
        {/if}
      </button>
    </div>

    {#if isRunning}
      <!-- The preview follows the selected mode above; switch modes to compare.
           The live input-level meter lives on the sensitivity slider. -->
      <p class="text-sm text-muted">{m['voice.mic_test.headphones_hint']()}</p>
    {/if}

    {#if test.status === 'error'}
      <p class="text-sm text-danger">{m['voice.mic_test.error']()}</p>
    {/if}
  </div>
</div>
