# Windows DeepFilterNet3 Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the existing DeepFilterNet3 microphone processor initialize in the packaged Windows Tauri client while leaving the shared web client unchanged.

**Architecture:** Permit the processor's blob-backed AudioWorklet only in the native renderer CSP, protected by a Rust configuration contract test. Document the native exception in the existing microphone noise-suppression FDR and verify the real model/WASM/worklet path against Tauri's packaged `http://tauri.localhost` origin on Windows.

**Tech Stack:** Tauri 2, Rust tests, Windows WebView2, SvelteKit static build, LiveKit TrackProcessor, DeepFilterNet3 WebAssembly/AudioWorklet, mise, pnpm/Vitest.

---

### Task 1: Protect and enable the native AudioWorklet CSP path

**Files:**

- Modify: `apps/desktop/src-tauri/tests/config.rs`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

**Step 1: Write the failing native CSP contract test**

Extend `production_csp_blocks_remote_code_and_frames` with exact assertions for
the worklet-loading policy:

```rust
assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval' blob:"));
assert!(csp.contains("worker-src 'self' blob:"));
```

Retain the negative assertions that remote HTTPS scripts and frames are not
allowed.

**Step 2: Run the focused test and confirm the red state**

Run:

```bash
mise x -- cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  production_csp_blocks_remote_code_and_frames -- --nocapture
```

Expected: FAIL because `script-src` does not yet contain `blob:`. Confirm that
the existing `worker-src` assertion passes so the failure isolates the intended
directive.

**Step 3: Apply the minimal native-only policy change**

Change the Tauri CSP fragment from:

```text
script-src 'self' 'wasm-unsafe-eval';
```

to:

```text
script-src 'self' 'wasm-unsafe-eval' blob:;
```

Do not change `apps/frontend/nginx.conf`, the shared noise-suppression
controller, navigation policy, or any Tauri capability.

**Step 4: Run the focused test and confirm the green state**

Run the same focused `cargo test` command.

Expected: PASS.

**Step 5: Run formatting and the complete desktop Rust test suite**

Run:

```bash
mise x -- cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
mise x -- cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: formatting succeeds and every desktop Rust test passes.

**Step 6: Commit the tested policy change**

```bash
git add apps/desktop/src-tauri/tests/config.rs \
  apps/desktop/src-tauri/tauri.conf.json
git commit -m "fix(desktop): allow DeepFilterNet3 worklet modules"
```

### Task 2: Record the native policy decision in the feature documentation

**Files:**

- Modify: `docs/fdr/FDR-031-microphone-noise-suppression.md`

**Step 1: Update the review date and add a native-client decision**

Set `Last reviewed` to `2026-07-19` and add design decision 5:

```markdown
### 5. The Windows client permits the package's blob-backed AudioWorklet

**Decision:** The packaged Tauri renderer allows `blob:` in `script-src` so
`deepfilternet3-noise-filter` can register its generated AudioWorklet module.
The exception is native-only; the normal web CSP remains unchanged.

**Why:** WebView2 supports the model, WebAssembly, and AudioWorklet APIs, but
applies the worklet module load to `script-src`. The dependency exposes only a
blob-backed module loader, so the prior native policy rejected initialization.

**Tradeoff:** Trusted bundled renderer code may load blob-backed scripts. Remote
scripts, inline scripts, frames, navigation, shell, and filesystem access remain
blocked. Revisit a same-origin worklet asset if the dependency exposes one
before the feature leaves experimental status.
```

Remove the resolved CSP bullet from `Open Questions`, while retaining the real
in-call/browser/CPU evaluation and default-mode questions.

**Step 2: Review the FDR diff and repository whitespace**

Run:

```bash
git diff --check
git diff -- docs/fdr/FDR-031-microphone-noise-suppression.md
```

Expected: no whitespace errors; the FDR accurately distinguishes the native
exception from the unchanged web policy.

**Step 3: Commit the documentation update**

```bash
git add docs/fdr/FDR-031-microphone-noise-suppression.md
git commit -m "docs(voice): document native worklet policy"
```

### Task 3: Run regression and policy verification

**Files:**

- Verify only; no planned source changes

**Step 1: Run the frontend noise-suppression tests**

Run:

```bash
mise x -- pnpm --dir apps/frontend exec vitest --run \
  src/lib/voice/noiseSuppression.svelte.spec.ts \
  src/lib/components/voice/AudioDeviceMenu.svelte.spec.ts
```

Expected: both focused test files pass, proving the shared web/LiveKit controller
behavior remains intact.

**Step 2: Run desktop package contracts and linting**

Run:

```bash
mise x -- node --test apps/desktop/scripts/release-workflow.test.mjs
mise x -- cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml \
  --all-targets -- -D warnings
```

Expected: the release workflow contract passes and Clippy reports no warnings.

**Step 3: Run repository policy checks relevant to the touched files**

Run:

```bash
mise license-check
mise x -- actionlint
git diff --check origin/main-native...HEAD
```

Expected: REUSE is fully compliant, the workflow is valid, and the branch diff
contains no whitespace errors.

### Task 4: Verify the packaged WebView2 pipeline on native Windows

**Files:**

- Verify only; keep diagnostic output under ignored `.context/` or a unique Windows temporary directory

**Step 1: Build the desktop-targeted frontend**

Run the repository-managed desktop build from a native Windows process, with
Cargo output in a unique `C:\Temp\chatto-dnf-*` directory as documented in
`apps/desktop/README.md`.

Expected: the static frontend contains both checksum-pinned files under
`build/models/deepfilternet3/`.

**Step 2: Build and launch an isolated packaged-protocol diagnostic client**

Use a temporary Tauri config override with:

- identifier `com.chatto.desktop.diagnostic`;
- no `devUrl`, so the frontend loads from `http://tauri.localhost`;
- debug-only WebView2 remote debugging on a local port.

Do not stop or reuse the installed production client/profile.

Expected: the diagnostic page URL uses `http://tauri.localhost`, and the
packaged model and WASM requests return HTTP 200.

**Step 3: Exercise the complete processor pipeline**

Through the local DevTools protocol, construct a synthetic live audio track,
instantiate `DeepFilterNoiseFilterProcessor` with
`/models/deepfilternet3`, and call `processor.init({ track })`.

Expected result:

```json
{
  "ok": true,
  "packageSupported": true,
  "processedTrackState": "live"
}
```

Also confirm there are no CSP violations or `Unable to load a worklet's module`
errors.

**Step 4: Build the release installer with the native Windows toolchain**

Run the normal prerelease build path used by the GitHub workflow and verify the
installer/checksum pair with `apps/desktop/scripts/verify-package.ps1`.

Expected: the NSIS installer builds successfully, package verification passes,
and the adjacent checksum matches without modifying Windows security policy.

**Step 5: Clean disposable diagnostics**

Stop only the diagnostic process and remove only its unique Windows target,
asset, and evidence directories. Leave the installed client and the pre-existing
`cli/data.oldbak-23944/` directory untouched.

### Task 5: Open the `main-native` PR and drive CI to green

**Files:**

- Verify branch and PR metadata only

**Step 1: Run final verification-before-completion checks**

Confirm the branch has no unintended files, every claimed check has fresh
output, and only `cli/data.oldbak-23944/` remains as the pre-existing untracked
directory.

**Step 2: Push the feature branch**

```bash
git push -u origin fix/desktop-deepfilternet3-csp
```

**Step 3: Open a conventional PR against `main-native`**

Use `gh pr create --base main-native --head fix/desktop-deepfilternet3-csp
--body-file <file>` with title:

```text
fix(desktop): support DeepFilterNet3 worklets
```

The body must summarize the CSP root cause, security tradeoff, unchanged web
policy, automated checks, native packaged-protocol result, Windows release
build evidence, and link FDR-031 plus the design/implementation plans.

**Step 4: Verify the stored PR metadata**

Run:

```bash
gh pr view --json url,title,body,baseRefName,headRefName,closingIssuesReferences
```

Expected: base is `main-native`, head is the feature branch, body formatting is
intact, and no unintended issue-closing reference is present.

**Step 5: Run the Chatto PR checklist and monitor CI**

Use `@chatto-pr-checklist`, then:

```bash
gh pr checks --watch
```

Expected: every required/applicable CI check passes. If a regression from this
branch fails, diagnose it systematically, add a failing test when applicable,
fix it, push the focused commit, and wait for the replacement CI run to pass.
