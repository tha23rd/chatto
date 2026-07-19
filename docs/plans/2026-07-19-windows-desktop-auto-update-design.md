# Windows Desktop Auto-Update Design

**Date:** 2026-07-19
**Status:** Approved

## Problem

Chatto's native Windows client is currently distributed as an unsigned NSIS
installer attached to an immutable GitHub prerelease for every successful
`main-native` push. Users must notice the release, visit GitHub Releases,
download the installer, verify it manually, and run it themselves.

The desktop shell deliberately disables the web client's service worker and
version polling because the packaged application owns its lifecycle. It must
therefore provide a native update path that is secure, unobtrusive, resilient
to release-infrastructure failures, and independent of any self-hosted Chatto
server.

Existing desktop builds do not contain updater code. The first updater-enabled
release is necessarily a one-time manual bridge installation; subsequent
releases can update themselves.

## Product Decisions

- Stable is the default channel.
- Nightly is an explicit opt-in channel and receives every successful
  `main-native` build.
- The desktop client has an independent version line rather than sharing the
  server release version.
- Updates download automatically after discovery and signature validation.
- Installation requires an explicit restart action. Users can always defer it,
  and Chatto never terminates itself automatically.
- Update prompts are suppressed during calls and screen sharing.
- Switching from Nightly to Stable changes the selected feed immediately but
  never automatically downgrades the installed application. The installed
  Nightly remains until a newer Stable supersedes it.

## Architecture

The updater uses Tauri's native updater plugin from Rust. The shared renderer
receives a narrow Chatto-owned command and event surface; it does not receive
generic updater, process, shell, or filesystem authority.

Large immutable artifacts remain on GitHub Releases. Two small, public,
Chatto-owned manifests provide stable channel pointers:

```text
https://updates.chatto.run/desktop/stable/windows-x86_64.json
https://updates.chatto.run/desktop/nightly/windows-x86_64.json
```

Each manifest contains the version, publication time, human-readable notes,
GitHub Release asset URL, and the literal Tauri updater signature required for
`windows-x86_64`. The manifests contain no user, server, installation, or
telemetry data. Clients make anonymous HTTPS GET requests and do not send
Chatto credentials.

The endpoints are hard-coded in the native application. The renderer selects
only a `Stable` or `Nightly` enum; it cannot provide an arbitrary update URL,
signature, target, or downgrade policy.

## Version And Release Contract

Stable desktop releases use ordinary three-component semantic versions and
dedicated tags:

```text
0.2.0
desktop-v0.2.0
```

Nightly versions identify the next intended stable desktop line and contain a
monotonically increasing UTC build timestamp plus GitHub Actions run number:

```text
0.3.0-nightly.20260719.1234
desktop-v0.3.0-nightly.20260719.1234
```

The source commit remains in release metadata and notes, not in the portion of
the version used for ordering. This replaces commit-hash lexical ordering,
which cannot reliably tell the updater which build is newer.

Stable publication is an explicit release operation from a reviewed
`main-native` commit. Nightly publication remains automatic after all required
CI jobs succeed. Neither channel is coupled to the server's `v*` release tags.

## Signing And Trust

Two distinct signatures are required:

1. Tauri updater artifact signing proves to an installed Chatto client that an
   update artifact was authorized by Chatto. The public key is embedded in the
   application. The encrypted private key and password are protected as GitHub
   Actions secrets and are never written to artifacts or logs.
2. Windows Authenticode signing identifies the publisher to Windows and signs
   the executable, installer, and uninstaller. Timestamping keeps a valid
   release verifiable after the signing certificate expires.

Updater verification cannot be bypassed. A missing, malformed, or invalid
signature is an unavailable update, never a warning the user can click through.
Key rotation requires a bridge release trusted by the old key and embedding the
new public key; signing-key loss must be treated as a release-blocking incident.

Release jobs use least-privilege GitHub permissions. Pull-request workflows do
not receive signing secrets and cannot publish channel manifests.

## Publication Transaction

The release pipeline performs these phases in order:

1. Calculate and validate the desktop version and immutable tag.
2. Build the Windows executable and NSIS installer on a native Windows runner.
3. Authenticode-sign the executable, installer, and uninstaller.
4. Generate the Tauri updater artifact and detached signature.
5. Run package, signature, checksum, and Windows smoke verification.
6. Upload all immutable assets to a draft GitHub Release.
7. Download the assets from the draft and verify their stored bytes again.
8. Publish the GitHub Release.
9. Generate, validate, and atomically publish the selected channel manifest.
10. Read the public manifest and artifact back and verify the complete update
    path before reporting success.

The manifest update is the final visibility boundary. If any preceding step
fails, installed clients continue seeing the previous valid release. A channel
manifest must never point at a draft, missing, partially uploaded, or unverified
asset.

## Native Update Lifecycle

The native host owns a single process-wide update manager with these states:

```text
idle -> checking -> available -> downloading -> ready
                  \-> idle
                  \-> failed -> idle
```

Only one check or download can run at a time. Duplicate requests join or return
the current state rather than starting parallel transfers.

Chatto checks shortly after the renderer is ready and then every six hours with
bounded timeouts. A manual check bypasses the interval but not the single-flight
guard. Background failures remain unobtrusive; manual failures return a concise,
non-sensitive error suitable for a toast. The next scheduled interval retries.

The manager downloads into Tauri's updater-controlled location, reports bounded
progress, verifies the artifact, and enters `ready`. Installation begins only
after an explicit user action and uses Windows' passive installer mode. The
client relaunches after successful installation.

Update errors never prevent startup, sign-in, messaging, calls, tray behavior,
or shutdown. Logs include only the channel, target, current/candidate versions,
coarse lifecycle state, and a normalized error category. They do not include
full URLs, request headers, local paths, credentials, or server/account data.

## Settings And User Experience

Desktop Settings shows:

- current desktop version;
- selected channel;
- last successful check time or an explicit never/unavailable state;
- current update state;
- a **Check for updates** action.

Stable is selected initially. Enabling Nightly requires confirmation that
Nightly builds arrive frequently and may be less reliable. Switching back to
Stable explains when the installed Nightly is newer than the latest Stable and
that Chatto will wait rather than downgrade.

Background download progress is quiet. When an update is ready, Chatto shows a
durable update indicator and offers **Restart now** and **Later**. **Later**
never starts a countdown or forced shutdown. The prompt may return after the
next launch or a reasonable reminder interval.

If a call or screen share is active when the update becomes ready, Chatto keeps
the indicator but suppresses the restart prompt. The prompt can appear after
all calls and shares end. An explicit user action from Settings may still start
the restart after a confirmation explaining that active media will disconnect.

All visible strings use the Paraglide British-English source catalog and every
complete translation, with US-English overrides only where wording differs.

## Channel Changes And Downgrades

Changing channels affects subsequent checks immediately. It does not cancel a
verified update whose installation has already been explicitly requested.

The updater never enables automatic downgrades. When a user returns to Stable
from a newer Nightly, no Stable update is offered until the Stable version has
greater semantic precedence. Settings explains this state. An immediate manual
reinstall remains a support escape hatch but is not part of the in-app flow.

## Withdrawal, Rollback, And Recovery

A bad release can be removed from its channel manifest to stop new discovery.
Clients that already downloaded but did not install it must revalidate update
availability before installation or discard a withdrawn candidate.

Clients that already installed a bad version are repaired with a higher version
on the same channel. Chatto does not silently roll back because older code may
not understand local state written by newer code.

If `updates.chatto.run` or GitHub is unavailable, the installed application
continues normally. The previous manifest may be served with conservative CDN
cache controls and an atomic replacement; serving stale metadata is preferable
to serving a partially written manifest.

## Verification

Automated coverage includes:

- Rust unit tests for channel parsing, hard-coded endpoint selection,
  single-flight state transitions, timeout/error normalization, prompt
  suppression inputs, and no-downgrade behavior;
- workflow/script tests for monotonic versions, expected updater assets,
  secret isolation, draft verification, publication ordering, manifest schema,
  atomic channel advancement, and failure preservation;
- frontend unit and mounted component tests for channel confirmation, status
  rendering, manual checks, ready/deferred behavior, unavailable states, and
  active-call suppression;
- existing desktop security tests updated to allow only the narrow intended
  update bridge while continuing to reject generic updater/process authority;
- a native Windows acceptance upgrade from the previous signed Stable and
  Nightly installer, including offline startup, corrupted metadata, invalid
  signatures, interrupted downloads, Later, relaunch, channel switching, and
  an active-call deferral scenario.

The updater is not considered release-ready based only on WSL tests or mocked
renderer behavior. The real signed installer-to-installer path must pass on
Windows.

## Documentation Impact

Implementation updates the desktop README, Windows acceptance checklist,
release/operator documentation, user-facing desktop documentation, and the
relevant feature decision record. The documents must explain the one-time
bridge installation, channel semantics, signing-key custody and rotation,
release recovery, and the fact that client updates are independent of each
self-hosted server.

## Rejected Alternatives

A GitHub-only stable feed is simple, but a clean immutable Nightly channel needs
a mutable release or an additional pointer mechanism and gives Chatto less
control over withdrawal and recovery. A managed update service adds rollout
features but introduces cost and another critical dependency before Chatto
needs staged deployments. A self-hosted Chatto server must not select native
client updates because that would let an arbitrary deployment influence the
trusted application supply chain.
