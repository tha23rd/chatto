# Main-Native Windows Prerelease Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every successful merge to `main-native` publish an immutable, unsigned Windows x64 NSIS prerelease without changing `main` or the normal server release channel.

**Architecture:** Retarget native development to a long-lived `main-native` branch. Extend its normal CI workflow so the existing Windows job produces a commit-versioned installer artifact, then let a Linux publisher job gated on the relevant CI jobs create a draft, attach and verify the assets, and expose it as a GitHub prerelease. Keep `release.yml`, `v*` tags, GoReleaser, GHCR, and Homebrew behavior unchanged.

**Tech Stack:** GitHub Actions, PowerShell 7, Tauri 2.11, NSIS, Rust stable MSVC, pnpm/mise, Node's built-in test runner, GitHub CLI.

---

### Task 1: Establish the downstream branch boundary

**External state:**

- Create: `origin/main-native` at the current `origin/main` commit
- Update: PR #20 base branch from `main` to `main-native`

**Step 1: Fetch and verify the base**

Fetch `origin/main`, verify that `main-native` does not already exist, and
record the exact commit used as the new branch base. Do not rename the current
feature branch or touch other feature branches/worktrees.

**Step 2: Create the remote integration branch**

Push the verified `origin/main` commit to `refs/heads/main-native`. Do not force
push and do not change the repository's default branch.

**Step 3: Retarget and verify PR #20**

Use `gh pr edit --base main-native`, then use `gh pr view` to confirm the stored
base, head, body, state, and mergeability. The PR must still contain the full
native delta and remain draft.

### Task 2: Add a main-native CI contract test

**Files:**

- Create: `apps/desktop/scripts/release-workflow.test.mjs`
- Modify: `apps/desktop/package.json`
- Test: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1: Write the focused test**

Using only Node built-ins, read the real `.github/workflows/ci.yml` and
`.github/workflows/release.yml`. Assert that:

- CI includes `main-native` for pushes and pull requests;
- `test-desktop-windows` exposes native version/tag outputs and, only on a
  `main-native` push, derives a commit version, builds Tauri with `--config`,
  runs `verify-package.ps1`, stages `.exe`/`.sha256`, and uploads them with
  `actions/upload-artifact@v7`;
- `publish-main-native-installer` runs only for a `main-native` push, needs the
  relevant CI jobs, has `contents: write`, downloads the exact commit artifact
  with `actions/download-artifact@v8`, verifies the checksum, uses a draft and
  prerelease, and publishes through `gh release`; and
- normal `release.yml` is not triggered by or coupled to `main-native`.

Wire the test into `apps/desktop/package.json` so `mise test-desktop` enforces
the contract.

**Step 2: Run the focused test and verify RED**

Run:

```bash
mise x -- node apps/desktop/scripts/release-workflow.test.mjs
```

Expected: FAIL because CI does not yet recognize `main-native` or publish its
installer.

### Task 3: Build and transfer the installer in Windows CI

**Files:**

- Modify: `.github/workflows/ci.yml`
- Test: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1: Add the branch triggers**

Add `main-native` to both the push and pull-request base branch lists. Preserve
all existing `main` and maintenance-release triggers.

**Step 2: Derive immutable metadata**

Give `test-desktop-windows` outputs for version, tag, and installer name. On a
`main-native` push only, read the stable SemVer base from
`apps/desktop/package.json`, append `-main-native.sha-<12-char-sha>`, and write a
temporary Tauri configuration containing only that version.

Fail if the base is not a stable three-component SemVer or the commit SHA is
malformed.

**Step 3: Preserve ordinary CI and build the release bundle**

Keep the existing `--no-bundle` build for PRs, `main`, and release branches.
On a `main-native` push, replace that final build with the full NSIS target
using the temporary version overlay. Require the exact commit-derived filename
and exactly one installer in the bundle directory.

**Step 4: Verify, stage, and transfer**

Run the existing PowerShell package verifier with the explicit installer path,
stage only the installer plus lowercase GNU-compatible SHA-256 checksum, and
upload them as `windows-installer-${{ github.sha }}` with one-day retention and
no compression.

The Windows job keeps the workflow's default read-only contents permission and
receives no release credentials.

### Task 4: Publish after the relevant CI gates pass

**Files:**

- Modify: `.github/workflows/ci.yml`
- Test: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1: Add the gated publisher job**

Create `publish-main-native-installer` for pushes to `refs/heads/main-native`.
Require successful license, protobuf-drift, frontend, Windows desktop, CLI,
ordinary e2e, and media-e2e jobs. Grant only `contents: write` and run on
Ubuntu.

**Step 2: Download and validate the workflow artifact**

Download `windows-installer-${{ github.sha }}`. Consume the version, tag, and
installer name from `test-desktop-windows` outputs. Require exactly the two
expected files and run `sha256sum --check` before calling GitHub.

**Step 3: Create or resume the immutable draft**

Target `${{ github.repository }}` and the exact `${{ github.sha }}` using the
repository `GITHUB_TOKEN`. If no release exists, create a draft prerelease with
the commit-derived `desktop-v...` tag and explicit unsigned-POC notes. If a
draft exists for a rerun, resume it. If the same prerelease is already public,
treat the immutable release as complete instead of replacing it.

**Step 4: Upload, verify, and publish**

Upload both assets with `--clobber` only while the release is a draft. Query the
release API and require both asset names, then set `draft=false` while retaining
`prerelease=true`.

**Step 5: Run the focused test and verify GREEN**

Run:

```bash
mise x -- node apps/desktop/scripts/release-workflow.test.mjs
```

Expected: PASS.

### Task 5: Document and verify the release channel

**Files:**

- Modify: `apps/desktop/README.md`
- Verify: `.github/workflows/ci.yml`
- Verify: `.github/workflows/release.yml`
- Verify: `apps/desktop/package.json`
- Verify: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1: Document main-native prereleases**

Explain the branch flow, commit-derived tag/version/asset names, Releases-page
location, checksum verification, and unsigned SmartScreen warning. Do not
advertise signing, automatic updates, non-Windows packages, or stable support.

**Step 2: Run repository verification**

Run:

```bash
mise x -- actionlint .github/workflows/*.yml
mise x -- node apps/desktop/scripts/release-workflow.test.mjs
mise test-desktop
mise check-desktop
mise license-check
git diff --check
```

Expected: all commands pass. Do not claim checks that were not run.

**Step 3: Reproduce the versioned build on native Windows**

Run Tauri with the same commit-derived configuration overlay, then run the
package verifier and checksum logic. Confirm the exact filename, non-empty
installer, product version, unsigned status, and checksum. Do not push a test
tag or create a release from the feature branch.

**Step 4: Review, commit, and push**

Confirm `release.yml` has no main-native coupling, only the publisher has write
permission, and `cli/data.oldbak-23944/` remains untouched. Commit with a
Conventional Commit such as:

```bash
git commit -m "ci(desktop): publish main-native prereleases"
```

Push the feature branch, update PR #20's summary and verification, inspect CI,
and fix regressions introduced by the change before handoff.
