import '../../../app.css';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import SoundboardTrimmerTestHarness from './SoundboardTrimmerTestHarness.svelte';

/** A silent 10-second mono clip; only its duration matters for trim maths. */
function clip(seconds = 10): AudioBuffer {
  const ctx = new AudioContext();
  try {
    return ctx.createBuffer(1, Math.round(seconds * 44100), 44100);
  } finally {
    void ctx.close();
  }
}

function band(): HTMLElement {
  return page.getByRole('slider', { name: 'Move selection' }).element() as HTMLElement;
}

function pointer(type: string, clientX: number, target: Element) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      clientX,
      clientY: 24
    })
  );
}

function key(name: string, target: Element) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
}

describe('SoundboardTrimmer', () => {
  it('slides the whole selection when the band is dragged', async () => {
    await page.viewport(600, 400);
    render(SoundboardTrimmerTestHarness, { buffer: clip(), start: 0, end: 5 });

    const selection = page.getByTestId('selection');
    await expect.element(selection).toHaveTextContent('0.000–5.000');

    const bandEl = band();
    const rect = (bandEl.parentElement as HTMLElement).getBoundingClientRect();
    // Grab the band at the 2.5s mark and drag that grab point to 5s, which
    // should shift the whole 5s window to 2.5s–7.5s.
    pointer('pointerdown', rect.left + rect.width * 0.25, bandEl);
    pointer('pointermove', rect.left + rect.width * 0.5, bandEl);
    pointer('pointerup', rect.left + rect.width * 0.5, bandEl);

    await expect.element(selection).toHaveTextContent('2.500–7.500');
  });

  it('nudges the selection with the arrow keys without changing its span', async () => {
    await page.viewport(600, 400);
    render(SoundboardTrimmerTestHarness, { buffer: clip(), start: 1, end: 3 });

    key('ArrowRight', band());
    await expect.element(page.getByTestId('selection')).toHaveTextContent('1.050–3.050');

    key('ArrowLeft', band());
    await expect.element(page.getByTestId('selection')).toHaveTextContent('1.000–3.000');
  });

  it('parks the selection flush against each clip edge instead of shrinking it', async () => {
    await page.viewport(600, 400);
    render(SoundboardTrimmerTestHarness, { buffer: clip(), start: 1, end: 3 });

    key('End', band());
    await expect.element(page.getByTestId('selection')).toHaveTextContent('8.000–10.000');

    key('Home', band());
    await expect.element(page.getByTestId('selection')).toHaveTextContent('0.000–2.000');
  });

  it('still trims a single edge when a handle is dragged', async () => {
    await page.viewport(600, 400);
    render(SoundboardTrimmerTestHarness, { buffer: clip(), start: 0, end: 5 });

    const startHandle = page.getByRole('slider', { name: 'Trim start' }).element();
    key('ArrowRight', startHandle);

    await expect.element(page.getByTestId('selection')).toHaveTextContent('0.050–5.000');
  });
});
