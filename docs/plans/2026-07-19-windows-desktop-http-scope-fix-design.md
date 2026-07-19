# Windows Desktop HTTP Scope Fix Design

**Date:** 2026-07-19
**Status:** Approved

## Problem

The Windows desktop POC configures the Tauri HTTP plugin with HTTPS plus
loopback-only HTTP URL patterns. The IPv6 loopback entry uses the literal
pattern `http://[::1]:*`. Tauri's `urlpattern` parser treats unescaped colons as
pattern syntax, rejects that entry, and consequently cannot deserialize the
HTTP scope for any request. Valid HTTPS server discovery then fails locally
before reaching the server, while the frontend reports a misleading generic
connection/CORS error.

## Decision

Preserve the existing transport boundary and IPv6 loopback support. Encode the
IPv6 entry using URLPattern's escaped-colon form, represented in JSON as
`http://[\\:\\:1]:*`. This keeps the effective policy unchanged:

- HTTPS is allowed for self-hosted servers on any port.
- Plain HTTP is allowed only for `localhost`, `127.0.0.1`, and `[::1]`.
- Frontend runtime origin registration remains the narrower per-server
  allowlist.
- Redirects remain disabled and checked by the native adapter.

Removing IPv6 support would make the static Tauri policy disagree with the
frontend URL policy and desktop documentation. Replacing the Tauri HTTP plugin
with a custom Rust transport command would be disproportionate to a malformed
configuration entry.

## Regression Coverage

Extend the existing Rust configuration integration tests to read the real
`capabilities/default.json` file and parse every `http:default` allow entry
with `urlpattern` 0.3, the parser used by `tauri-plugin-http` 2.5.9. The test
must fail on the current literal IPv6 entry, pass after the escaped form is
applied, and explicitly prove that the IPv6 pattern matches an
`http://[::1]:<port>` URL.

`urlpattern` and `regex` will be direct development dependencies only. Both
are already transitive build dependencies of the shipped Tauri stack, so this
does not expand the runtime or installer dependency set.

## Verification

Verification will include:

1. the focused Rust configuration regression test in red and green states;
2. the complete desktop Rust test suite and desktop checks;
3. a Windows-native debug/release build using the corrected capability;
4. an automated WebView2 add-server probe against
   `https://chatto.bluhm.io`, which must reach the server preview without an
   HTTP-scope rejection;
5. package verification and relevant CI checks before handoff.

The fix will not alter server CORS configuration or broaden the desktop
renderer's allowed network destinations.
