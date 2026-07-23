import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import VoiceCallPanelStoryHarness from './VoiceCallPanelStoryHarness.svelte';

/**
 * The Storybook stories mount this harness and finish; the harness only imports
 * `VoiceCallPanel` lazily from `onMount`, so on a fast machine the story test can end — and
 * the harness be torn down — before the import ever resolves, and the panel never mounts at
 * all. On a slow CI runner the import resolves while the harness is still alive but after the
 * test completed, the panel mounts for real, and anything it needs at initialisation that the
 * harness does not provide throws *outside* any test: every story still passes while vitest
 * exits non-zero on an unhandled error.
 *
 * This spec waits for that mount instead of racing it, so the panel's initialisation
 * requirements are checked deterministically on any machine.
 */
describe('VoiceCallPanelStoryHarness', () => {
  it('mounts the lazily imported call panel', async () => {
    const { container } = render(VoiceCallPanelStoryHarness, {
      props: { layout: 'sidebar', scenario: 'screen' }
    });

    // VoiceCallPanel reads the active server connection during initialisation, so a harness
    // that does not provide it cannot mount the panel at all.
    await expect
      .poll(() => q(container, '[data-testid="call-participant-panel"]'))
      .not.toBeNull();
  });
});
