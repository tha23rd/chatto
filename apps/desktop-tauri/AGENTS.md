# Windows desktop client guidance

This package is the thin Tauri host for Chatto's shared SvelteKit frontend.

- Keep product behaviour and UI in `apps/frontend`; desktop-only code should be
  limited to OS integration, transport adapters, window lifecycle, and security
  policy.
- The proof of concept supports Windows 10/11 with the WebView2 Evergreen
  Runtime. Do not add Linux or macOS packaging without an explicit product
  decision.
- Prefer narrow Tauri commands and scoped plugin permissions. Do not enable
  shell, unrestricted filesystem, or unrestricted network access.
- Validate remote server URLs in Rust as well as TypeScript. Never include a
  rejected URL, credentials, tokens, or full query strings in logs or errors.
- Keep the desktop bundle small. New native dependencies need a concrete host
  capability that cannot reasonably remain in the shared web client.
- Treat LiveKit media controls as a separate optimisation seam. Do not replace
  LiveKit's protocol or fork its SDK merely to expose desktop capture controls.
- Run Rust tests and the shared frontend tests relevant to every native bridge
  change. A release build must also be verified with the Windows Rust toolchain;
  a WSL-only build is not evidence that WebView2 packaging works.
