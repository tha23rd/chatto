# Windows Installer Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the Windows x64 NSIS installer and its SHA-256 checksum on every tag-driven Chatto GitHub Release without changing existing GHCR, GoReleaser, or Homebrew behavior.

**Architecture:** Build the unsigned installer in a read-only `windows-latest` job, transfer its staged release assets through GitHub's workflow-artifact channel, and make the existing Linux release job attach those files to GoReleaser's draft before the draft is published. The `v*` tag supplies a temporary Tauri version overlay, leaving development manifests unchanged.

**Tech Stack:** GitHub Actions, PowerShell 7, Tauri 2.11, NSIS, Rust stable MSVC, pnpm/mise, Node's built-in test runner, GitHub CLI, GoReleaser.

---

### Task 1: Add a release-workflow contract test

**Files:**

- Create: `apps/desktop/scripts/release-workflow.test.mjs`
- Modify: `apps/desktop/package.json`
- Test: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1: Write the workflow regression test**

Use `node:test`, `node:assert/strict`, and `node:fs` only. Read the real
`.github/workflows/release.yml` and isolate top-level job blocks. Assert that:

- a `build-windows-installer` job runs on `windows-latest` with read-only
  contents;
- it resolves a release version, calls Tauri with a `--config` version
  overlay, runs `verify-package.ps1`, stages a `.exe` plus `.sha256`, and uses
  `actions/upload-artifact@v7`;
- the existing `release` job declares `needs: build-windows-installer`, uses
  `actions/download-artifact@v8`, validates the checksum, and calls
  `gh release upload`; and
- the workflow orders GoReleaser before release-asset upload and release-asset
  upload before `Publish GitHub Release`.

Keep the assertions about behavior and ordering rather than reproducing the
whole YAML file.

**Step 2: Wire the contract test into desktop tests**

Add the Node test before Cargo tests in `apps/desktop/package.json`'s `test`
script so `mise test-desktop` and the Windows CI job continuously enforce the
release contract.

**Step 3: Run the focused test and verify RED**

Run:

```bash
mise x -- pnpm --dir apps/desktop exec node --test scripts/release-workflow.test.mjs
```

Expected: FAIL because `release.yml` does not yet contain a Windows installer
job.

Do not edit the workflow before observing this failure.

### Task 2: Build and stage the tagged Windows installer

**Files:**

- Modify: `.github/workflows/release.yml`
- Test: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1: Add the tag-gated Windows build job**

Add `build-windows-installer` alongside the existing release jobs with:

- the same pushed-`v*` event guard as the existing release job;
- `windows-latest`, a bounded timeout, `contents: read`, and no secrets;
- repository checkout and the shared setup action with CLI dependencies
  disabled;
- stable Rust and the existing Rust-cache convention; and
- `CARGO_INCREMENTAL=0`.

Do not add Linux/macOS matrices or a second publishing action.

**Step 2: Resolve the release version safely**

In PowerShell, require `GITHUB_REF_NAME` to match `v<SemVer>`, strip exactly
one leading `v`, and expose the result as a step output. Write a JSON
configuration overlay under `RUNNER_TEMP` containing only that version. Pass
the file to Tauri with `--config` so tracked package/config versions remain
unchanged.

**Step 3: Build and verify the installer**

Build API types, then run the pinned workspace Tauri CLI. Require exactly the
expected NSIS file at:

```text
apps/desktop/src-tauri/target/release/bundle/nsis/Chatto_<version>_x64-setup.exe
```

Run `apps/desktop/scripts/verify-package.ps1` with that explicit path. Stage a
copy plus a lowercase GNU-compatible SHA-256 checksum under
`.context/release/windows`.

**Step 4: Upload the internal workflow artifact**

Use `actions/upload-artifact@v7`, a deterministic artifact name, a one-day
retention, and an error if staged files are missing. Upload only the installer
and checksum; do not publish from the Windows job.

### Task 3: Attach the Windows assets before publishing the draft

**Files:**

- Modify: `.github/workflows/release.yml`
- Test: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1: Make the release job depend on the Windows build**

Add `needs: build-windows-installer` to the existing tag release job. Do not
change its event condition, contents/package permissions, concurrency, or
stable-release output.

**Step 2: Download and validate the assets**

After GoReleaser has created or reused the draft, download the named workflow
artifact with `actions/download-artifact@v8`. Require the exact versioned
installer and checksum names, reject missing or unexpected ambiguity, and run
`sha256sum --check` before contacting GitHub.

**Step 3: Upload to the existing draft**

Use `gh release upload` with the existing `GORELEASER_GITHUB_TOKEN`, explicit
`chattocorp/chatto` repository and `v${VERSION}` tag. Use `--clobber` so a
failed draft workflow can be rerun; because the release is still a draft, a
failed replacement cannot expose a partial public release.

Keep this step before the existing `Publish GitHub Release` step. Leave
frontend/server GHCR publication and Homebrew updating otherwise unchanged.

**Step 4: Run the focused test and verify GREEN**

Run:

```bash
mise x -- pnpm --dir apps/desktop exec node --test scripts/release-workflow.test.mjs
```

Expected: PASS, including the build/upload/publication ordering assertions.

### Task 4: Document the release artifact

**Files:**

- Modify: `apps/desktop/README.md`

**Step 1: Add tagged-release guidance**

Document that tag-driven releases attach the x64 NSIS installer and checksum
to GitHub Releases, that the installer version matches the release tag, and
that POC installers remain unsigned and can trigger SmartScreen warnings.

Do not advertise automatic updates, code signing, Microsoft Store delivery,
or non-Windows packages.

### Task 5: Verify, commit, and update PR #20

**Files:**

- Verify: `.github/workflows/release.yml`
- Verify: `apps/desktop/package.json`
- Verify: `apps/desktop/scripts/release-workflow.test.mjs`
- Verify: `apps/desktop/README.md`
- Update: PR #20 body if release automation is not already described

**Step 1: Run syntax and focused verification**

Run:

```bash
mise x -- actionlint .github/workflows/*.yml
mise x -- pnpm --dir apps/desktop exec node --test scripts/release-workflow.test.mjs
mise test-desktop
mise check-desktop
mise license-check
git diff --check
```

Expected: all commands pass. Report any check that cannot run locally as
unverified rather than silently omitting it.

**Step 2: Reproduce the release build on native Windows**

Use the same version-overlay, Tauri build, package-verification, staging, and
checksum logic as the workflow with a harmless prerelease test version. Verify
the generated filename, embedded product version, non-empty installer,
unsigned status, and checksum. Do not push a tag or create a GitHub Release.

**Step 3: Review workflow permissions and diff**

Confirm the Windows job has no write permission or secrets, the Linux release
job is still the only publisher, the public-release step follows installer
upload, and the pre-existing `cli/data.oldbak-23944/` directory remains
untouched.

**Step 4: Commit and push**

Commit the contract test and implementation with a Conventional Commit such
as:

```bash
git commit -m "ci(desktop): publish Windows release installer"
```

Push `feat/windows-desktop-poc`, update PR #20's summary/testing evidence, and
inspect CI. Fix regressions introduced by this change before handoff.
