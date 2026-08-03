/**
 * Lazy accessor for `livekit-client`.
 *
 * The LiveKit SDK is large and only needed once someone joins a call, so it
 * must stay a dynamic import: a static one pulls it into the initial bundle
 * and `scripts/check-bundle-size.mjs` fails the build. Everything that needs
 * LiveKit *values* at runtime (enums such as `Track.Source`, classes such as
 * `Room`) goes through here; type-only uses should import from
 * `livekit-client` directly with `import type`, which erases at compile time.
 */

export type LiveKitModule = typeof import('livekit-client');

let liveKitModule: LiveKitModule | null = null;
let liveKitModulePromise: Promise<LiveKitModule> | null = null;

/** Loads the SDK once per process and caches it for synchronous access. */
export async function loadLiveKit(): Promise<LiveKitModule> {
  liveKitModulePromise ??= import('livekit-client')
    .then((module) => {
      liveKitModule = module;
      return module;
    })
    .catch((error: unknown) => {
      liveKitModulePromise = null;
      throw error;
    });
  return liveKitModulePromise;
}

/**
 * Returns the already-loaded SDK. Throws when called before `loadLiveKit()`
 * has resolved, which only happens on paths that run outside an active call.
 */
export function getLoadedLiveKit(): LiveKitModule {
  if (!liveKitModule) {
    throw new Error('LiveKit must be loaded before using an active call');
  }
  return liveKitModule;
}

/** Whether the SDK is loaded, for callers that must degrade instead of throw. */
export function isLiveKitLoaded(): boolean {
  return liveKitModule !== null;
}
