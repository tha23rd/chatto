# Desktop Release Version Display Design

## Problem

Packaged desktop releases set the Tauri package version to the exact Stable or
Nightly release version, but the embedded SvelteKit build falls back to the
frontend package version. The header and About dialog therefore display
`0.4.8` instead of the installed native version.

## Decision

`build-release.ps1` will set `CHATTO_BUILD_VERSION` to its validated `$Version`
only while invoking the Tauri build, then restore the caller's previous value.
SvelteKit already treats that variable as its highest-priority build version,
so both existing version displays will match the Tauri updater without adding
desktop-specific UI state.

The displayed value describes the version currently installed and running. A
newer downloaded candidate remains separate in the desktop-update prompt until
the user installs it.

## Verification

A release-workflow regression test will require the environment assignment to
precede `tauri build` and require the previous environment value to be restored.
The existing release-workflow suite and PowerShell parser check will validate
the change.
