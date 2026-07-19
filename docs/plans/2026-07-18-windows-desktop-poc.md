# Windows Desktop POC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a runnable Windows Tauri/WebView2 proof of concept that reuses Chatto's Svelte frontend, authenticates self-hosted servers safely, preserves realtime and LiveKit behavior, and adds global push-to-talk plus tray lifecycle.

**Architecture:** `apps/desktop` owns the Windows process, OAuth loopback listener, tray, Tauri permissions, and a bounded Rust realtime bridge. The existing static Svelte build remains the renderer and reaches native behavior through a frontend-owned `NativeHost`; browser behavior remains the default when the desktop capability is absent. LiveKit and E2EE stay in the renderer, while the desktop build routes registered-server HTTP and realtime traffic through native adapters behind reference-counted origin leases.

**Tech Stack:** SvelteKit/Svelte 5, Vitest, LiveKit JS, Tauri 2, Rust, Tokio-Tungstenite, WebView2, Tauri HTTP/global-shortcut/opener/single-instance plugins, GitHub Actions Windows runner.

---

### Task 1: Record the proposed architecture and documentation relationships

**Files:**

- Create: `docs/adr/ADR-052-windows-desktop-client.md`
- Modify: `docs/adr/INDEX.md`
- Modify: `docs/fdr/FDR-016-voice-calls.md`
- Modify: `docs/fdr/FDR-027-pwa-shell-and-service-worker.md`
- Modify: `NOTICE`

**Step 1: Write ADR-052**

Record the approved Tauri/WebView2-first decision, shared-renderer boundary,
native OAuth and transports, LiveKit-in-renderer decision, security policy,
Windows-only scope, Electron fallback rule, and POC decision gate. Use ADR-052
because the paused relayed-authorship branch already reserves ADR-051.

**Step 2: Update the ADR index and related FDRs**

Add the index row and cite ADR-052 from FDR-016 and FDR-027. Correct FDR-016's
stale statement that Chatto never publishes screen-share audio: browser support
is conditional and the desktop POC validates Windows entire-screen system audio.

**Step 3: Update dependency notice scope**

Add Tauri and the directly shipped desktop plugins to `NOTICE`; keep the host
under the repository's default AGPL-3.0-or-later boundary.

**Step 4: Verify documentation hygiene**

Run: `git diff --check -- docs/adr docs/fdr NOTICE`

Expected: exit 0 with no whitespace errors.

**Step 5: Commit**

Run: `git commit -m "docs(adr): propose Windows desktop client"`

### Task 2: Add a desktop-specific frontend build target

**Files:**

- Create: `apps/frontend/scripts/run-desktop.mjs`
- Create: `apps/frontend/scripts/run-desktop.spec.ts`
- Modify: `apps/frontend/package.json`
- Modify: `apps/frontend/svelte.config.js`

**Step 1: Write the failing target-policy test**

Test that desktop environment construction sets
`CHATTO_FRONTEND_TARGET=desktop` and `VITE_CHATTO_DESKTOP=1` without dropping the
caller's environment.

Run: `mise x -- pnpm --dir apps/frontend exec vitest --run scripts/run-desktop.spec.ts`

Expected: FAIL because `run-desktop.mjs` does not exist.

**Step 2: Implement the target runner and scripts**

Export a pure `desktopEnvironment(environment)` helper and, when invoked as a
script, spawn the requested `pnpm` command with the desktop variables. Add
`build:desktop` and `dev:desktop` package scripts.

**Step 3: Disable web-owned lifecycle features in desktop builds**

In `svelte.config.js`, set `kit.serviceWorker.register` to false and
`kit.version.pollInterval` to zero only when
`CHATTO_FRONTEND_TARGET === 'desktop'`. Leave the web build unchanged.

**Step 4: Verify red-to-green and both build policies**

Run: `mise x -- pnpm --dir apps/frontend exec vitest --run scripts/run-desktop.spec.ts`

Expected: PASS.

Run: `mise x -- pnpm --dir apps/frontend run build:desktop`

Expected: the static build succeeds and contains no service-worker registration
asset.

**Step 5: Commit**

Run: `git commit -m "feat(frontend): add desktop build target"`

### Task 3: Define the frontend-owned NativeHost and URL policy

**Files:**

- Create: `apps/frontend/src/lib/native/types.ts`
- Create: `apps/frontend/src/lib/native/urlPolicy.ts`
- Create: `apps/frontend/src/lib/native/urlPolicy.spec.ts`
- Create: `apps/frontend/src/lib/native/browserHost.ts`
- Create: `apps/frontend/src/lib/native/host.ts`
- Create: `apps/frontend/src/lib/native/host.spec.ts`

**Step 1: Write failing URL-policy tests**

Cover HTTPS/WSS acceptance, HTTP/WS loopback acceptance, and rejection of
credentials, fragments, unsupported protocols, non-loopback plaintext URLs,
and malformed input.

Run: `mise x -- pnpm --dir apps/frontend exec vitest --run src/lib/native/urlPolicy.spec.ts`

Expected: FAIL because the policy is missing.

**Step 2: Implement the minimal policy**

Expose `assertAllowedServerUrl()` and `assertAllowedRealtimeUrl()` returning
canonical origins/URLs. Never include query strings in thrown errors.

**Step 3: Write failing host-selection tests**

Test that the browser host reports API version 1 with all native capabilities
false and that a supplied desktop host is selected only for the desktop build.

**Step 4: Implement the contract and browser host**

Define typed OAuth, call-control, PTT, fetch, realtime socket, and lifecycle
operations. Keep the singleton replaceable in tests without exposing Tauri
globals to callers.

**Step 5: Run tests and commit**

Run: `mise x -- pnpm --dir apps/frontend exec vitest --run src/lib/native/urlPolicy.spec.ts src/lib/native/host.spec.ts`

Expected: PASS.

Run: `git commit -m "feat(frontend): define native host boundary"`

### Task 4: Scaffold the Tauri/WebView2 host

**Files:**

- Create: `apps/desktop/AGENTS.md`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/build.rs`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/capabilities/main.json`
- Create: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/icons/*`
- Modify: `mise.toml`
- Modify: `pnpm-lock.yaml`

**Step 1: Scaffold with the official Tauri CLI**

Initialize a Tauri 2 application whose `frontendDist` is
`../../frontend/build`, whose before-build command runs the frontend desktop
build, and whose development URL uses the frontend desktop dev server. Generate
Windows icons from `apps/frontend/static/icons/icon-512.png`.

**Step 2: Set Windows-only configuration**

Use identifier `com.chatto.desktop`, WebView2, one main window, tray-icon
support, NSIS bundling, and the minimum API capabilities. Add a strict CSP that
permits packaged assets, WebAssembly/workers needed by LiveKit, HTTPS/WSS
servers, and loopback development endpoints without permitting arbitrary
remote scripts or frames.

**Step 3: Install only required plugins**

Add Tauri API plus HTTP, global-shortcut, opener, and single-instance guest
bindings. Add matching Rust plugins and Tokio-Tungstenite for the narrow
app-owned realtime bridge. Do not add updater, filesystem, shell, notification,
or autostart permissions in the POC.

**Step 4: Add mise tasks**

Add `check-desktop`, `test-desktop`, `build-desktop`, and `dev-desktop` tasks
that delegate to the workspace package and Cargo manifest.

**Step 5: Verify scaffold and commit**

Run: `mise x -- pnpm --filter chatto-desktop exec tsc --noEmit`

Run: `cargo metadata --manifest-path apps/desktop/src-tauri/Cargo.toml --no-deps`

Expected: both exit 0.

Run: `git commit -m "feat(desktop): scaffold Tauri Windows host"`

### Task 5: Route ConnectRPC through the native HTTP client

**Files:**

- Create: `apps/frontend/src/lib/native/tauriHost.ts`
- Create: `apps/frontend/src/lib/native/tauriHost.spec.ts`
- Create: `apps/frontend/src/lib/api-client/connect.spec.ts`
- Modify: `apps/frontend/src/lib/api-client/connect.ts`
- Modify: `apps/frontend/src/lib/native/host.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/capabilities/main.json`

**Step 1: Write failing transport-selection tests**

Test that browser builds omit a custom fetch, desktop requests to allowed
server URLs use the native fetch, and rejected plaintext/non-server URLs never
reach the plugin.

Run: `mise x -- pnpm --dir apps/frontend exec vitest --run src/lib/api-client/connect.spec.ts src/lib/native/tauriHost.spec.ts`

Expected: FAIL before the adapter exists.

**Step 2: Implement Tauri HTTP adaptation**

Wrap `@tauri-apps/plugin-http`'s Fetch-compatible API. Pass it as the optional
`fetch` implementation to `createConnectTransport` for allowed absolute desktop
server endpoints. Preserve browser fetch for relative/web-origin calls. Require
a reference-counted origin lease from the saved-server registry or Add Server
probe, disable redirects, and reject a response that reports another origin.

**Step 3: Restrict capability scope**

Grant HTTP only to HTTPS destinations and loopback HTTP development endpoints.
Do not enable unsafe headers unless a failing bearer-auth test demonstrates it
is required.

**Step 4: Verify and commit**

Run the targeted tests, frontend typecheck, and `cargo check` for the desktop
manifest. Expected: all exit 0.

Run: `git commit -m "feat(desktop): add native ConnectRPC transport"`

### Task 6: Adapt realtime WebSockets without weakening server origin checks

**Files:**

- Create: `apps/frontend/src/lib/native/tauriRealtimeSocket.ts`
- Create: `apps/frontend/src/lib/native/tauriRealtimeSocket.spec.ts`
- Modify: `apps/frontend/src/lib/state/server/eventBus.svelte.ts`
- Modify: `apps/frontend/src/lib/state/server/eventBus.svelte.spec.ts`
- Modify: `apps/frontend/src/lib/native/tauriHost.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/src/realtime.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`

**Step 1: Write failing async-factory tests**

Extend the event-bus tests to prove a socket factory may resolve asynchronously,
that stop/reconnect invalidates a late socket, and that a connection failure
enters the existing retry state.

**Step 2: Make the event-bus factory async-capable**

Allow `RealtimeSocketFactory` to return a socket or promise. Await the current
generation before attaching handlers; close stale sockets. Promote the
test-only setter to the platform transport seam while retaining test reset.

**Step 3: Implement the bounded native WebSocket bridge**

Map Rust `Text`, `Binary`, `Close`, and error events onto the existing socket
contract; map `send` and `close` to asynchronous Tauri commands without leaking
unhandled rejections. Reject non-WSS/non-loopback URLs in both layers. Bound
active connections, buffers, frames, messages, and the outbound queue, and add
pull-based inbound delivery so WebView IPC and TCP apply backpressure. Add
native regression tests proving an interrupted socket is removed from process
state and a quiet socket stays connected across IPC receive heartbeats.

**Step 4: Verify and commit**

Run: `mise x -- pnpm --dir apps/frontend exec vitest --run src/lib/state/server/eventBus.svelte.spec.ts src/lib/native/tauriRealtimeSocket.spec.ts`

Expected: PASS.

Run: `git commit -m "feat(desktop): add native realtime transport"`

### Task 7: Implement system-browser OAuth with loopback PKCE

**Files:**

- Create: `apps/frontend/src/lib/auth/serverOAuth.ts`
- Create: `apps/frontend/src/lib/auth/serverOAuth.spec.ts`
- Modify: `apps/frontend/src/lib/auth/reauth.ts`
- Modify: `apps/frontend/src/routes/servers/callback/+page.svelte`
- Create: `apps/desktop/src-tauri/src/oauth.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Step 1: Write failing frontend completion tests**

Test adding a newly authenticated server, replacing authentication for an
existing server, preserving trusted server metadata, and returning the route
for the authenticated server without duplicating registry code.

**Step 2: Extract shared completion logic**

Move token-response validation and registry mutation from the callback page to
`serverOAuth.ts`. Keep the web callback's status/error UI and browser redirect
flow unchanged.

**Step 3: Write failing Rust OAuth tests**

Cover HTTPS/loopback server validation, authorization URL construction,
loopback request parsing, state mismatch, provider error, response-size bounds,
and rejection of credentials/fragments. Tests must not open a browser or make a
network request.

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml oauth::tests`

Expected: FAIL until the OAuth module exists.

**Step 4: Implement the native OAuth command**

Bind `127.0.0.1:0`, construct a `/servers/callback` redirect, open the remote
authorization URL in the system browser, accept one bounded callback request
with a short timeout, validate state, exchange the code with PKCE, return only
the token and user summary, and serve a small close-this-window result page.
Never log codes, tokens, identifiers, or query strings.

**Step 5: Select native or web flow in `reauth.ts`**

Desktop calls the native command, completes the registry update, and performs
SvelteKit navigation. Browser builds retain sessionStorage plus top-level
navigation.

**Step 6: Run Svelte analysis and tests**

Run the Svelte autofixer on the modified callback component and `reauth.ts`,
then run targeted Vitest and Cargo tests. Expected: no Svelte issues and all
tests pass.

**Step 7: Commit**

Run: `git commit -m "feat(desktop): add loopback OAuth login"`

### Task 8: Implement secure window, single-instance, and tray lifecycle

**Files:**

- Create: `apps/desktop/src-tauri/src/shell.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/tests/config.rs`

**Step 1: Write failing configuration/security tests**

Parse `tauri.conf.json` and assert that no remote URL is configured as the main
window, the CSP blocks remote scripts/frames, devtools are disabled in release,
and only the named capability is enabled.

**Step 2: Build the window and tray**

Create Show, Mute/unmute, Deafen/undeafen, and Quit menu items. Close hides the
main window; Show and a second process restore/focus it; explicit Quit exits.
Tray call actions emit typed events to the renderer. Do not create a shell or
filesystem command surface.

**Step 3: Block remote navigation**

Allow only the packaged app origin and the known local dev URL as top-level
navigation. Open approved HTTPS links with the system browser and reject all
other navigation/window creation.

**Step 4: Verify and commit**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: PASS.

Run: `git commit -m "feat(desktop): add secure tray lifecycle"`

### Task 9: Integrate global push-to-talk and tray call controls

**Files:**

- Create: `apps/frontend/src/lib/native/callControls.ts`
- Create: `apps/frontend/src/lib/native/callControls.spec.ts`
- Modify: `apps/frontend/src/lib/state/server/voiceCall.svelte.ts`
- Modify: `apps/frontend/src/lib/state/server/voiceCall.svelte.spec.ts`
- Modify: `apps/frontend/src/lib/native/tauriHost.ts`

**Step 1: Write failing momentary-microphone tests**

Cover press while muted, release restoring mute, press while already unmuted,
deafened behavior, duplicate press/release events, a release arriving while the
enable operation is pending, failure, and leave cleanup.

**Step 2: Implement serialized PTT state**

Add an explicit `setPushToTalkPressed()` operation to `VoiceCallState`. Reuse
the existing microphone operation guard and commit `isMuted` only after
LiveKit succeeds. PTT must never undeafen the user or leave the mic enabled
after release/cleanup.

**Step 3: Bind the active call to NativeHost**

Register `Control+Shift+Space` only while a call is connected. Forward pressed
and released states, mirror mute/deafen/connected state into the tray, and
route tray actions to the existing toggle methods. Dispose listeners and
unregister the shortcut on leave.

**Step 4: Analyze the Svelte module and verify tests**

Run the Svelte autofixer for `voiceCall.svelte.ts` and the targeted VoiceCall
and call-control tests. Expected: no issues; all tests pass.

**Step 5: Commit**

Run: `git commit -m "feat(desktop): add global push-to-talk"`

### Task 10: Add screen-share diagnostics for streaming decisions

**Files:**

- Create: `apps/frontend/src/lib/voice/webrtcDiagnostics.ts`
- Create: `apps/frontend/src/lib/voice/webrtcDiagnostics.spec.ts`
- Modify: `apps/frontend/src/lib/state/server/voiceCall.svelte.ts`
- Modify: `apps/frontend/src/lib/state/server/voiceCall.svelte.spec.ts`

**Step 1: Write failing stats-normalization tests**

Use synthetic `RTCStatsReport` entries to cover outbound bitrate deltas,
codec resolution, frames, frame drops, encode time, quality limitation reason,
packets/retransmits, RTT, and missing/unknown stats. Unknown values remain null;
they must not become healthy-looking zeroes.

**Step 2: Implement a bounded diagnostics collector**

Read `LocalTrack.getRTCStatsReport()` for the screen-share publication on a
low-frequency timer, normalize only non-sensitive media/network fields, retain
the latest sample plus a short bounded history, and stop on unpublish/leave.
Expose a read-only snapshot on `VoiceCallState` for the Windows acceptance run.

**Step 3: Verify and commit**

Run targeted diagnostics and VoiceCall tests plus the Svelte autofixer.

Expected: all pass with no warnings.

Run: `git commit -m "feat(voice): collect screen-share diagnostics"`

### Task 11: Add Windows acceptance and resource-measurement tooling

**Files:**

- Create: `apps/desktop/README.md`
- Create: `apps/desktop/scripts/measure-resources.ps1`
- Create: `apps/desktop/scripts/verify-package.ps1`
- Create: `apps/desktop/tests/windows-acceptance.md`

**Step 1: Document developer workflow**

Describe WSL versus native-Windows commands, WebView2 and Rust prerequisites,
standalone first-server onboarding, the PTT accelerator, unsigned POC
installer behavior, and troubleshooting that does not ask users to disable
security controls.

**Step 2: Add read-only measurement script**

Sample the Chatto process and its descendant WebView2 processes for CPU, working
set, private memory, and GPU-engine counters where Windows exposes them. Emit
timestamped JSON/CSV under an explicit caller-provided output directory; do not
collect window titles, command lines, URLs, account data, or network payloads.

**Step 3: Add the acceptance matrix**

Provide exact checks for bundled launch, OAuth, default/restricted transport,
E2EE voice, 720p30/60 and 1080p30/60, entire-screen audio, unfocused PTT, tray,
idle/call/share resources, and clean install/uninstall. Separate measured
results from required checks so an unrun manual check cannot be marked passed.

**Step 4: Validate PowerShell syntax on Windows and commit**

Run both scripts with PowerShell's parser and run the package verification in a
temporary output directory. Expected: parser succeeds; verification either
finds a built package or reports the exact missing prerequisite without
modifying the system.

Run: `git commit -m "docs(desktop): add Windows POC acceptance harness"`

### Task 12: Add Windows CI and perform final verification

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `mise.toml`

**Step 1: Add a Windows desktop CI job**

Use `windows-latest`, the repository setup action without Go dependencies, a
stable Rust toolchain, Cargo caching, frontend NativeHost tests, Cargo tests,
frontend desktop build, and `tauri build --no-bundle`. Do not publish or sign
artifacts in the POC job.

**Step 2: Run targeted checks**

Run:

```sh
mise test-desktop
mise check-desktop
mise x -- pnpm --dir apps/frontend exec vitest --run \
  src/lib/native src/lib/api-client/connect.spec.ts \
  src/lib/state/server/eventBus.svelte.spec.ts \
  src/lib/state/server/voiceCall.svelte.spec.ts \
  src/lib/voice/webrtcDiagnostics.spec.ts
```

Expected: all exit 0.

**Step 3: Run repository regression checks**

Run:

```sh
mise x -- pnpm run check:frontend
mise x -- pnpm run lint:frontend
mise x -- pnpm run test:frontend
mise license-check
git diff --check origin/main...HEAD
```

Expected: all exit 0. If a full check is unavailable from WSL, record the exact
failure and rely only on a fresh equivalent Windows/CI result; do not describe
an unrun check as passing.

**Step 4: Build on Windows**

From native Windows PowerShell, run the Cargo tests and
`pnpm --filter chatto-desktop tauri build`. Record installer/executable paths
and resource baselines in the PR without committing machine-specific outputs.

**Step 5: Review against the approved design**

Confirm every in-scope item has code or an explicitly unrun manual acceptance
checkbox, every out-of-scope item remains absent, the web build behavior is
unchanged, and the unrelated `cli/data.oldbak-23944/` directory is not staged.

**Step 6: Commit final CI wiring**

Run: `git commit -m "ci(desktop): verify Windows POC"`

**Step 7: Open and verify the PR**

Push `feat/windows-desktop-poc`, create a conventional-title PR using
`--body-file`, explain that it supersedes PR #19's Electron-first plan, link
ADR-052 and the design/acceptance documents, and list manual checks honestly.
Verify with:

```sh
gh pr view --json body,baseRefName,closingIssuesReferences
gh pr checks --watch
```
