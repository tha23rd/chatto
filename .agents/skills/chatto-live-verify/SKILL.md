---
name: "chatto-live-verify"
description: "Build and run the real bundled Chatto binary locally, then drive a feature end-to-end in a browser (Chrome DevTools MCP) to verify it works and capture screenshots. Use after implementing a user-facing feature, when asked to 'test it live', 'run the app', 'verify in the browser', or to produce screenshots for a PR."
---

# Chatto Live Verification

Verify a feature by running the actual bundled server and exercising it in a real
browser — not just tests/typecheck. Produces screenshots suitable for a PR.

This is the highest-signal check for UI-visible work: it catches runtime errors,
hydration issues, missing context, asset-URL problems, and permission gates that
static checks miss.

## When To Use

- After implementing anything user-visible (new page, component, reaction/render
  change, admin flow).
- When the user says "test in production", "test it live", "run the app", or asks
  for screenshots.
- Before opening a PR that touches the frontend — the PR body must embed the
  screenshots produced here (see `chatto-pr-checklist`).

## 1. Build the bundled binary (with seeded dev users)

The bundled binary embeds the built frontend from
`cli/internal/http_server/.client` and serves it. The `bootstrap` build tag seeds
dev users so you can log in; **without it there are zero users**.

```sh
# 1a. Build the frontend and copy it into the embed dir (this is what
#     `mise build-frontend` does):
mise build-frontend
# equivalent manual steps if a task is unavailable:
#   (cd apps/frontend && pnpm run build)
#   rm -rf cli/internal/http_server/.client
#   cp -r apps/frontend/build cli/internal/http_server/.client
#   touch cli/internal/http_server/.client/.gitkeep

# 1b. Build the server binary WITH the bootstrap tag (seeds alice/bob):
cd cli && mise x -- go build -tags bootstrap -o /tmp/chatto-live .
```

Seeded logins (only created on a fresh, empty data dir): `alice` = owner,
`bob` = user, password `foobar123` for both. See `cli/chatto.toml`
`[[bootstrap.users]]`.

## 2. Run it (fresh store, correct public URL)

```sh
cd cli
# Kill any stale/old chatto first (dev instances commonly hold :4000):
pkill -f 'chatto run' 2>/dev/null; sleep 1

# Start fresh so the bootstrap users actually seed. If cli/data already exists
# from a prior instance, move it aside (do NOT delete a real dev store):
[ -d data ] && mv data data.oldbak-$RANDOM

# CHATTO_WEBSERVER_URL MUST match the port you browse, or asset URLs
# (avatars, custom emoji, attachments) point at the wrong origin and 404.
CHATTO_WEBSERVER_URL=http://localhost:4000 /tmp/chatto-live run -c chatto.toml \
  > /tmp/chatto-live.log 2>&1 &
# Wait for: "Starting HTTP server addr=:4000 url=http://localhost:4000"
```

Need a specific role (e.g. verify an **admin** — not owner — can do something)?
Create it via the operator socket instead of relying on the owner:

```sh
/tmp/chatto-live operator user create --login alice --password foobar123 \
  --verified-email alice@example.com --role admin -c chatto.toml
/tmp/chatto-live operator user list -c chatto.toml
```

## 3. Drive it in the browser (Chrome DevTools MCP)

Use `mcp__chrome-devtools__*`. Prefer `take_snapshot` (a11y tree with `uid`s)
over screenshots for finding elements; screenshot for the visual record.

Typical loop: `navigate_page` → `take_snapshot` → `fill`/`click` (uids change
after navigation, re-snapshot) → assert.

Gotchas learned the hard way:

- **Login:** fill "Username or Email" + "Password", click "Sign In".
- **Message composer is a ProseMirror/tiptap contenteditable.** `fill` and
  synthetic `execCommand`/paste do NOT work. Click it to focus, then
  `type_text` (with `submitKey: "Enter"`). You must **join** a normal room
  first — restricted rooms (e.g. `announcements`) render the editor
  `contenteditable=false`.
- **File upload:** `upload_file` with the uid of the "Choose Image" button (it
  opens the file chooser) and an absolute `filePath`.
- **Hover bars / reaction pickers** often don't trigger from synthetic hover. To
  verify a reaction render deterministically, call the RPC directly from the
  authenticated page context, then reload and assert the DOM:
  ```js
  // evaluate_script — uses the session cookie, same-origin:
  await fetch('/api/connect/chatto.api.v1.MessageService/AddReaction', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Connect-Protocol-Version':'1'},
    body: JSON.stringify({ roomId, messageEventId, emoji })
  }).then(r => r.text());
  ```
- **Assert what actually rendered**, not just that an element exists. For images,
  check `img.complete === true` and `img.naturalWidth > 0` (proves it loaded,
  not a broken link):
  ```js
  [...document.querySelectorAll('img')]
    .filter(i => i.src.includes('/assets/emoji/'))
    .map(i => ({ src: i.src, ok: i.complete && i.naturalWidth > 0 }))
  ```

## 4. Capture screenshots for the PR

Save screenshots to `.context/` — it is **gitignored**. Never commit screenshot
binaries to the repo (not to `docs/`, not anywhere tracked).

```sh
mkdir -p .context/screenshots
```

Take `mcp__chrome-devtools__take_screenshot` with
`filePath: ".context/screenshots/<feature>-<state>.png"` for each meaningful
state (e.g. admin form, list, the feature in use). Scroll the target into view
first via `evaluate_script` (`el.scrollIntoView({block:'center'})`).

**Every UI-change PR must contain these screenshots** — added by **uploading**
them to the PR description (GitHub stores them as user-attachments, outside the
repo). CLI/`gh` cannot upload attachments, so hand the saved `.context/...` paths
to the user to drag-drop into the PR description. Do not commit the images or
embed `raw.githubusercontent.com` links to committed copies.

## 5. Clean up

```sh
pkill -f 'chatto run' 2>/dev/null
# Optionally restore a real dev store you moved aside:
#   rm -rf cli/data && mv cli/data.oldbak-* cli/data
```

`cli/data`, `cli/data.oldbak-*`, and `cli/internal/http_server/.client` are
gitignored build/runtime artifacts — never commit them.

## Notes

- If `mise` tasks are unavailable, the manual equivalents are inline above; the
  only hard tool deps are `buf` (codegen), Go, and Node 22 + pnpm.
- This skill verifies behavior. It does not replace `mise test` / `mise
  test-frontend` / `mise test-e2e`; run those too for regression coverage.
