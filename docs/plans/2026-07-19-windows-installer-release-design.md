# Main-Native Windows Prerelease Design

**Date:** 2026-07-19
**Status:** Approved
**Supersedes:** The tag-driven design originally recorded in this file

## Problem

Chatto's Windows desktop POC can produce an NSIS installer locally, but the
installer is not available from GitHub Releases. Publishing it from the normal
`main` and `v*` server release path would also increase the native fork's
overlap with upstream release code and couple desktop experiments to the
server/web release cadence.

The native client needs a release channel that keeps `main` focused on the
upstream web/server product, makes upstream merges routine, and still produces
an immediately downloadable installer for every accepted native change.

## Branch Topology

Use `main-native` as a long-lived downstream integration branch:

```text
upstream/main -> origin/main
                      \
                       -> origin/main-native -> desktop-v... prereleases
                                  ^
                                  |
                         native feature PRs
```

`origin/main` remains the web/server-focused branch. Native feature PRs target
`main-native`. Upstream changes flow from `main` into `main-native`; native-only
changes do not flow back into `main` unless they are independently suitable for
the shared web/server product.

The native workflow changes live only on `main-native`, so they do not need to
be carried in `main` for GitHub to execute them. The existing tag-driven
`release.yml`, release-please configuration, GoReleaser assets, GHCR images,
and Homebrew publication remain unchanged.

## Per-Merge Prerelease Contract

Add `main-native` to the normal CI workflow's push and pull-request branches.
On a push to `main-native`, the existing Windows desktop job will build and
verify the full NSIS bundle in addition to running its normal tests and checks.
It will transfer the installer and checksum to a publisher job as an internal
workflow artifact.

The publisher will wait for the relevant cross-platform CI jobs, not merely the
Windows compiler. Once those jobs pass, it will:

1. download the Windows workflow artifact;
2. require exactly the expected installer and checksum;
3. verify the checksum locally;
4. create an asset-bearing GitHub prerelease for the exact commit;
5. rely on GitHub CLI's draft/upload/publish transaction so incomplete assets
   are never exposed; and
6. verify the published tag and both release assets.

This matches the existing main-branch image-publishing principle: accepted
code is published only after the tests that guard it succeed. A draft prevents
users from seeing a partially uploaded installer release.

## Immutable Version And Tag Scheme

Every `main-native` commit receives a deterministic version derived from the
stable base version in `apps/desktop/package.json` and the first twelve
characters of the commit SHA:

```text
<base>-main-native.sha-<short-sha>
```

For example, base version `0.1.0` at commit `af3ce2e42586...` becomes:

```text
version: 0.1.0-main-native.sha-af3ce2e42586
tag:     desktop-v0.1.0-main-native.sha-af3ce2e42586
asset:   Chatto_0.1.0-main-native.sha-af3ce2e42586_x64-setup.exe
```

The pushed commit is therefore recoverable from the release name and the tag
points immutably at that exact source. Rerunning the same workflow resumes its
draft or treats an already published prerelease as complete; it does not create
a duplicate release or move a tag.

The workflow passes the derived version through Tauri's supported `--config`
merge option. Tracked development manifests remain at their human-managed base
version and are not rewritten by CI.

## Permissions And Repository Ownership

The Windows build job has read-only contents permission and no publishing
credentials. The final publisher job alone receives `contents: write` through
the repository-scoped `GITHUB_TOKEN` after its required CI jobs pass.

All GitHub operations target `${{ github.repository }}` rather than the
upstream `chattocorp/chatto` repository. This is essential because the native
release channel belongs to the downstream repository even when its source is
periodically synchronized from upstream.

## Security And Signing

The POC installer remains unsigned by explicit product decision. Every
prerelease and its notes must say so plainly because Windows SmartScreen may
warn or block users. Authenticode signing, certificate secret management,
automatic updates, and Microsoft Store distribution remain separate
production-hardening work.

The publisher validates the artifact count, exact commit-derived filenames,
and SHA-256 checksum before upload, then confirms the immutable tag and both
expected asset names are present. If a failed prior attempt left an unpublished
draft, the publisher verifies that the draft belongs to the exact tag and
commit, replaces only that incomplete draft, and retries the documented GitHub
CLI draft/upload/publish transaction.

## Trade-Offs

Publishing on every merge deliberately creates many GitHub prereleases and
tags. This provides the requested immediate Releases-page history and strong
commit provenance, at the cost of a noisier release list and additional
Windows runner minutes.

A rolling tag would keep the release list smaller but would make its source
mutable and weaken reproducibility. A release-please-controlled desktop cadence
would produce cleaner versions but would not make every accepted merge
immediately available. Both alternatives were rejected for this POC.

## Regression Coverage And Verification

A focused Node test will inspect the real `ci.yml` and assert the branch,
permission, version-overlay, build, verification, artifact-transfer, CI-gating,
draft, prerelease, checksum, and publication contracts. It will also assert
that the normal server `release.yml` is not wired to `main-native`.

Verification will include the focused workflow test in red and green states,
`actionlint`, desktop tests/checks, license metadata, whitespace checks, and a
native Windows build with the same commit-derived version overlay. No test tag
or GitHub Release will be created from the feature branch.
