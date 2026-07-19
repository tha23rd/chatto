import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBrowserServiceWorker } from './registerServiceWorker';

const register = vi.fn();

beforeEach(() => {
  register.mockReset();
  register.mockResolvedValue({ scope: '/' });
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { serviceWorker: { register } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerBrowserServiceWorker', () => {
  it('registers the generated worker in a browser build', async () => {
    await expect(registerBrowserServiceWorker()).resolves.toEqual({ scope: '/' });
    expect(register).toHaveBeenCalledWith('/service-worker.js');
  });

  it('does not register a worker in the native renderer', async () => {
    window.chattoNative = {} as never;
    await expect(registerBrowserServiceWorker()).resolves.toBeNull();
    expect(register).not.toHaveBeenCalled();
  });
});
