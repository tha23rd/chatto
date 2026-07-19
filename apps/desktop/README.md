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

The installer is written under `apps/desktop/src-tauri/target/release/bundle/nsis`.
WSL can run frontend and platform-independent tests, but it cannot establish
that a WebView2 executable or installer works. Run the native build and smoke
test with the Windows toolchain before merging or releasing.
