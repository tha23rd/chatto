# Chatto for Windows

This package is a thin [Tauri 2](https://v2.tauri.app/) host around the shared
SvelteKit client in `apps/frontend`. It deliberately owns only native transport,
authentication, shortcuts, tray/window lifecycle, and future media capture
integration. Product UI and domain behaviour remain in the shared frontend.

## Desktop release channels

Native development targets the downstream `main-native` branch so `main` can
remain focused on the upstream web/server code. Merge `main` into
`main-native` to pick up upstream changes; native feature pull requests should
use `main-native` as their base.

Every successful push to `main-native` publishes a signed, immutable Nightly
prerelease on the repository's
[GitHub Releases page](https://github.com/tha23rd/chatto/releases). Nightly
versions are monotonic and use a UTC timestamp plus the GitHub Actions run
number:

```text
desktop-v0.1.0-nightly.20260719091530.1234
Chatto_0.1.0-nightly.20260719091530.1234_x64-setup.exe
Chatto_0.1.0-nightly.20260719091530.1234_x64-setup.exe.sig
Chatto_0.1.0-nightly.20260719091530.1234_x64-setup.exe.sha256
```

Stable releases are created only from an exact `desktop-vX.Y.Z` tag reachable
from `main-native`. The tag, desktop package versions, installer version, and
manifest version must all match. Stable is the default application channel;
Nightly is opt-in.

Both workflows build an unsigned beta installer and a Tauri updater signature.
They upload exactly five assets to a draft GitHub release, download and
reverify those stored bytes, publish the immutable release, then replace the
manifest on the rolling `desktop-stable` or `desktop-nightly` GitHub release. A
pull request never receives the updater private key, publishes a release, or
changes a live channel.

An existing installation without updater support needs one final manual bridge
install. After that, the native host downloads and verifies updates in the
background and the frontend offers a user-controlled restart.

### Maintainer release configuration

The beta release path needs one repository Actions secret:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (optional for an unencrypted CI key)

The matching public key is intentionally checked in at
`apps/desktop/updater-public-key.txt`. GitHub's built-in workflow token creates
the immutable and rolling releases; no Azure account, external object store, or
protected GitHub environment is required for beta publishing.

Keep the updater private key outside GitHub as an access-controlled, tested
backup. Record its custodians and recovery procedure. A public-key rotation
requires a bridge release that trusts the replacement key before later releases
are signed only by that key.

Before creating a Stable tag, update every desktop version to the same `X.Y.Z`,
merge the release commit to `main-native`, and create `desktop-vX.Y.Z` on that
commit. Nightly publishing needs no tag: it follows each successful
`main-native` build. Both routes intentionally publish draft-first and expose a
channel only after the GitHub assets, checksum, and updater signature pass
read-back verification.

Beta installers are not Authenticode-signed. Windows can show **Unknown
publisher** or a SmartScreen warning during the initial bridge installation and
installer-driven updates. Do not tell testers to disable Windows security
controls; document the warning and distribute installers only through the
repository release page. Authenticode and a dedicated atomic manifest store are
deferred until the desktop client moves beyond small beta testing.

To withdraw a bad update, remove `windows-x86_64.json` from its rolling
`desktop-stable` or `desktop-nightly` release, then publish a higher fixed
version. Never repoint Stable or Nightly to a lower version. Immutable
versioned manifests and GitHub assets remain as the audit record; an already
installed release cannot be recalled.

## Development

Install the normal Chatto prerequisites plus the Windows Tauri prerequisites:

- Windows 10 or Windows 11
- Microsoft C++ Build Tools with the "Desktop development with C++" workload
- WebView2 Evergreen Runtime
- Rust's stable `x86_64-pc-windows-msvc` toolchain
- `mise` and the repository-managed Node/pnpm toolchain

From a Windows terminal in the repository:

```powershell
mise run desktop-dev
```

The command starts the frontend in desktop mode and launches the WebView2 host.
Desktop mode produces a static client build and disables service-worker
registration and web version polling; the ordinary web build is unchanged.

Create the NSIS installer with:

```powershell
mise run desktop-build
```

By default, the installer is written under
`apps/desktop/src-tauri/target/release/bundle/nsis`. If `CARGO_TARGET_DIR` is
set, Tauri writes the executable and bundle beneath that directory instead.
WSL can run frontend and platform-independent tests, but it cannot establish
that a WebView2 executable or installer works. Run the native build and smoke
test with the Windows toolchain before merging or releasing.

### Working from WSL

The source may remain in WSL, but the final Cargo compile and Tauri packaging
must run as native Windows processes. Rust incremental compilation cannot use a
UNC output directory reliably, so place Cargo's target directory on the Windows
filesystem:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP 'chatto-desktop-target'
$env:CARGO_INCREMENTAL = '0'
Set-Location '\\wsl.localhost\Ubuntu\home\your-user\path\to\chatto'
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Windows Node tools reject a UNC current directory. Either keep a Windows clone
for packaging or use `pushd` from `cmd.exe`, which temporarily maps the WSL path
to a drive letter:

```powershell
cmd.exe /d /c "pushd \\wsl.localhost\Ubuntu\home\your-user\path\to\chatto && corepack pnpm --filter chatto-desktop tauri build"
```

Do not treat a Linux-target Cargo build as Windows verification. It exercises a
different webview and platform implementation.

Some Windows policies also treat `.ps1` files on the WSL UNC share as remote.
Keep that policy enabled: copy the acceptance script to a unique file under
`$env:TEMP`, run the local copy, and remove only that copy afterward. Pass
`-PackagePath` explicitly when the verifier is no longer beside the repository.

## First launch and server login

The desktop renderer is the same client as the web application, so first-server
onboarding remains familiar:

1. Launch Chatto and add the URL of the self-hosted server.
2. Use an `https://` server URL. Plain HTTP is accepted only for `localhost`,
   `127.0.0.1`, or `[::1]` development servers.
3. When OAuth is selected, Chatto opens the system browser. Complete login
   there; the browser returns to a short-lived loopback callback owned by this
   desktop process.

The callback listener uses an ephemeral port and closes after one bounded
response or a timeout. Tokens and callback query strings must not appear in
logs, screenshots, or acceptance evidence.

The desktop client leases native network access only for saved server origins
and for the server currently being probed in the Add Server dialog. HTTP
redirects are disabled and a response that reports another origin is rejected.
The ordinary web client keeps its browser transports, including support for
operator-approved non-loopback HTTP deployments; the desktop POC deliberately
requires HTTPS except for local development.

## Native call controls

Open **Settings → Keybinds** to assign system-wide controls for push-to-talk,
push-to-mute, mute, deafen, camera, screen sharing, and leaving a call.
`Control+Shift+Space` remains the default push-to-talk binding. Hold actions
restore the previous microphone state when released, never override deafen, and
are released and unregistered when the call ends.

Chatto has one process-wide keybinding owner and tray menu. If calls remain
connected on multiple servers, the most recently started call owns those
controls. Ending it returns ownership to the previously connected call. If
another application already owns a configured key combination, choose a
different binding; Chatto keeps the other available bindings active.

Closing the window hides it to the notification area. The tray menu can show
Chatto, mute/unmute, deafen/undeafen, or quit. Only **Quit** terminates the
desktop process.

While Chatto is running, a red dot overlays its Windows taskbar icon whenever
the shared client has at least one pending notification. The dot clears after
all pending notifications are handled. Ordinary unread rooms do not set it
unless their notification level creates a notification.

## Windows verification

Build the package before running the read-only verifier:

```powershell
$evidence = Join-Path $env:TEMP 'chatto-desktop-evidence'
./apps/desktop/scripts/verify-package.ps1 -OutputDirectory $evidence
```

During an idle, call, or screen-share scenario, record a resource sample using
the PID of `chatto-desktop.exe`:

```powershell
./apps/desktop/scripts/measure-resources.ps1 `
  -ProcessId 1234 `
  -OutputDirectory $evidence `
  -DurationSeconds 60 `
  -IntervalSeconds 1
```

The sampler records only process identifiers/names, CPU, memory, and available
GPU-engine utilisation for Chatto and its descendant WebView2 processes. It
does not collect window titles, command lines, URLs, account data, or network
payloads. Use [`tests/windows-acceptance.md`](tests/windows-acceptance.md) to
keep manual evidence separate from unrun requirements.

During a live screen share, open the quality gear on the local share tile and
choose **Copy to clipboard**. The versioned JSON contains only a bounded set of
normalized WebRTC sender statistics. Inspect it before attaching it to a PR and
keep the acceptance record free of user or server data.

## Troubleshooting

Test only an installer built from a reviewed commit or downloaded from the
project's GitHub Releases page. Do not disable Defender, SmartScreen, TLS
validation, or browser security controls.

- If the window cannot open, confirm the WebView2 Evergreen Runtime is installed
  and current through normal Microsoft/Windows Update channels.
- If native compilation fails, open a Developer PowerShell for Visual Studio and
  confirm the MSVC desktop workload and Windows SDK are installed.
- If pnpm reports that UNC paths are unsupported, use the `pushd` command above
  or a Windows clone.
- If OAuth times out, confirm the browser was allowed to reach the server and
  that another local security product did not block the ephemeral loopback
  callback. Do not make the callback externally reachable.
- If the global shortcut is already owned by another application, close or
  reconfigure that application for the test. The POC does not silently choose a
  different accelerator.
