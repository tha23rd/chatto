import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserNativeHost } from '$lib/native/browserHost';
import { NativeServerOrigins } from './nativeOrigins';

function trackLeases() {
  const events: string[] = [];
  const spy = vi.spyOn(browserNativeHost, 'registerServerOrigin').mockImplementation((url) => {
    events.push(`acquire ${url}`);
    return () => {
      events.push(`release ${url}`);
    };
  });
  return { events, spy };
}

describe('NativeServerOrigins', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('holds one lease per server', () => {
    const { events } = trackLeases();
    const origins = new NativeServerOrigins();

    origins.register('a', 'https://a.example');
    origins.register('b', 'https://b.example');
    origins.release('a');

    expect(events).toEqual([
      'acquire https://a.example',
      'acquire https://b.example',
      'release https://a.example'
    ]);
  });

  it('ignores a repeated registration of the same origin', () => {
    const { events } = trackLeases();
    const origins = new NativeServerOrigins();

    origins.register('a', 'https://a.example');
    origins.register('a', 'https://a.example');

    expect(events).toEqual(['acquire https://a.example']);
  });

  // The host reference-counts per origin, so moving a server between two URLs
  // that share one origin must not let the count reach zero in between.
  it('acquires the new lease before releasing the old one when a URL changes', () => {
    const { events } = trackLeases();
    const origins = new NativeServerOrigins();

    origins.register('a', 'https://a.example');
    origins.register('a', 'https://b.example');

    expect(events).toEqual([
      'acquire https://a.example',
      'acquire https://b.example',
      'release https://a.example'
    ]);
  });

  it('releases a server only once, and tolerates an unknown server', () => {
    const { events } = trackLeases();
    const origins = new NativeServerOrigins();

    origins.register('a', 'https://a.example');
    origins.release('a');
    origins.release('a');
    origins.release('never-registered');

    expect(events).toEqual(['acquire https://a.example', 'release https://a.example']);
  });
});
