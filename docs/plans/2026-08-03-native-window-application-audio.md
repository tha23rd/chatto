# Native Window Application Audio Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Windows Tauri client share only the selected application's audio with a window capture, while preserving entire-display system audio and warning when requested application audio is absent.

**Architecture:** Keep display media in the shared Svelte/LiveKit renderer and use the typed `NativeHost` seam to add WebView2's `windowAudio: "window"` hint and reject any broader system-audio fallback before publication. Preserve video-only shares when audio is absent, report that degraded result through a localized warning toast, and keep the FDR, ADR, public guide, runtime inventory, and Windows acceptance contract aligned.

**Tech Stack:** Svelte 5 runes, TypeScript, Vitest, Paraglide i18n, LiveKit JavaScript SDK, Tauri 2, Windows WebView2, Astro/Starlight documentation, mise, pnpm.

---

### Task 1: Change the native capture capability to application audio

**Files:**

- Modify: `apps/frontend/src/lib/native/tauriHost.spec.ts`
- Modify: `apps/frontend/src/lib/native/host.spec.ts`
- Modify: `apps/frontend/src/lib/native/types.ts`
- Modify: `apps/frontend/src/lib/native/browserHost.ts`
- Modify: `apps/frontend/src/lib/native/tauriHost.ts`
- Modify: `apps/frontend/src/lib/state/server/voiceCall.svelte.spec.ts`
- Modify: `apps/frontend/src/lib/state/server/voiceCall.svelte.ts`
- Modify: `apps/frontend/src/lib/state/server/screenShareQuality.ts`

**Step 1: Write failing native-host contract tests**

Change the expected capability from `windowSystemAudio` to
`windowApplicationAudio`, advance the expected native API version from `5` to
`6`, and require an audio-enabled capture to reach the binding as:

```ts
expect(native.getDisplayMedia).toHaveBeenCalledWith({
  audio,
  video,
  systemAudio: 'include',
  windowAudio: 'window'
});
```

Rename the voice-call test and native-host fixture capability to application
audio so the consumer test fails until the production contract changes.

**Step 2: Run the focused tests and confirm the red state**

Run:

```bash
mise x -- pnpm --filter chatto-frontend exec vitest --run \
  src/lib/native/host.spec.ts \
  src/lib/native/tauriHost.spec.ts \
  src/lib/state/server/voiceCall.svelte.spec.ts \
  -t 'application audio|capability-free browser host'
```

Expected: FAIL because the production contract still exposes
`windowSystemAudio`, API version 5, and `windowAudio: "system"`.

**Step 3: Implement the minimal host-contract change**

- Set `NATIVE_HOST_API_VERSION` to `6`.
- Rename the capability to `windowApplicationAudio`.
- Advertise it only from the Tauri host.
- Set `windowAudio` to `"window"` when capture audio is enabled and to
  `"exclude"` otherwise.
- After capture, inspect the returned video track's `displaySurface`. For a
  selected window, retain only an audio track whose Chromium label is exactly
  `Application Audio`; stop and remove system or unrecognised tracks before
  LiveKit receives the stream. Preserve system audio for an entire display. If
  display-surface metadata is unavailable, fail closed by retaining only
  positively identified application audio.
- Select the manual native publication path through the renamed capability.
- Update comments to describe selected-application audio rather than system
  audio.

Do not change the `systemAudio` option supplied by the screen-share quality
resolver; it remains the entire-display audio preference.

**Step 4: Run the focused tests and confirm the green state**

Run the same focused Vitest command.

Expected: all selected tests pass.

Add focused adapter cases covering application audio retained for a selected
window, system fallback stopped and removed for a selected window, system audio
retained for an entire display, and `windowAudio: "exclude"` when audio is
false or omitted.

**Step 5: Commit the capture contract**

```bash
git add apps/frontend/src/lib/native/host.spec.ts \
  apps/frontend/src/lib/native/tauriHost.spec.ts \
  apps/frontend/src/lib/native/types.ts \
  apps/frontend/src/lib/native/browserHost.ts \
  apps/frontend/src/lib/native/tauriHost.ts \
  apps/frontend/src/lib/state/server/screenShareQuality.ts \
  apps/frontend/src/lib/state/server/voiceCall.svelte.spec.ts \
  apps/frontend/src/lib/state/server/voiceCall.svelte.ts
git commit -m "fix(desktop): capture selected application audio"
```

### Task 2: Warn when requested application audio is absent

**Files:**

- Modify: `apps/frontend/src/lib/state/server/voiceCall.svelte.spec.ts`
- Modify: `apps/frontend/src/lib/state/server/voiceCall.svelte.ts`
- Modify: `apps/frontend/src/lib/i18n/messages.spec.ts`
- Modify: `apps/frontend/messages/en-GB/voice.json`
- Modify: `apps/frontend/messages/de-DE/voice.json`
- Modify: `apps/frontend/messages/de-AT/voice.json`
- Modify: `apps/frontend/messages/de-CH/voice.json`
- Modify: `apps/frontend/messages/nl-NL/voice.json`
- Modify: `apps/frontend/messages/nl-BE/voice.json`
- Modify: `apps/frontend/messages/sv-SE/voice.json`
- Modify: `apps/frontend/messages/fr-FR/voice.json`
- Modify: `apps/frontend/messages/fr-CA/voice.json`
- Modify: `apps/frontend/messages/es-ES/voice.json`
- Modify: `apps/frontend/messages/es-419/voice.json`
- Modify: `apps/frontend/messages/pt-BR/voice.json`
- Modify: `apps/frontend/messages/pt-PT/voice.json`
- Modify: `apps/frontend/messages/nb-NO/voice.json`
- Modify: `apps/frontend/messages/pl-PL/voice.json`
- Modify: `apps/frontend/messages/uk-UA/voice.json`
- Modify: `apps/frontend/messages/ja-JP/voice.json`
- Modify: `apps/frontend/messages/eo/voice.json`
- Regenerate: `apps/frontend/src/lib/i18n/messages.ts`
- Regenerate: `apps/frontend/src/lib/paraglide/**`

**Step 1: Write the failing degraded-capture test**

Extend the toast mock with `warning`. Add a native capture fixture that returns
one video track and no audio tracks, then assert:

```ts
expect(state.isScreenShareEnabled).toBe(true);
expect(lastRoom?.localParticipant.publishTrack).toHaveBeenCalledOnce();
expect(toastMocks.warning).toHaveBeenCalledWith(
  'Application audio was not shared. The window is still being shared without sound.'
);
expect(toastMocks.error).not.toHaveBeenCalled();
```

Also assert in `messages.spec.ts` that the British English message facade
returns the exact approved warning.

**Step 2: Run the focused test and confirm the red state**

Run:

```bash
mise x -- pnpm --filter chatto-frontend exec vitest --run \
  src/lib/state/server/voiceCall.svelte.spec.ts \
  src/lib/i18n/messages.spec.ts \
  -t 'without application audio|application audio was not shared'
```

Expected: FAIL because no warning message or warning notification exists.

**Step 3: Add the localized warning contract**

Add `voice.screen_share_audio_unavailable` to the British English source and
every complete translated voice catalogue. Keep `en-US` sparse because the
British English sentence has no regional spelling difference.

Compile the catalogues:

```bash
mise x -- pnpm --filter chatto-frontend run paraglide
```

Expected: Paraglide completes and regenerates the typed facade.

**Step 4: Implement the degraded-capture result**

Make `publishNativeScreenShare` return whether it published an audio track.
After a successful native video publication, and only while the same room is
still current, call:

```ts
toast.warning(m['voice.screen_share_audio_unavailable']());
```

when audio was requested but absent. Keep `isScreenShareEnabled` true and do
not unpublish the video.

**Step 5: Run the focused tests and confirm the green state**

Run the same focused Vitest command.

Expected: both the video-only warning case and message-facade assertion pass.

**Step 6: Commit the degraded-audio experience**

```bash
git add apps/frontend/src/lib/state/server/voiceCall.svelte.spec.ts \
  apps/frontend/src/lib/state/server/voiceCall.svelte.ts \
  apps/frontend/src/lib/i18n/messages.spec.ts \
  apps/frontend/messages \
  apps/frontend/src/lib/i18n/messages.ts \
  apps/frontend/src/lib/paraglide
git commit -m "fix(voice): report missing application audio"
```

### Task 3: Align feature, architecture, public, and acceptance documentation

**Files:**

- Modify: `docs/fdr/FDR-016-voice-calls.md`
- Modify: `docs/adr/ADR-900-windows-desktop-client.md`
- Modify: `docs/architecture/runtime-components.md`
- Modify: `apps/docs-website/src/content/docs/guides/infrastructure/voice-calls.mdx`
- Modify: `apps/desktop/tests/windows-acceptance.md`

**Step 1: Rewrite the current feature and architecture facts**

- Set FDR-016's `Last reviewed` date to `2026-08-03`.
- Describe selected-window audio as the selected application's process-tree
  audio, with entire-display capture retaining system audio.
- Replace the FDR's system-audio rationale with the privacy boundary: never
  widen application capture silently, and warn while retaining video when
  audio is absent.
- Amend ADR-900's WebView2 media decision to use renderer-owned Chromium
  application-loopback capture rather than reserving all per-process capture
  for a future native subsystem.
- Update both client-runtime inventory rows to say application-audio tracks.
- Update the public guide with the picker and degraded-audio behavior.

**Step 2: Rewrite the native Windows acceptance case**

The selected-window case must require:

- a recorded Windows and WebView2 version;
- a selected game/application window;
- the picker application-audio control enabled;
- remote video plus selected-application audio;
- unrelated system audio and remote Chatto playback absent; and
- video continuing with a visible warning when no audio track is returned.

Keep the status `UNRUN`; documentation changes are not native evidence. Update
the decision gate from “selected-window system audio” to
“selected-window application audio”.

**Step 3: Validate the documentation diff**

Run:

```bash
git diff --check
rg -n -i 'selected.window.*system audio|windowSystemAudio|all Windows output' \
  docs apps/docs-website apps/desktop apps/frontend/src/lib/native
```

Expected: no whitespace errors and no stale in-scope description of
selected-window system-wide capture outside historical plan records.

Check the edited runtime-inventory links exist and confirm no edited prose
paragraph exceeds 100 words without a clear reason.

**Step 4: Commit the documentation update**

```bash
git add docs/fdr/FDR-016-voice-calls.md \
  docs/adr/ADR-900-windows-desktop-client.md \
  docs/architecture/runtime-components.md \
  apps/docs-website/src/content/docs/guides/infrastructure/voice-calls.mdx \
  apps/desktop/tests/windows-acceptance.md
git commit -m "docs(voice): define application-scoped window audio"
```

### Task 4: Verify the implementation and repository contracts

**Files:**

- Verify only; no planned source changes

**Step 1: Run the Svelte analyzer**

Run the Svelte autofixer against the complete edited
`apps/frontend/src/lib/state/server/voiceCall.svelte.ts` file.

Expected: zero remaining issues or suggestions.

**Step 2: Run focused frontend regression tests**

Run:

```bash
mise x -- pnpm --filter chatto-frontend exec vitest --run \
  src/lib/native/host.spec.ts \
  src/lib/native/tauriHost.spec.ts \
  src/lib/state/server/screenShareQuality.spec.ts \
  src/lib/state/server/voiceCall.svelte.spec.ts \
  src/lib/i18n/messages.spec.ts
```

Expected: all focused test files pass with zero failures.

**Step 3: Run frontend static verification**

Run sequentially:

```bash
mise x -- pnpm --filter chatto-frontend run check
mise x -- pnpm --filter chatto-frontend run lint
```

Expected: Svelte/TypeScript checking and ESLint complete without warnings or
errors.

**Step 4: Verify documentation and repository policy**

Run:

```bash
mise x -- pnpm --filter docs-website build
mise license-check
git diff --check main-native...HEAD
```

Expected: the public documentation build and REUSE check pass, and the complete
branch diff has no whitespace errors.

**Step 5: Review the requirement checklist and diff**

Confirm from the final diff that:

- window capture requests application audio;
- screen capture still requests system audio;
- no automatic system-audio fallback exists;
- missing audio keeps video active and warns;
- capability names and version agree across hosts and tests;
- all complete locale catalogues contain the warning; and
- current behavior is consistent across the FDR, ADR, public guide, inventory,
  and acceptance matrix.

**Step 6: Commit any verification-only formatting or generated changes**

If verification updates tracked generated output or formatting, commit only
those reviewed changes:

```bash
git add <reviewed-generated-or-formatting-files>
git commit -m "chore(frontend): refresh application audio artifacts"
```

### Task 5: Verify the packaged Windows behavior

**Files:**

- Verify only; record non-sensitive evidence in
  `apps/desktop/tests/windows-acceptance.md` only when the test is actually run

**Step 1: Build and install the packaged client on native Windows**

Use the repository-managed Windows desktop build and package verification
workflow. Record the Git commit, Windows build, WebView2 runtime, installer
hash, and other required environment fields without recording window titles,
server URLs, account names, room names, or media content.

Expected: the packaged client launches with the shared renderer and native
host API version 6.

**Step 2: Verify a selected game/application window**

Join from a second client, enable **Share audio**, select a game/application
window, enable the picker control for application audio, and play audio in both
the selected application and an unrelated application.

Expected: the receiver sees only the selected window, hears the selected
application, and does not hear unrelated system output or Chatto call playback.

**Step 3: Verify the degraded path**

Repeat a window share without enabling picker audio, or with a source/runtime
that returns no audio track.

Expected: the receiver continues seeing the window without sound, and the
presenter sees the localized missing-application-audio warning.

**Step 4: Verify entire-display behavior**

Select an entire display with **Share audio** enabled.

Expected: the receiver gets the display video and Windows system audio while
Chatto's own playback is filtered where WebView2 honors `restrictOwnAudio`.

**Step 5: Record honest acceptance status**

Set only the cases actually exercised to `PASS`, `FAIL`, or `BLOCKED` and add
non-sensitive evidence. Leave every unperformed case `UNRUN`. A Linux build,
unit test, or mocked media stream is not native Windows evidence.
