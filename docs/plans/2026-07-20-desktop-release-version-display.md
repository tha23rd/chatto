# Desktop Release Version Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make packaged desktop clients display the exact installed Stable or Nightly Tauri version in the existing header and About dialog.

**Architecture:** Reuse SvelteKit's existing `CHATTO_BUILD_VERSION` input. Scope the release version to the Tauri build process and restore the caller environment afterward; no Svelte component or native-host API change is needed.

**Tech Stack:** PowerShell, Tauri 2, SvelteKit 2, Node test runner

---

### Task 1: Add the release-version regression test

**Files:**

- Modify: `apps/desktop/scripts/release-workflow.test.mjs`
- Test: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1:** Add a test requiring `$env:CHATTO_BUILD_VERSION = $Version` before `tauri build` and restoration afterward.

**Step 2:** Run `mise x -- node apps/desktop/scripts/release-workflow.test.mjs` and confirm the new assertion fails because the assignment is absent.

### Task 2: Inject and restore the release version

**Files:**

- Modify: `apps/desktop/scripts/build-release.ps1`
- Test: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1:** Save the previous `CHATTO_BUILD_VERSION`, set it to `$Version` around the Tauri build, and restore it in `finally`.

**Step 2:** Rerun the focused Node suite and confirm all tests pass.

**Step 3:** Run `git diff --check` and parse the PowerShell script with `pwsh` when available.

**Step 4:** Commit with Conventional Commit title `fix(desktop): display native release version`.
