import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import AudioDeviceMenu from './AudioDeviceMenu.svelte';
import type {
  NoiseSuppressionMode,
  NoiseSuppressionStatus
} from '$lib/voice/noiseSuppression.svelte';

// Minimal stand-in for the per-server voice store the menu reads from the
// registry. Only the fields AudioDeviceMenu touches are present; the noise
// suppression section is the surface under test here.
const state = vi.hoisted(() => ({
  voiceCall: {
    audioDevices: [] as MediaDeviceInfo[],
    audioOutputDevices: [] as MediaDeviceInfo[],
    videoDevices: [] as MediaDeviceInfo[],
    selectedDeviceId: null as string | null,
    selectedOutputDeviceId: null as string | null,
    selectedVideoDeviceId: null as string | null,
    setAudioDevice: vi.fn(),
    setAudioOutputDevice: vi.fn(),
    setVideoDevice: vi.fn(),
    noiseSuppression: {
      mode: 'off' as NoiseSuppressionMode,
      status: 'off' as NoiseSuppressionStatus,
      setMode: vi.fn()
    }
  }
}));

// The menu reads its voice store through the route's server scope.
vi.mock('$lib/state/server/scope.svelte', () => ({
  useServerScope: () => ({
    serverId: 'origin',
    connection: {},
    store: { voiceCall: state.voiceCall },
    isCurrent: () => true
  })
}));

function renderMenu() {
  const onclose = vi.fn();
  const result = render(AudioDeviceMenu, {
    props: { anchor: { top: 0, bottom: 0, left: 0 }, onclose }
  });
  return { ...result, onclose };
}

function radios(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[role="menuitemradio"]'));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.voiceCall.noiseSuppression.mode = 'off';
  state.voiceCall.noiseSuppression.status = 'off';
});

describe('AudioDeviceMenu noise suppression section', () => {
  it('always renders the three noise suppression modes', async () => {
    const { container } = renderMenu();

    await expect.element(q(container, '[role="menuitemradio"]')).toBeInTheDocument();
    expect(radios(container)).toHaveLength(3);
    expect(container.textContent).toContain('Standard (browser)');
    expect(container.textContent).toContain('Voice isolation (experimental)');
    expect(container.textContent).toContain('Enhanced (DeepFilterNet3)');
  });

  it('marks exactly the active mode as checked', async () => {
    state.voiceCall.noiseSuppression.mode = 'voice-isolation';
    const { container } = renderMenu();

    await expect.element(q(container, '[role="menuitemradio"][aria-checked="true"]')).toBeInTheDocument();
    const checked = container.querySelectorAll('[role="menuitemradio"][aria-checked="true"]');
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('Voice isolation (experimental)');
  });

  it('calls setMode with the chosen mode and keeps the menu open', async () => {
    const { container, onclose } = renderMenu();

    await expect.element(q(container, '[role="menuitemradio"]')).toBeInTheDocument();
    // Options render in a fixed order: off, voice-isolation, enhanced.
    radios(container)[2].click();

    expect(state.voiceCall.noiseSuppression.setMode).toHaveBeenCalledWith('enhanced');
    expect(onclose).not.toHaveBeenCalled();
  });

  it('surfaces the unavailable status below the options', async () => {
    state.voiceCall.noiseSuppression.status = 'unavailable';
    const { container } = renderMenu();

    await expect.element(q(container, '[role="menuitemradio"]')).toBeInTheDocument();
    expect(container.textContent).toContain('Unavailable in this browser');
  });

  it('shows no status line when the selected mode is healthy', async () => {
    const { container } = renderMenu();

    await expect.element(q(container, '[role="menuitemradio"]')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Unavailable in this browser');
    expect(container.textContent).not.toContain('Loading model…');
  });
});
