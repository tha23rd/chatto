# Windows Desktop Beta Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish secure Tauri-signed Windows beta updates through GitHub Releases using one private-key secret and no Azure or external object store.

**Architecture:** Immutable versioned GitHub prereleases continue to hold installers and release metadata. Rolling `desktop-stable` and `desktop-nightly` releases hold the fixed channel manifests consumed by the native updater. The public updater key is checked into the repository; only its private half is a GitHub secret.

**Tech Stack:** GitHub Actions, GitHub CLI, Node.js test runner, PowerShell packaging scripts, Tauri 2/Rust updater.

---

### Task 1: Specify the beta trust and publication contract

**Files:**
- Modify: `apps/desktop/scripts/release-workflow.test.mjs`
- Modify: `apps/desktop/scripts/publish-update-channel.test.mjs`
- Modify: `apps/desktop/src-tauri/src/updates.rs`

**Step 1: Write failing workflow tests**

Require the Nightly and Stable publication jobs to use only `contents: write`,
omit `desktop-release`, Azure/OIDC, AWS, external-store variables, and
Authenticode setup, and scope `TAURI_SIGNING_PRIVATE_KEY` to the build step.
Require channel publication to receive only `GH_TOKEN`.

**Step 2: Write failing publisher tests**

Replace S3 expectations with a command-runner contract that creates or reuses a
rolling `desktop-<channel>` prerelease, downloads the existing canonical
manifest before mutation, rejects rollback/equal-different versions, uploads
with `gh release upload --clobber`, and reads the public bytes back.

**Step 3: Write failing Rust tests**

Expect the two channel endpoints to be the fixed GitHub release download URLs
and expect the updater public key to come from a checked-in non-placeholder
file rather than a compile-time environment variable or inert development key.

**Step 4: Run tests and confirm failure**

Run:

```sh
mise x -- node --test apps/desktop/scripts/release-workflow.test.mjs apps/desktop/scripts/publish-update-channel.test.mjs
mise x -- cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml updates::tests
```

Expected: assertions fail against Azure/S3 endpoints and the development key.

**Step 5: Commit the contract tests**

```sh
git add apps/desktop/scripts/release-workflow.test.mjs apps/desktop/scripts/publish-update-channel.test.mjs apps/desktop/src-tauri/src/updates.rs
git commit -m "test(desktop): specify beta update publication"
```

### Task 2: Publish rolling channels through GitHub Releases

**Files:**
- Modify: `apps/desktop/scripts/publish-update-channel.mjs`
- Test: `apps/desktop/scripts/publish-update-channel.test.mjs`

**Step 1: Replace object-store options with GitHub release inputs**

Accept `channel`, `manifestPath`, and `repository`. Derive the tag
`desktop-<channel>` and public URL
`https://github.com/<repository>/releases/download/desktop-<channel>/windows-x86_64.json`.
Validate `GITHUB_REPOSITORY` as `owner/repository`.

**Step 2: Preserve monotonic and idempotency guards**

Fetch the existing public manifest before any mutation. Reject older versions
and equal versions with different bytes; treat exact equal bytes as a no-op.
Verify the immutable installer URL with a HEAD request.

**Step 3: Create/update the rolling prerelease and verify it**

Use the injected runner for `gh release view`, `gh release create`, and
`gh release upload --clobber`. Fetch the public manifest after upload and
require byte equality with the local file.

**Step 4: Run the publisher tests**

Run:

```sh
mise x -- node --test apps/desktop/scripts/publish-update-channel.test.mjs
```

Expected: all publication, rollback, replay, and validation tests pass.

**Step 5: Commit**

```sh
git add apps/desktop/scripts/publish-update-channel.mjs apps/desktop/scripts/publish-update-channel.test.mjs
git commit -m "feat(desktop): host beta update channels on GitHub"
```

### Task 3: Make beta packaging require only the updater key

**Files:**
- Create: `apps/desktop/updater-public-key.txt`
- Modify: `apps/desktop/src-tauri/src/updates.rs`
- Modify: `apps/desktop/scripts/build-release.ps1`
- Modify: `apps/desktop/scripts/verify-package.ps1`
- Modify: `apps/desktop/scripts/publish-prerelease.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/desktop-release.yml`
- Test: `apps/desktop/scripts/release-workflow.test.mjs`

**Step 1: Generate the beta updater keypair**

Generate an unencrypted Tauri updater key into an ignored, mode-0600 path under
`.context/`, write only the public key to
`apps/desktop/updater-public-key.txt`, and configure the private value as the
repository secret `TAURI_SIGNING_PRIVATE_KEY` without printing it.

**Step 2: Embed the checked-in public key**

Use `include_str!` in `updates.rs`, trim the value once, and remove the inert
fallback and compile-time public-key environment override.

**Step 3: Make Authenticode explicitly optional for beta builds**

Add a beta/skip-Authenticode switch to the build, package verification, and
release read-back scripts. When enabled, still require updater signing,
checksum verification, version metadata, and installer smoke checks; do not
invoke or pretend to verify Authenticode.

**Step 4: Simplify both publication workflows**

Remove the protected environment, OIDC permission, Azure module/login, cloud
variables, and AWS credentials. Pass the beta packaging switch, keep the
private key step-scoped, give the GitHub channel step `GH_TOKEN`, and preserve
channel concurrency plus draft-first read-back verification.

**Step 5: Run targeted tests and checks**

Run:

```sh
mise x -- node --test apps/desktop/scripts/release-workflow.test.mjs apps/desktop/scripts/publish-update-channel.test.mjs apps/desktop/scripts/update-manifest.test.mjs
mise x -- actionlint .github/workflows/ci.yml .github/workflows/desktop-release.yml
mise x -- cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
```

Expected: all tests and workflow lint pass.

**Step 6: Commit**

```sh
git add apps/desktop/updater-public-key.txt apps/desktop/src-tauri/src/updates.rs apps/desktop/scripts .github/workflows/ci.yml .github/workflows/desktop-release.yml
git commit -m "feat(desktop): simplify beta update releases"
```

### Task 4: Align decisions and operator documentation

**Files:**
- Modify: `apps/desktop/README.md`
- Modify: `docs/adr/ADR-052-windows-desktop-client.md`
- Modify: `docs/fdr/FDR-027-pwa-shell-and-service-worker.md`
- Modify: `docs/plans/2026-07-19-windows-desktop-auto-update-design.md`
- Modify: `apps/docs-website/src/content/docs/guides/windows-desktop-client.mdx`
- Modify: `apps/desktop/WINDOWS-ACCEPTANCE.md`

**Step 1: Document the one-secret beta setup**

Explain the GitHub-hosted rolling channels, updater-key backup/rotation,
expected Windows Unknown publisher warning, one-time bridge install, and the
deferred production hardening.

**Step 2: Update ADR/FDR current-state language**

Keep the Tauri trust boundary and Stable/Nightly behavior, replace Azure/S3
claims with the approved beta GitHub route, and bump the FDR review date.

**Step 3: Verify documentation**

Run:

```sh
mise license-check
mise x -- pnpm --dir apps/docs-website build
git diff --check
```

Expected: license check and docs build pass; no whitespace errors.

**Step 4: Commit**

```sh
git add apps/desktop/README.md apps/desktop/WINDOWS-ACCEPTANCE.md apps/docs-website/src/content/docs/guides/windows-desktop-client.mdx docs/adr/ADR-052-windows-desktop-client.md docs/fdr/FDR-027-pwa-shell-and-service-worker.md docs/plans/2026-07-19-windows-desktop-auto-update-design.md
git commit -m "docs(desktop): document beta update releases"
```

### Task 5: Verify and deliver

**Files:**
- Verify all files changed by Tasks 1-4.

**Step 1: Run the desktop release suite**

Run:

```sh
mise test-desktop
mise check-desktop
git diff --check origin/main-native...HEAD
```

Expected: all available desktop tests/checks pass; report any host-only system
dependency limitation precisely.

**Step 2: Review the final diff and secret isolation**

Confirm the private key is ignored and absent from Git history, only the public
key is committed, PR jobs remain secret-free, and release jobs scope the secret
to one build step.

**Step 3: Push and open a PR**

Push the existing feature branch and open a Conventional Commit-titled PR
against `main-native`. Verify its stored body/base/head and monitor CI.

**Step 4: After merge, verify publication**

Monitor the `main-native` run through `publish-main-native-installer`, verify
the immutable GitHub release assets and rolling Nightly manifest, then provide
the direct installer URL from the published manifest.
