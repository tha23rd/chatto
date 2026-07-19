# Windows DeepFilterNet3 Support Design

**Date:** 2026-07-19
**Status:** Approved

## Purpose

Make Chatto's existing Enhanced (DeepFilterNet3) microphone noise suppression
work in the packaged Windows client without changing the shared web client's
runtime policy or introducing a second media-processing implementation.

## Root Cause

The Windows client already bundles the checksum-pinned DeepFilterNet3 model and
WebAssembly runtime, and the current WebView2 runtime supports `AudioContext`,
`AudioWorkletNode`, and WebAssembly. The complete processor pipeline succeeds
inside WebView2 when the frontend is served from the development HTTP origin.

The packaged application fails when `deepfilternet3-noise-filter` calls
`audioContext.audioWorklet.addModule()` with a generated `blob:` URL. WebView2
applies that AudioWorklet load to the Tauri renderer's `script-src` directive,
which currently permits only `'self'` and `'wasm-unsafe-eval'`. Although the
native policy already permits blob-backed workers through `worker-src`, the
worklet module is therefore rejected with `AbortError: Unable to load a
worklet's module`.

The UI's existing "Unavailable in this browser" status is a generic fallback
for unsupported APIs and processor initialization failures. In this case it
describes a native policy failure, not a missing WebView2 capability.

## Decision

Allow `blob:` in the packaged Windows renderer's `script-src` directive. Keep
the exception native-only in `apps/desktop/src-tauri/tauri.conf.json`; do not
change the web image's CSP or the shared Svelte noise-suppression controller.

This is the smallest change that follows the third-party processor's supported
loading path. Version 1.3.0 of `deepfilternet3-noise-filter` embeds its worklet
source and does not expose an option for a separately hosted same-origin
worklet module.

The resulting native directive will retain `'self'` and
`'wasm-unsafe-eval'` and add `blob:`. The existing `worker-src 'self' blob:`
directive remains unchanged.

## Security Boundary

The exception broadens the set of script URLs that trusted bundled renderer
code may create and load. It does not permit remote HTTP(S) scripts, inline
scripts, arbitrary top-level navigation, remote frames, shell access, or file
system access. Tauri continues to add hashes for its generated initialization
scripts, and the host continues to deny navigation away from packaged content.

The exception is acceptable for the Windows POC because the selected processor
requires a blob-backed AudioWorklet and the privileged renderer contains only
bundled Chatto code. If Chatto later promotes enhanced suppression from
experimental to stable, it should re-evaluate whether the dependency exposes a
same-origin worklet URL or whether maintaining a narrow upstream package change
is justified.

## Alternatives Considered

### Patch or fork the processor package

Chatto could modify the dependency to emit a standalone worklet asset and load
it from a same-origin URL. That would preserve the narrower `script-src`, but
the current package has no configuration seam for this. A patch or fork would
make dependency upgrades and upstream synchronization more difficult than the
native-only policy change.

### Implement native noise suppression

A Rust/C++ processor outside WebView2 could provide more native control, but it
would require a separate capture, DSP, and LiveKit integration path. That is a
large divergence from the shared web client and is not justified for the POC.

## Upstream Integration

The implementation changes only the Tauri CSP contract and desktop-specific
tests, plus the existing FDR documentation. It does not change shared Svelte
components, LiveKit state, server APIs, or the normal web build. This keeps the
merge-conflict surface with upstream frontend work minimal.

## Verification

Automated verification will:

- assert that the native `script-src` permits `blob:` while retaining `'self'`
  and `'wasm-unsafe-eval'`;
- assert that the existing `worker-src 'self' blob:` policy remains present;
- run the existing frontend noise-suppression controller and menu tests;
- run the desktop Rust configuration tests and normal static checks.

Native Windows verification will build a packaged-protocol diagnostic client,
load the bundled model and WebAssembly assets through `http://tauri.localhost`,
initialize the blob-backed AudioWorklet, and confirm that the processor returns
a live processed audio track. The final release build must also complete with
the Windows toolchain before the PR is considered ready.
