import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { desktopEnvironment, frontendFallback } from './run-desktop.mjs';

describe('desktopEnvironment', () => {
  it('adds desktop build markers without dropping the caller environment', () => {
    assert.deepEqual(
      desktopEnvironment({ PATH: '/tools', CHATTO_BUILD_VERSION: '0.5.0-test' }),
      {
        PATH: '/tools',
        CHATTO_BUILD_VERSION: '0.5.0-test',
        CHATTO_FRONTEND_TARGET: 'desktop',
        VITE_CHATTO_DESKTOP: '1'
      }
    );
  });

  it('overrides stale target markers', () => {
    assert.deepEqual(
      desktopEnvironment({
        CHATTO_FRONTEND_TARGET: 'web',
        VITE_CHATTO_DESKTOP: '0'
      }),
      {
        CHATTO_FRONTEND_TARGET: 'desktop',
        VITE_CHATTO_DESKTOP: '1'
      }
    );
  });
});

describe('frontendFallback', () => {
  it('emits the index document Tauri expects for desktop builds', () => {
    assert.equal(frontendFallback('desktop'), 'index.html');
  });

  it('preserves the existing web-server fallback', () => {
    assert.equal(frontendFallback('web'), '200.html');
    assert.equal(frontendFallback(undefined), '200.html');
  });
});
