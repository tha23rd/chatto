# Windows Desktop Beta Release Design

**Date:** 2026-07-20
**Status:** Approved

## Context

The first auto-update design used Azure Artifact Signing for Authenticode and a
separate object store for Stable and Nightly channel manifests. That is an
appropriate production target, but it requires cloud signing and storage
infrastructure that Chatto does not yet have. The Windows client is currently a
small beta, so this design keeps the security property required for in-app
updates while removing infrastructure that is not yet justified.

## Decision

Beta desktop releases use GitHub Releases for both immutable versioned assets
and rolling channel manifests. Tauri updater signatures remain mandatory.
Authenticode signing and the separate `updates.chatto.run` object store are
deferred until the desktop client is ready for broader production distribution.

The only long-lived release credential is the Tauri updater private key. Its
public key is checked into the desktop source and compiled into every client.
The private key is stored as a GitHub Actions secret and backed up outside
GitHub. Pull-request workflows never receive it.

## Channels And URLs

The client keeps Stable as its default and Nightly as an explicit opt-in. It
uses fixed GitHub-hosted manifest URLs:

```text
https://github.com/tha23rd/chatto/releases/download/desktop-stable/windows-x86_64.json
https://github.com/tha23rd/chatto/releases/download/desktop-nightly/windows-x86_64.json
```

`desktop-stable` and `desktop-nightly` are rolling channel releases containing
only the current channel manifest. Each manifest points to an installer on an
immutable versioned release such as
`desktop-v0.1.0-nightly.20260720104726.98`.

Nightly publication still follows a successful `main-native` CI run. Stable
publication still requires an explicit `desktop-vX.Y.Z` tag reachable from
`main-native`.

## Publication Flow

The release job:

1. Validates the source commit and monotonically increasing version.
2. Builds the Windows NSIS installer and updater artifact on GitHub's Windows
   runner without Authenticode signing.
3. Signs the updater artifact with the Tauri private key.
4. Verifies the updater signature, package metadata, and checksum locally.
5. Creates an immutable draft GitHub prerelease and uploads its assets.
6. Downloads the stored assets and verifies them again.
7. Publishes the immutable versioned release.
8. Replaces the selected rolling channel manifest with the verified manifest.
9. Downloads the public channel manifest and referenced artifact and verifies
   the complete path before succeeding.

Replacing a rolling GitHub asset is not perfectly atomic and can briefly return
404 while the asset changes. That trade-off is accepted for beta distribution.
The installed application treats update-check failures as non-fatal and retries
later. The immutable release remains available even if channel advancement
fails.

## Trust And User Experience

Tauri signature verification cannot be disabled: installed clients accept only
artifacts signed by the embedded updater key. This protects the automatic
update path independently of Windows publisher identity.

Because beta installers are not Authenticode-signed, Windows may show an
Unknown publisher or SmartScreen warning during initial installation or an
installer-driven update. Beta documentation calls this out plainly. Production
distribution should restore Authenticode before broad promotion.

Existing POC clients still require one manual bridge installation because they
do not contain the updater or its public key. Later releases update in-app.

## Key Custody

The beta signing key is generated once. The private key and optional password
are stored as `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub Actions secrets. A separate backup
is kept in an access-controlled password manager or encrypted vault.

Losing the key prevents existing clients from accepting future updates. Key
rotation requires a bridge release signed with the old key and embedding the
new public key. The public key is not secret and belongs in source control.

## Deferred Production Hardening

The following are deliberately deferred, not removed from the long-term plan:

- Authenticode publisher identity and timestamping;
- Azure workload identity and Artifact Signing;
- a dedicated object store and atomic channel publication;
- protected-environment approvals for production Stable publication.

Restoring these controls requires a new reviewed release design and must retain
the existing updater signing key or use a safe bridge-key rotation.

## Verification

Automated tests cover the fixed GitHub endpoints, required signing key,
immutable release publication, rolling channel replacement, monotonic version
guards, signature verification, read-back verification, and failure behavior.
Windows CI builds the unsigned installer and updater artifact. A manual beta
acceptance check confirms the expected Windows warning, successful bridge
install, update discovery, verified download, deferred restart, and upgrade to
a later Nightly.
