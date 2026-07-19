# Windows Desktop Auto-Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add secure Stable and opt-in Nightly automatic updates to Chatto's Windows desktop client, with background download, user-controlled restart, signed release artifacts, and fail-closed channel publication.

**Architecture:** A Rust-owned Tauri updater manager exposes only typed Chatto commands and state events through the existing `NativeHost` boundary. GitHub Releases stores immutable signed NSIS assets, while CI atomically advances small Stable/Nightly JSON manifests in an S3-compatible bucket served as `updates.chatto.run`; the renderer owns presentation and scheduling but cannot choose arbitrary endpoints, signatures, or downgrade behavior.

**Tech Stack:** Rust 2021, Tauri 2, `tauri-plugin-updater` 2.10.1, Svelte 5, TypeScript, Vitest, Paraglide, PowerShell, Node test runner, GitHub Actions, Azure Artifact Signing, S3-compatible object storage.

---

## Constraints And Prerequisites

- Work in `.claude/worktrees/desktop-auto-update` on `feat/desktop-auto-update`.
- Follow `apps/desktop/AGENTS.md` and `apps/frontend/AGENTS.md`.
- Use @superpowers:test-driven-development for every behavior change.
- Use @svelte-code-writer and @svelte-core-bestpractices for every `.svelte` or `.svelte.ts` edit; run the Svelte autofixer on each edited Svelte file.
- Use @fdr and @adr for the targeted FDR-027 and ADR-052 updates.
- Use @chatto-live-verify for the browser-visible Settings state, then record the Windows-only updater acceptance cases that cannot run in this Linux environment.
- The local Linux host lacks the WebKit/GTK/DBus development packages needed to compile the Tauri Rust host. `mise test-desktop` currently passes 5 Node workflow tests and 148 frontend tests before Cargo fails while locating `dbus-1`. Never report local Rust verification as passing; obtain the Windows signal from GitHub Actions.
- Before merging, configure the protected `desktop-release` GitHub environment with:
  - variable `CHATTO_DESKTOP_UPDATER_PUBLIC_KEY`;
  - secret `TAURI_SIGNING_PRIVATE_KEY` and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
  - Azure OIDC variables/secrets required by `azure/login` plus Artifact Signing endpoint, account, and profile variables;
  - S3-compatible update-store endpoint, bucket, region, access-key secrets, and public base URL `https://updates.chatto.run`.
- Never generate the production updater key without a separately verified backup and rotation/recovery procedure. PR builds use a checked-in inert development public key; release workflows require and inject the production public key.

### Task 1: Define The Typed Desktop Update Boundary

**Files:**
- Modify: `apps/frontend/src/lib/native/types.ts`
- Modify: `apps/frontend/src/lib/native/browserHost.ts`
- Modify: `apps/frontend/src/lib/native/tauriHost.ts`
- Modify: `apps/frontend/src/lib/native/host.spec.ts`
- Modify: `apps/frontend/src/lib/native/tauriHost.spec.ts`

**Step 1: Write failing adapter tests**

Add tests that require:

- `NativeCapabilities.desktopUpdates` to be false in the browser and true in Tauri;
- the channel union to accept only `stable | nightly`;
- typed snapshots with `idle | checking | downloading | ready | failed` states;
- Tauri bindings for `getDesktopUpdateState`, `setDesktopUpdateChannel`, `checkForDesktopUpdate`, `installDesktopUpdate`, and `onDesktopUpdateState`;
- browser implementations to return an unsupported snapshot/no-op subscription and reject mutating update operations.

Run:

```bash
mise x -- pnpm --filter chatto-frontend exec vitest --run src/lib/native/host.spec.ts src/lib/native/tauriHost.spec.ts
```

Expected: FAIL because update capability, types, and bindings do not exist.

**Step 2: Implement the minimal boundary**

Add these public concepts to `types.ts`:

```ts
export type DesktopUpdateChannel = 'stable' | 'nightly';
export type DesktopUpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'failed';

export interface DesktopUpdateSnapshot {
  readonly supported: boolean;
  readonly channel: DesktopUpdateChannel;
  readonly phase: DesktopUpdatePhase;
  readonly currentVersion: string;
  readonly candidateVersion?: string;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number;
  readonly lastCheckedAt?: number;
  readonly errorCode?: 'network' | 'metadata' | 'signature' | 'download' | 'install' | 'unavailable';
}
```

Extend `NativeHost` with the five narrow operations and `desktopUpdates`; increment `NATIVE_HOST_API_VERSION` because the bundled host contract changed. Map only the fixed Tauri command/event names in `tauriHost.ts`; do not import the updater JavaScript guest package or grant generic updater permissions.

**Step 3: Run the focused tests**

Expected: PASS.

**Step 4: Commit**

```bash
git add apps/frontend/src/lib/native
git commit -m "feat(desktop): add typed native update boundary"
```

### Task 2: Persist And Coordinate The Selected Channel

**Files:**
- Modify: `apps/frontend/src/lib/state/userPreferences.svelte.ts`
- Modify: `apps/frontend/src/lib/state/userPreferences.svelte.spec.ts`
- Create: `apps/frontend/src/lib/native/desktopUpdates.svelte.ts`
- Create: `apps/frontend/src/lib/native/desktopUpdates.svelte.spec.ts`

**Step 1: Write failing preference and coordinator tests**

Cover:

- Stable is the default and invalid stored values normalize to Stable.
- Selecting Nightly persists immediately in the existing global preference slot.
- Initializing on a browser host performs no update I/O.
- Initializing on Tauri subscribes first, sends the persisted channel, then starts one background check.
- Repeated initialization and overlapping checks are single-flight.
- Scheduled checks occur every six hours using fake timers.
- Channel changes discard stale candidate presentation, call the native setter, and trigger a new check.
- Manual failures remain visible; background failures remain in state but do not toast from the coordinator.

Run:

```bash
mise x -- pnpm --filter chatto-frontend exec vitest --run src/lib/state/userPreferences.svelte.spec.ts src/lib/native/desktopUpdates.svelte.spec.ts
```

Expected: FAIL because channel persistence and coordinator do not exist.

**Step 2: Implement the reactive coordinator**

Add `DesktopUpdateChannel` to the normalized preferences shape. Implement one exported class instance with `$state.raw` snapshot, explicit `initialize`/`destroy`, an event subscription, and event-handler/timer methods rather than effects. Keep endpoint selection, signature handling, version comparison, and installation out of TypeScript.

**Step 3: Run the Svelte autofixer**

Run the official Svelte autofixer on `userPreferences.svelte.ts` and `desktopUpdates.svelte.ts`; resolve every real issue and re-run until clean.

**Step 4: Run the focused tests and commit**

Expected: PASS.

```bash
git add apps/frontend/src/lib/state/userPreferences.svelte.ts apps/frontend/src/lib/state/userPreferences.svelte.spec.ts apps/frontend/src/lib/native/desktopUpdates.svelte.ts apps/frontend/src/lib/native/desktopUpdates.svelte.spec.ts
git commit -m "feat(frontend): coordinate desktop update state"
```

### Task 3: Implement The Rust Updater State Machine

**Files:**
- Create: `apps/desktop/src-tauri/src/updates.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/shell.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.lock`
- Modify: `apps/desktop/src-tauri/tests/config.rs`

**Step 1: Write failing Rust unit/config tests**

Test pure helpers for:

- exact hard-coded Stable and Nightly HTTPS endpoints;
- lower-case channel serialization and rejection of arbitrary strings;
- greater-version-only comparison, including Nightly → Stable no-downgrade cases;
- state transitions and single-flight rejection;
- normalized non-sensitive error categories;
- bounded progress math when content length is absent or changes;
- active-call detection through a read-only `ShellState` helper;
- configuration continuing to reject renderer permissions beginning with `updater:` or `process:`.

Run on Windows CI or a correctly provisioned Tauri development host:

```bash
mise x -- cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml updates
```

Expected: FAIL because `updates.rs` does not exist. On this host, compilation remains ENVIRONMENT-BLOCKED at missing `dbus-1` before the test binary is built.

**Step 2: Add the updater dependency and plugin**

Pin `tauri-plugin-updater = "2.10.1"`. Register its Rust plugin with an embedded public key selected by `option_env!("CHATTO_DESKTOP_UPDATER_PUBLIC_KEY")` and a valid inert development fallback. Do not add updater permissions to `capabilities/default.json`.

**Step 3: Implement the manager**

Use a process-wide async mutex containing the channel, public snapshot, pending `Update`, and verified downloaded bytes. Commands must:

- return the current snapshot;
- validate and switch only between the two hard-coded channels;
- check with a 30-second timeout and the matching runtime endpoint;
- download and signature-verify automatically while emitting `native://update-state` snapshots;
- keep only one check/download active;
- re-check that the same candidate is still offered immediately before installation;
- restore the ready candidate after transient revalidation/install errors;
- call `Update::install(&bytes)` only after explicit renderer invocation;
- never enable `version_comparator` downgrades;
- emit/log only normalized categories and versions, never full URLs, headers, credentials, or paths.

Expose `ShellState::has_active_call()` so snapshots include whether a restart prompt must be suppressed. A screen share always occurs inside a call, so the existing all-server call ownership signal covers both approved suppression cases.

**Step 4: Register commands and run checks**

Add the five commands to `generate_handler!`, manage updater state during setup, then run formatting, Clippy, config tests, and the full Rust suite on Windows.

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "feat(desktop): download and verify native updates"
```

### Task 4: Add Update Settings And Restart UX

**Files:**
- Create: `apps/frontend/src/lib/components/settings/DesktopUpdateSettings.svelte`
- Create: `apps/frontend/src/lib/components/settings/DesktopUpdateSettings.svelte.spec.ts`
- Create: `apps/frontend/src/lib/components/DesktopUpdateNotifier.svelte`
- Create: `apps/frontend/src/lib/components/DesktopUpdateNotifier.svelte.spec.ts`
- Modify: `apps/frontend/src/routes/chat/[serverId]/settings/preferences/+page.svelte`
- Modify: `apps/frontend/src/routes/+layout.svelte`

**Step 1: Write failing mounted component tests**

Require:

- no desktop section or notifier on browser hosts;
- current version, selected channel, last-check unavailable state, progress, ready state, and manual check rendering;
- immediate Stable selection and a confirmation dialog before Nightly is saved;
- explanatory waiting-for-Stable copy when the current Nightly outranks the available Stable;
- a durable `Restart now`/`Later` prompt only when ready and not in any call;
- no automatic restart, timeout, or navigation-triggered restart;
- active calls suppress the prompt while retaining the ready indicator;
- explicit restart from Settings warns before disconnecting an active call;
- manual failures use concise translated toasts while background failures stay quiet.

Run:

```bash
mise x -- pnpm --filter chatto-frontend exec vitest --run src/lib/components/settings/DesktopUpdateSettings.svelte.spec.ts src/lib/components/DesktopUpdateNotifier.svelte.spec.ts
```

Expected: FAIL because the components do not exist.

**Step 2: Implement with established UI primitives**

Use `FormSection`, `ChoiceRow`, `Button`, the established confirmation dialog, and toast patterns. Mount the Settings section in Preferences only when `desktopUpdates.supported`; mount one notifier beside the existing web `UpdateNotifier` in the root layout. Initialize/destroy the coordinator at root-component lifecycle boundaries. Reuse `idleState.isInAnyCall`; do not add a second call registry or an effect that copies derived state.

**Step 3: Run Svelte validation**

Run the official autofixer on all four edited/created Svelte files, then `mise check-frontend` and the focused mounted tests.

**Step 4: Commit**

```bash
git add apps/frontend/src/lib/components apps/frontend/src/routes/+layout.svelte 'apps/frontend/src/routes/chat/[serverId]/settings/preferences/+page.svelte'
git commit -m "feat(frontend): add desktop update controls"
```

### Task 5: Translate Every User-Visible Update String

**Files:**
- Modify: `apps/frontend/messages/*/settings.json`
- Modify: `apps/frontend/messages/*/ui.json`
- Regenerate: `apps/frontend/src/lib/i18n/messages.ts`
- Modify: `apps/frontend/scripts/i18n-facade-sources.test.mjs` only if the generated facade contract requires it

**Step 1: Add the British-English source messages**

Add structured messages for channel names/descriptions, Nightly confirmation, version/status/last-check labels, check/restart/later actions, waiting-for-Stable behavior, progress, and normalized errors. Keep US English sparse unless wording differs.

**Step 2: Add every complete catalog translation**

Preserve identical keys and placeholders in de-AT, de-CH, de-DE, eo, es-419, es-ES, fr-CA, fr-FR, ja-JP, nb-NO, nl-BE, nl-NL, pl-PL, pt-BR, pt-PT, sv-SE, and uk-UA. Do not fall back to English in a complete catalog.

**Step 3: Regenerate and test**

```bash
mise x -- pnpm --dir apps/frontend run prepare
mise x -- pnpm --filter chatto-frontend exec node --test scripts/i18n-facade-sources.test.mjs
mise x -- pnpm --filter chatto-frontend exec vitest --run src/lib/components/settings/DesktopUpdateSettings.svelte.spec.ts src/lib/components/DesktopUpdateNotifier.svelte.spec.ts
```

Expected: all catalogs and component tests PASS.

**Step 4: Commit**

```bash
git add apps/frontend/messages apps/frontend/src/lib/i18n/messages.ts apps/frontend/scripts/i18n-facade-sources.test.mjs
git commit -m "feat(i18n): translate desktop update experience"
```

### Task 6: Produce Signed, Monotonic Nightly Assets

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/scripts/build-prerelease.ps1`
- Modify: `apps/desktop/scripts/verify-package.ps1`
- Modify: `apps/desktop/scripts/publish-prerelease.sh`
- Create: `apps/desktop/scripts/update-manifest.mjs`
- Create: `apps/desktop/scripts/update-manifest.test.mjs`
- Modify: `apps/desktop/scripts/release-workflow.test.mjs`
- Modify: `apps/desktop/package.json`
- Modify: `.github/workflows/ci.yml`

**Step 1: Write failing release-script tests**

Require:

- Nightly versions shaped as `<base>-nightly.<UTC timestamp>.<run number>` and ordered by build time/run number;
- release tags and filenames derived from that exact version;
- final NSIS installer, `.sig`, and `.sha256` staged together;
- `Get-AuthenticodeSignature` status `Valid` and configured publisher matching;
- updater `.sig` verification against the configured public key;
- JSON manifest schema with `windows-x86_64.url` and literal signature contents;
- GitHub Release publication before manifest publication;
- signing secrets absent from pull-request builds and present only in the protected push publication job;
- no generic renderer updater permission.

Run:

```bash
mise x -- pnpm --filter chatto-desktop exec node --test scripts/release-workflow.test.mjs scripts/update-manifest.test.mjs
```

Expected: FAIL against commit-hash versions and unsigned two-asset releases.

**Step 2: Implement signed release packaging**

Use a release-only Tauri config overlay containing the exact version, `bundle.createUpdaterArtifacts: true`, and Azure Artifact Signing `signCommand`. Inject the production updater public key at Rust compile time and Tauri private signing key through environment variables. Fail before building if any release credential/configuration is absent. Keep PR `--no-bundle` builds secret-free.

Stage and verify the signed installer, Tauri `.sig`, SHA-256, version, source SHA, publisher, and publication time. Publish all immutable assets to a draft, download/reverify them, and then expose the prerelease.

**Step 3: Generate the Nightly manifest**

Implement a pure Node manifest builder/verifier with no credentials. Its URL must reference the immutable GitHub asset and its signature field must contain the `.sig` file contents. Upload the manifest as a release asset for auditability; channel advancement happens in Task 7.

**Step 4: Run tests and commit**

```bash
git add apps/desktop .github/workflows/ci.yml
git commit -m "ci(desktop): sign monotonic nightly updates"
```

### Task 7: Publish Atomic Stable And Nightly Channels

**Files:**
- Create: `.github/workflows/desktop-release.yml`
- Create: `apps/desktop/scripts/publish-update-channel.mjs`
- Create: `apps/desktop/scripts/publish-update-channel.test.mjs`
- Create: `apps/desktop/scripts/build-release.ps1`
- Modify: `apps/desktop/scripts/release-workflow.test.mjs`
- Modify: `apps/desktop/package.json`

**Step 1: Write failing publisher/workflow tests**

Cover channel/path allowlists, no arbitrary bucket keys or public URLs, immutable versioned-object upload before canonical copy, manifest read-back verification, Stable tag/version matching, reachability from `main-native`, draft-first asset verification, protected environment use, least-privilege permissions, OIDC-only Azure login, and no automatic downgrade metadata.

**Step 2: Implement the channel publisher**

The publisher accepts only `stable` or `nightly`, verifies the local manifest and immutable GitHub asset, writes a versioned object, reads it back through object storage, atomically copies it to `desktop/<channel>/windows-x86_64.json` with `Cache-Control: no-cache`, and verifies the public `updates.chatto.run` response byte-for-byte. Use the AWS CLI for S3-compatible authenticated operations and Node `fetch` only for the public read-back.

**Step 3: Add the Stable release workflow**

Trigger on `desktop-v*` tags. Verify an ordinary three-component stable version that matches `package.json`, `Cargo.toml`, and `tauri.conf.json`, and verify the tagged commit is reachable from `origin/main-native`. Build/test/sign on Windows, publish a draft GitHub Release, reverify stored assets, publish it, then atomically advance Stable. Nightly CI calls the same publisher only after its immutable prerelease is visible.

**Step 4: Run workflow validation**

```bash
mise x -- pnpm --filter chatto-desktop test
mise x -- actionlint .github/workflows/ci.yml .github/workflows/desktop-release.yml
```

Expected locally: Node tests PASS; Rust portion remains environment-blocked. Expected on Windows CI: complete desktop suite PASS.

**Step 5: Commit**

```bash
git add .github/workflows/desktop-release.yml .github/workflows/ci.yml apps/desktop/scripts apps/desktop/package.json
git commit -m "ci(desktop): publish stable and nightly update channels"
```

### Task 8: Update Decisions, User Docs, And Acceptance Evidence

**Files:**
- Modify: `docs/fdr/FDR-027-pwa-shell-and-service-worker.md`
- Modify: `docs/adr/ADR-052-windows-desktop-client.md`
- Modify: `apps/desktop/README.md`
- Modify: `apps/desktop/tests/windows-acceptance.md`
- Create: `apps/docs-website/src/content/docs/getting-started/desktop-client.mdx`
- Modify: `apps/docs-website/astro.config.mjs`
- Modify: `NOTICE` if the dependency/license inventory requires it

**Step 1: Update FDR-027 and ADR-052**

Describe current behavior, not implementation history. FDR behavior must cover Stable/Nightly, background download, defer/restart, active-call suppression, the bridge installation, and no downgrade. ADR-052 must remove automatic updates/production signing from the future-work list and record the narrow Rust-owned updater authority, independent release line, first-party manifests, dual signatures, and consequences.

The architecture-inventory workflow determined that `docs/architecture/runtime-components.md` inventories server `ChattoCore` models, not client hosts; do not add the desktop updater there.

**Step 2: Update maintainer and user documentation**

Document release prerequisites, signing-key custody/rotation, protected environment variables, stable tag flow, channel withdrawal/fix-forward recovery, manual bridge installation, channel selection, and expected restart behavior. Add the public desktop guide and sidebar entry without exposing maintainer secrets.

**Step 3: Expand Windows acceptance**

Add cases for upgrade from the immediately preceding signed Stable and Nightly installers, publisher/signature validation, offline startup, 404/malformed/bad-signature manifests, interrupted download, Later, active-call suppression, explicit restart, Nightly → Stable waiting, and post-update version/data preservation. Leave every unexecuted case `UNRUN`.

**Step 4: Validate docs and licenses**

```bash
mise license-check
mise x -- pnpm --dir apps/docs-website run build
git diff --check
```

**Step 5: Commit**

```bash
git add docs/fdr/FDR-027-pwa-shell-and-service-worker.md docs/adr/ADR-052-windows-desktop-client.md apps/desktop/README.md apps/desktop/tests/windows-acceptance.md apps/docs-website NOTICE
git commit -m "docs(desktop): document automatic update channels"
```

### Task 9: End-To-End Verification, Review, And PR

**Files:**
- Modify only files required by verified regressions
- Create screenshots/evidence under `.context/` only; do not commit private or account/server data

**Step 1: Run focused and aggregate local verification**

```bash
mise x -- pnpm --filter chatto-frontend exec vitest --run src/lib/native src/lib/components/settings/DesktopUpdateSettings.svelte.spec.ts src/lib/components/DesktopUpdateNotifier.svelte.spec.ts src/lib/state/userPreferences.svelte.spec.ts
mise x -- pnpm --filter chatto-desktop exec node --test scripts/release-workflow.test.mjs scripts/update-manifest.test.mjs scripts/publish-update-channel.test.mjs
mise check-frontend
mise lint-frontend
mise license-check
git diff --check
```

Run `mise test-desktop` and report its exact partial result if the Linux Tauri system-library blocker remains.

**Step 2: Validate Svelte and browser-visible UI**

Run the official Svelte autofixer again on every changed `.svelte`/`.svelte.ts` file. Use @chatto-live-verify to build/run the real bundled Chatto application and inspect the desktop-update Settings states through a deterministic injected native-host fixture or Storybook story. Capture screenshots without server/account data.

**Step 3: Push and require Windows CI**

Push `feat/desktop-auto-update`, open the PR against `main-native`, and require the Windows desktop job to prove Rust formatting, Clippy, unit tests, packaging configuration, and the native unsigned PR build. Do not trigger a release tag, mutate either live update channel, or claim signed installer acceptance from PR CI.

**Step 4: Request review**

Use @superpowers:requesting-code-review, resolve findings with @superpowers:receiving-code-review, then run @superpowers:verification-before-completion.

**Step 5: Run the PR checklist and create the requested PR**

Use @chatto-pr-checklist automatically when the PR opens. Use a Conventional Commit PR title, summarize Stable/Nightly behavior and supply-chain boundaries, link ADR-052/FDR-027/design docs, list exact verification and limitations, and call out the protected-environment prerequisites that must exist before merge. Verify the stored body, base branch, and closing-issue wiring with:

```bash
gh pr view --json body,baseRefName,closingIssuesReferences
gh pr checks --watch
```

Fix regressions from `main-native`; do not treat missing production credentials on PRs as a reason to expose secrets or weaken fail-closed release behavior.
