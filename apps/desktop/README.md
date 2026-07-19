# Chatto for Windows

This package is a thin [Tauri 2](https://v2.tauri.app/) host around the shared
SvelteKit client in `apps/frontend`. It deliberately owns only native transport,
authentication, shortcuts, tray/window lifecycle, and future media capture
integration. Product UI and domain behaviour remain in the shared frontend.

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

While connected to a call, hold `Control+Shift+Space` to talk if the microphone
was muted when the key was pressed. Releasing the keys restores mute. The
shortcut works while Chatto is unfocused, never overrides deafen, and is
unregistered when the call ends.

Chatto has one process-wide global shortcut and tray menu. If calls remain
connected on multiple servers, the most recently started call owns those
controls. Ending it returns ownership to the previously connected call.

Closing the window hides it to the notification area. The tray menu can show
Chatto, mute/unmute, deafen/undeafen, or quit. Only **Quit** terminates the
desktop process.

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

## Unsigned POC packages and troubleshooting

POC installers are intentionally unsigned and may be blocked or warned about by
Windows. Test only an installer you built from a reviewed commit or whose
SHA-256 hash you independently verified. Do not disable Defender, SmartScreen,
TLS validation, or browser security controls; use a disposable Windows VM when
local policy does not permit unsigned software.

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
