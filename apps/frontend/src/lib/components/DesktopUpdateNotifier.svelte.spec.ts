import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { browserNativeHost } from '$lib/native/browserHost';
import { desktopUpdates } from '$lib/native/desktopUpdates.svelte';
import { installNativeHost, resetNativeHostForTests } from '$lib/native/host';
import type { DesktopUpdateSnapshot, NativeHost } from '$lib/native/types';
import DesktopUpdateNotifier from './DesktopUpdateNotifier.svelte';

const idleMock = vi.hoisted(() => ({ isInAnyCall: false }));

vi.mock('$lib/state/idle.svelte', () => ({ idleState: idleMock }));

const readySnapshot: DesktopUpdateSnapshot = {
  supported: true,
  channel: 'stable',
  phase: 'ready',
  currentVersion: '0.2.0',
  candidateVersion: '0.3.0'
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

describe('DesktopUpdateNotifier', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetNativeHostForTests();
    idleMock.isInAnyCall = false;
    setSnapshot(readySnapshot);
  });

  it('renders nothing for a browser host', async () => {
    setSnapshot({ ...readySnapshot, supported: false });
    const { container } = render(DesktopUpdateNotifier);

    await expect.element(container).not.toHaveTextContent('Update ready');
  });

  it('offers Restart now and Later only when an update is ready', async () => {
    installTestHost();
    render(DesktopUpdateNotifier);

    await expect.element(page.getByText('Update ready')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Restart now' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Later' })).toBeVisible();
  });

  it('keeps Later dismissed for the same candidate but permits a new candidate', async () => {
    const { installDesktopUpdate } = installTestHost();
    render(DesktopUpdateNotifier);

    await userEvent.click(page.getByRole('button', { name: 'Later' }));
    await expect.element(page.getByText('Update ready')).not.toBeInTheDocument();

    setSnapshot({ ...readySnapshot });
    await expect.element(page.getByText('Update ready')).not.toBeInTheDocument();
    expect(installDesktopUpdate).not.toHaveBeenCalled();

    setSnapshot({ ...readySnapshot, candidateVersion: '0.3.1' });
    await expect.element(page.getByText('Update ready')).toBeVisible();
  });

  it('suppresses the prompt during a call without installing automatically', async () => {
    const { installDesktopUpdate } = installTestHost();
    idleMock.isInAnyCall = true;
    const { container } = render(DesktopUpdateNotifier);

    await expect.element(container).not.toHaveTextContent('Update ready');
    expect(installDesktopUpdate).not.toHaveBeenCalled();
  });

  it('installs only after Restart now and disables duplicate invocations while pending', async () => {
    let resolveInstall!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveInstall = resolve;
    });
    const { installDesktopUpdate } = installTestHost(vi.fn(() => pending));
    render(DesktopUpdateNotifier);

    const restart = page.getByRole('button', { name: 'Restart now' });
    await userEvent.click(restart);

    expect(installDesktopUpdate).toHaveBeenCalledTimes(1);
    await expect.element(restart).toBeDisabled();
    resolveInstall();
  });
});
