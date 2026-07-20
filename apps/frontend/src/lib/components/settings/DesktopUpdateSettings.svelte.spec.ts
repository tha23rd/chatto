import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { browserNativeHost } from '$lib/native/browserHost';
import { desktopUpdates } from '$lib/native/desktopUpdates.svelte';
import { installNativeHost, resetNativeHostForTests } from '$lib/native/host';
import type { DesktopUpdateSnapshot, NativeHost } from '$lib/native/types';
import { getToasts, toast } from '$lib/ui/toast';
import DesktopUpdateSettings from './DesktopUpdateSettings.svelte';

const idleMock = vi.hoisted(() => ({ isInAnyCall: false }));

vi.mock('$lib/state/idle.svelte', () => ({ idleState: idleMock }));
vi.mock('$lib/state/userSettings.svelte', () => ({
  getUserSettings: () => ({ effectiveTimezone: undefined, effectiveHour12: undefined })
}));

const stableIdle: DesktopUpdateSnapshot = {
  supported: true,
  channel: 'stable',
  phase: 'idle',
  currentVersion: '0.2.0'
};

function setSnapshot(snapshot: DesktopUpdateSnapshot): void {
  desktopUpdates.snapshot = snapshot;
  flushSync();
}

function installTestHost(installDesktopUpdate = vi.fn(async () => {})): {
  host: NativeHost;
  installDesktopUpdate: ReturnType<typeof vi.fn>;
} {
  const host: NativeHost = {
    ...browserNativeHost,
    kind: 'tauri',
    capabilities: { ...browserNativeHost.capabilities, desktopUpdates: true },
    installDesktopUpdate
  };
  installNativeHost(host);
  return { host, installDesktopUpdate };
}

describe('DesktopUpdateSettings', () => {
  beforeEach(() => {
    resetNativeHostForTests();
    toast.clear();
    idleMock.isInAnyCall = false;
    setSnapshot(stableIdle);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetNativeHostForTests();
    toast.clear();
  });

  it('renders nothing for a browser host', async () => {
    setSnapshot({ ...stableIdle, supported: false });
    const { container } = render(DesktopUpdateSettings);

    await expect.element(container).not.toHaveTextContent('Desktop updates');
  });

  it('renders the current Stable state and an unavailable last check', async () => {
    installTestHost();
    render(DesktopUpdateSettings);

    await expect.element(page.getByText('Current version: 0.2.0')).toBeVisible();
    await expect.element(page.getByRole('radio', { name: /Stable/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect.element(page.getByText(/^Status: Up to date$/)).toBeVisible();
    await expect.element(page.getByText('Not checked yet')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Check now' })).toBeVisible();
  });

  it('renders known and unknown download progress', async () => {
    installTestHost();
    setSnapshot({
      ...stableIdle,
      phase: 'downloading',
      candidateVersion: '0.3.0',
      downloadedBytes: 50,
      totalBytes: 100
    });
    render(DesktopUpdateSettings);

    await expect.element(page.getByText(/Downloading update… 50%/)).toBeVisible();

    setSnapshot({
      ...stableIdle,
      phase: 'downloading',
      candidateVersion: '0.3.0',
      downloadedBytes: 50
    });

    await expect.element(page.getByText('Downloading update…')).toBeVisible();
  });

  it('shows a ready version and restarts directly outside a call', async () => {
    let resolveInstall!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveInstall = resolve;
    });
    const { installDesktopUpdate } = installTestHost(vi.fn(() => pending));
    setSnapshot({
      ...stableIdle,
      phase: 'ready',
      candidateVersion: '0.3.0'
    });
    render(DesktopUpdateSettings);

    await expect.element(page.getByText('Version 0.3.0 is ready to install.')).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Restart now' }));

    expect(installDesktopUpdate).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole('button', { name: 'Restart now' })).toBeDisabled();
    resolveInstall();
  });

  it('saves Stable immediately', async () => {
    installTestHost();
    setSnapshot({ ...stableIdle, channel: 'nightly', currentVersion: '0.3.0-nightly.1' });
    const setChannel = vi
      .spyOn(desktopUpdates, 'setChannel')
      .mockResolvedValue({ ...stableIdle, channel: 'stable' });
    render(DesktopUpdateSettings);

    await userEvent.click(page.getByRole('radio', { name: /Stable/ }));

    expect(setChannel).toHaveBeenCalledWith('stable');
  });

  it('requires confirmation before saving Nightly and cancellation leaves Stable selected', async () => {
    installTestHost();
    const setChannel = vi.spyOn(desktopUpdates, 'setChannel').mockResolvedValue(stableIdle);
    render(DesktopUpdateSettings);

    await userEvent.click(page.getByRole('radio', { name: /Nightly/ }));
    await expect.element(page.getByRole('dialog', { name: 'Switch to Nightly?' })).toBeVisible();
    expect(setChannel).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole('button', { name: 'Cancel' }));
    await expect.element(page.getByRole('radio', { name: /Stable/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(setChannel).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole('radio', { name: /Nightly/ }));
    await userEvent.click(page.getByRole('button', { name: 'Switch to Nightly' }));
    expect(setChannel).toHaveBeenCalledWith('nightly');
  });

  it('explains when Stable is waiting to supersede the installed Nightly', async () => {
    installTestHost();
    setSnapshot({
      ...stableIdle,
      currentVersion: '0.3.0-nightly.20260719.1',
      lastCheckedAt: Date.parse('2026-07-19T18:00:00Z')
    });
    render(DesktopUpdateSettings);

    await expect.element(page.getByText('Waiting for Stable')).toBeVisible();
    await expect.element(page.getByText(/Chatto will not downgrade/)).toBeVisible();
    await expect.element(page.getByText(/^Last checked .*2026/)).toBeVisible();
  });

  it('keeps a background failure quiet while rendering its localized state', async () => {
    installTestHost();
    setSnapshot({ ...stableIdle, phase: 'failed', errorCode: 'network' });
    render(DesktopUpdateSettings);

    await expect.element(page.getByText(/^Status: Update failed$/)).toBeVisible();
    await expect.element(page.getByText(/Could not reach the update service/)).toBeVisible();
    expect(getToasts()).toHaveLength(0);
  });

  it('toasts only the result of an explicit manual check', async () => {
    installTestHost();
    const checkNow = vi.spyOn(desktopUpdates, 'checkNow');
    checkNow.mockResolvedValueOnce(stableIdle).mockResolvedValueOnce({
      ...stableIdle,
      phase: 'failed',
      errorCode: 'network'
    });
    render(DesktopUpdateSettings);

    await userEvent.click(page.getByRole('button', { name: 'Check now' }));
    expect(getToasts().map((item) => item.message)).toContain('You are up to date.');

    await userEvent.click(page.getByRole('button', { name: 'Check now' }));
    expect(getToasts().map((item) => item.message)).toContain('Could not check for updates.');
  });

  it('warns before an explicit restart disconnects an active call', async () => {
    const { installDesktopUpdate } = installTestHost();
    idleMock.isInAnyCall = true;
    setSnapshot({ ...stableIdle, phase: 'ready', candidateVersion: '0.3.0' });
    render(DesktopUpdateSettings);

    await userEvent.click(page.getByRole('button', { name: 'Restart now' }));
    await expect
      .element(page.getByRole('dialog', { name: 'Restart and leave the call?' }))
      .toBeVisible();
    expect(installDesktopUpdate).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole('button', { name: 'Restart and leave' }));
    expect(installDesktopUpdate).toHaveBeenCalledTimes(1);
  });
});
