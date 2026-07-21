import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import NoiseSuppressionSettings from './NoiseSuppressionSettings.svelte';
import { NoiseSuppressionController } from '$lib/voice/noiseSuppression.svelte';
import { MicTest } from '$lib/voice/micTest.svelte';

function controller() {
  return new NoiseSuppressionController(
    () => {},
    () =>
      ({
        name: 'fake-processor',
        destroy: () => {},
        setSuppressionLevel: () => {},
        setInputGain: () => {},
        setGateThreshold: () => {},
        setNoiseSuppressionEnabled: () => {}
      }) as never,
    () => true
  );
}

describe('NoiseSuppressionSettings', () => {
  it('renders the strength slider and disables it when mode is not enhanced', async () => {
    const c = controller();
    await c.setMode('off');
    const { container } = render(NoiseSuppressionSettings, { props: { controller: c } });
    const slider = q(container, '[data-testid="dfn3-strength"]') as HTMLInputElement;
    expect(slider).not.toBeNull();
    expect(slider.disabled).toBe(true);
  });

  it('enables the slider and updates strength when enhanced', async () => {
    const c = controller();
    await c.setMode('enhanced');
    const { container } = render(NoiseSuppressionSettings, { props: { controller: c } });
    const slider = q(container, '[data-testid="dfn3-strength"]') as HTMLInputElement;
    expect(slider.disabled).toBe(false);
  });

  it('forwards strength-slider changes to the mic test for live retune', async () => {
    const setStrengthSpy = vi.spyOn(MicTest.prototype, 'setStrength');
    const c = controller();
    await c.setMode('enhanced');
    const { container } = render(NoiseSuppressionSettings, { props: { controller: c } });
    const slider = q(container, '[data-testid="dfn3-strength"]') as HTMLInputElement;
    slider.value = '30';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(setStrengthSpy).toHaveBeenCalledWith(30);
    setStrengthSpy.mockRestore();
  });

  it('stops the mic test on unmount so the microphone is released', async () => {
    const stopSpy = vi.spyOn(MicTest.prototype, 'stop');
    const c = controller();
    await c.setMode('enhanced');
    const rendered = render(NoiseSuppressionSettings, { props: { controller: c } });
    rendered.unmount();
    expect(stopSpy).toHaveBeenCalled();
    stopSpy.mockRestore();
  });
});
