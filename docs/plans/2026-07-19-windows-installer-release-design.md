# Windows Installer Release Design

**Date:** 2026-07-19
**Status:** Approved

## Problem

Chatto's tag-driven release workflow publishes CLI archives and checksums to a
GitHub Release and publishes server/client container images to GHCR. The
Windows desktop POC can produce an NSIS installer locally, but tagged releases
do not build or attach that installer. Its development configuration also uses
a fixed `0.1.0` version, which must not leak into versioned release assets.

## Decision

Extend `.github/workflows/release.yml` instead of creating a second release
workflow or delegating release ownership to `tauri-apps/tauri-action`.

For every pushed `v*` tag, a Windows x64 job will:

1. check out the tagged source;
2. set up the repository-managed Node, pnpm, and Rust toolchains;
3. derive and validate the SemVer bundle version from the tag;
4. build the existing NSIS target with a Tauri configuration overlay that
   changes only `version`;
5. run the existing package verifier;
6. stage the installer under a stable release-asset name and create a SHA-256
   checksum file; and
7. upload both files as a private workflow artifact for the Linux release job.

The existing release job will depend on the Windows build, download that
workflow artifact, and attach both files to GoReleaser's draft GitHub Release
before the current publication step. GoReleaser, release-please, GHCR tags,
Homebrew publication, and GitHub Release notes remain owned by their current
steps.

This ordering keeps publication atomic: a failed Windows build or upload stops
the draft from becoming public, rather than leaving a public release without
the advertised installer.

## Version And Asset Contract

The pushed tag remains the release version source of truth. A tag such as
`v0.5.0-beta.1` supplies Tauri with `0.5.0-beta.1` through its supported
`--config` merge option. The tracked `0.1.0` value remains suitable for local
POC builds, so release automation does not rewrite or commit package manifests.

GitHub Releases will expose stable, product-oriented asset names rather than
Tauri's implementation-specific output path:

- `Chatto_<version>_x64-setup.exe`
- `Chatto_<version>_x64-setup.exe.sha256`

The build will fail if the version is invalid, the expected NSIS installer is
missing or ambiguous, package verification fails, or either release asset
cannot be uploaded.

## Security And Signing

The Windows build job receives read-only repository contents and no publishing
credentials. Only the existing Linux release job retains `contents: write` and
uploads to the draft release using the existing GoReleaser GitHub token.

The POC installer remains unsigned by explicit product decision. Windows
SmartScreen may therefore warn users. Authenticode signing, certificate secret
management, automatic updates, and installer attestations are separate
production-hardening work; this workflow must not imply that the unsigned
installer is signed or trusted.

## Alternatives Considered

`tauri-apps/tauri-action` can build and create GitHub Releases, but using it
here would introduce a second component that owns tags, drafts, and release
metadata already managed by release-please and GoReleaser.

A separate workflow triggered after a GitHub Release is published would be
more isolated and easier to rerun, but it would make an incomplete release
public before the installer succeeds. Attaching the installer after
publication also weakens the release's all-assets-ready guarantee.

## Regression Coverage And Verification

A focused repository test will parse the real workflow and assert the release
contract: the Windows job runs on `windows-latest`, builds the NSIS target with
the tag-derived version, verifies and uploads the installer/checksum workflow
artifact, and the publishing job depends on and attaches those files before
making the draft public.

Verification will also include `actionlint`, the desktop Rust tests and checks,
the repository's Docker/release validation where locally practical, license
metadata checks, and a Windows-native release build using the same version
overlay and packaging commands as CI. The workflow will not create a test tag
or publish a real GitHub Release during PR verification.
