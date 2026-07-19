# Windows Desktop HTTP Scope Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore native desktop HTTP connectivity while preserving HTTPS plus IPv4, hostname, and IPv6 loopback policy boundaries.

**Architecture:** Keep Tauri's static HTTP-plugin capability as the outer transport boundary and the frontend's reference-counted origin registry as the narrower runtime boundary. Correct the IPv6 URLPattern escaping and add a Rust configuration test that parses every real HTTP allow entry with the same `urlpattern` version used by `tauri-plugin-http`.

**Tech Stack:** Tauri 2.11, `tauri-plugin-http` 2.5.9, Rust, `urlpattern` 0.3, `regex`, WebView2, Playwright/CDP, PowerShell.

---

### Task 1: Add a capability parser regression test

**Files:**

- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.lock`
- Modify: `apps/desktop/src-tauri/tests/config.rs`
- Test: `apps/desktop/src-tauri/tests/config.rs`

**Step 1: Add test-only parser dependencies**

Add development dependencies already present transitively in the Tauri stack:

```toml
[dev-dependencies]
regex = "1.13.1"
urlpattern = "0.3.0"
```

Do not change production dependencies or plugin features.

**Step 2: Write the failing real-config test**

In `tests/config.rs`, add a helper mirroring `tauri-plugin-http` 2.5.9's URL
scope parsing normalization and a test that:

```rust
fn parse_http_scope_pattern(
    value: &str,
) -> Result<urlpattern::UrlPattern, urlpattern::quirks::Error> {
    let mut init =
        urlpattern::UrlPatternInit::parse_constructor_string::<regex::Regex>(value, None)?;
    if init.search.as_ref().map(|part| part.is_empty()).unwrap_or(true) {
        init.search.replace("*".to_string());
    }
    if init.hash.as_ref().map(|part| part.is_empty()).unwrap_or(true) {
        init.hash.replace("*".to_string());
    }
    if init
        .pathname
        .as_ref()
        .map(|part| part.is_empty() || part == "/")
        .unwrap_or(true)
    {
        init.pathname.replace("*".to_string());
    }
    urlpattern::UrlPattern::parse(init, Default::default())
}

#[test]
fn http_capability_url_patterns_are_valid() {
    // Read capabilities/default.json, find http:default, and parse every
    // allow[].url with parse_http_scope_pattern().
    // Assert that the IPv6 pattern also matches
    // http://[::1]:4000/api/connect.
}
```

Use the real capability file rather than duplicated fixtures. Include the
offending pattern in assertion messages without including any user data.

**Step 3: Run the focused test and verify RED**

Run:

```bash
mise x -- cargo test \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  --test config http_capability_url_patterns_are_valid -- --exact
```

Expected: FAIL because `http://[::1]:*` produces the same URLPattern tokenizer
error observed in the Windows Tauri IPC response.

Do not edit the capability until this failure has been observed.

### Task 2: Correct the IPv6 scope and verify GREEN

**Files:**

- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Test: `apps/desktop/src-tauri/tests/config.rs`

**Step 1: Apply the minimal capability correction**

Replace only the IPv6 entry:

```json
{ "url": "http://[\\:\\:1]:*" }
```

After JSON decoding, Tauri receives `http://[\:\:1]:*`, the escaped-colon
constructor pattern covered by `urlpattern`'s IPv6 conformance fixtures.

**Step 2: Run the focused test and verify GREEN**

Run:

```bash
mise x -- cargo test \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  --test config http_capability_url_patterns_are_valid -- --exact
```

Expected: PASS, including the explicit `[::1]:4000` match assertion.

**Step 3: Run desktop Rust verification**

Run:

```bash
mise x -- cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
mise x -- cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
mise x -- cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

Expected: every command exits 0 with no warnings or whitespace errors.

**Step 4: Commit the fix**

Stage only the desktop Cargo/config/test files and commit:

```bash
git commit -m "fix(desktop): validate native HTTP scopes"
```

### Task 3: Rebuild and verify on native Windows

**Files:**

- Verify: `apps/desktop/src-tauri/capabilities/default.json`
- Verify: Windows diagnostic executable and NSIS installer under a unique `C:\Temp` target
- Verify: `apps/desktop/tests/windows-acceptance.md`

**Step 1: Build the exact desktop frontend**

Run the desktop-targeted frontend build from WSL after the fix commit so its
visible marker identifies the corrected commit:

```bash
mise x -- pnpm run build:api-types
mise x -- pnpm --dir apps/frontend run build:desktop
```

Expected: the static frontend build succeeds with `VITE_CHATTO_DESKTOP=1`.

Synchronize the corrected tracked desktop source and frontend `build/` output
to a unique native Windows temporary source directory. Preserve the user's
WSL working tree and do not touch `cli/data.oldbak-23944/`.

**Step 2: Run the Windows-native Rust tests**

From native Windows PowerShell, using Node 22 and the stable MSVC Rust
toolchain, run:

```powershell
cargo test --manifest-path apps\desktop\src-tauri\Cargo.toml
```

Expected: all desktop Rust unit and integration tests pass on Windows.

**Step 3: Build the corrected Windows executable and NSIS installer**

Use a unique `CARGO_TARGET_DIR` on `C:\Temp` and invoke Tauri with the already
built frontend so final Cargo/Tauri compilation happens on native Windows.

Expected outputs:

```text
C:\Temp\chatto-desktop-target-<fix-sha>\release\chatto-desktop.exe
C:\Temp\chatto-desktop-target-<fix-sha>\release\bundle\nsis\Chatto_0.1.0_x64-setup.exe
```

**Step 4: Verify the installed capability at runtime**

Launch an isolated debug build with a distinct application identifier and a
local-only WebView2 CDP port. Drive the add-server flow with Playwright:

1. Open **Add Server**.
2. Enter `https://chatto.bluhm.io`.
3. Select **Connect**.
4. Assert the preview reaches the static **Sign in** action and renders the
   public server name.
5. Assert no `plugin:http|fetch` scope-deserialization error occurred.

Do not authenticate, collect credentials, or inspect private chat data.

**Step 5: Verify the package and record evidence**

Run `apps/desktop/scripts/verify-package.ps1` with the explicit installer path
and a unique `%TEMP%` evidence directory. Record installer size, SHA-256,
signature state, application marker, and the corrected server-preview smoke
test. Keep evidence out of the repository.

### Task 4: Final branch verification and PR update

**Files:**

- Verify: all files changed since `origin/main`
- Update: PR #20 body/checklist only if the stored description needs the new
  regression/build evidence

**Step 1: Run repository-level checks proportionate to the change**

Run:

```bash
mise test-desktop
mise license-check
git diff --check origin/main...HEAD
```

Expected: all commands pass. If `mise test-desktop` repeats the focused Rust
suite, report both signals without describing them as independent coverage.

**Step 2: Inspect branch state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
```

Expected: only the pre-existing untracked `cli/data.oldbak-23944/` remains;
all fix files are committed.

**Step 3: Push and inspect CI**

Push `feat/windows-desktop-poc`, inspect PR #20 with `gh`, and monitor its
checks. Fix any regression introduced by this change before handoff.
