# Native Desktop Client Guidance

This directory contains Chatto's privileged desktop shell. It is an Apache-2.0
integration surface around the bundled Apache-2.0 frontend; it must not pull
server or CLI code into the shipped application.

## Security boundary

- Keep `contextIsolation`, Chromium sandboxing, and `webSecurity` enabled.
- Do not enable Node.js integration in a renderer.
- Add capabilities only through the typed `@chatto/native-bridge` contract.
  Never expose generic IPC, filesystem, process, shell-command, or arbitrary
  URL-opening primitives.
- Validate the sender and arguments again in the main process. The preload is
  a convenience boundary, not the final authorization boundary.
- Only the bundled `chatto-app://app` renderer is privileged. Never navigate a
  privileged renderer to remote content.
- Scope remote-origin header handling to exact origins explicitly registered
  by the renderer or to short-lived origins the user chose to probe.
- Keep OAuth in the system browser and return through the loopback callback.
- Deny permissions and new-window navigation unless explicitly required.

## Development

- Use `mise` tasks from the repository root where available.
- Keep pure policy code independently unit-tested. Electron smoke coverage
  should verify the bundled renderer, bridge, deep links, and hardened window.
- Build the frontend before launching or packaging the shell.
- Do not weaken a fuse or web preference to make a test pass.
- Keep platform-specific behavior fail-soft when a capability is unavailable.
- Update `NOTICE`, `REUSE.toml`, ADR-051, and this directory's README when the
  dependency or security boundary changes.
