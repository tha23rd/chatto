import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowNativeServerOriginForProbe, getNativeClient, isNativeClient } from './client';

beforeEach(() => {
  vi.stubGlobal('window', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('native client detection', () => {
  it('is absent in ordinary browser contexts', () => {
    expect(getNativeClient()).toBeNull();
    expect(isNativeClient()).toBe(false);
  });

  it('authorizes only the normalized probe origin through the bridge', () => {
    const allow = vi.fn();
    window.chattoNative = { allowServerOriginForProbe: allow } as never;
    allowNativeServerOriginForProbe('https://chat.example/path?q=1');
    expect(allow).toHaveBeenCalledWith('https://chat.example');
  });
});
