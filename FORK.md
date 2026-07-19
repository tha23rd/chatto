# Maintaining the Chatto Fork

This repository tracks [`chattocorp/chatto`](https://github.com/chattocorp/chatto)
as the `upstream` remote and keeps fork-specific features on `origin/main`.
Upstream syncs must preserve upstream commit ancestry so later merges only
revisit genuinely overlapping changes.

## Sync upstream

Start from a clean, current fork main and create a dedicated sync branch:

```sh
git switch main
git fetch --multiple --prune origin upstream
git merge --ff-only origin/main
git switch -c chore/merge-upstream-main-YYYY-MM-DD
git merge --no-ff upstream/main
```

Before beginning a larger sync, a dry merge can show whether conflicts exist
without touching the worktree:

```sh
git merge-tree --write-tree --messages origin/main upstream/main
```

Open a pull request from the sync branch and merge it with GitHub's **merge
commit** method. Do not squash or rebase an upstream-sync pull request: either
would discard the ancestry that makes the next sync incremental.

Sync frequently. A small regular merge is easier to review than combining many
upstream architectural changes with the entire fork overlay at once.

## Resolve conflicts from sources of truth

- Resolve `.proto` sources first, then run `mise codegen-proto`. Do not
  hand-merge generated Go, TypeScript, ConnectRPC, or API-reference output.
- Resolve workspace package manifests first, then regenerate `pnpm-lock.yaml`
  with `mise x -- pnpm install --lockfile-only`.
- Resolve British English source messages and every complete translation
  catalog together, preserving placeholders and message structure.
- Keep upstream architecture as the baseline, then reapply fork behavior at
  the narrowest owning service, store, or component boundary.
- Never commit local runtime stores, generated verification data, or
  screenshots. In particular, `cli/data`, `cli/data.oldbak-*`, `.context`, and
  `cli/internal/http_server/.client` are disposable local artifacts.

Enable Git's recorded-resolution reuse in each maintainer clone so recurring
conflicts can reuse an earlier decision:

```sh
git config rerere.enabled true
git config rerere.autoupdate true
```

## Fork-only decision records

Keep `docs/fdr/INDEX.md` identical to upstream. Features intentionally
maintained only in this fork use the reserved `900–999` range and are listed
here instead, preventing collisions in both filenames and the upstream index:

- [FDR-900: Custom Emoji](docs/fdr/FDR-900-custom-emoji.md)
- [FDR-901: Microphone Noise Suppression](docs/fdr/FDR-901-microphone-noise-suppression.md)
- [FDR-902: Channel Webhooks](docs/fdr/FDR-902-channel-webhooks.md)
- [FDR-903: Soundboard](docs/fdr/FDR-903-soundboard.md)

## Verify a sync

Run checks at the level of the merged changes. A broad upstream sync should at
least include:

```sh
git diff --check
mise codegen-proto
mise lint
mise test
mise license-check
```

Verify user-visible conflict resolutions in the real bundled application and
record any intentionally deferred checks in the pull-request body. Before
merging, confirm the upstream commit is an ancestor of the sync branch:

```sh
git merge-base --is-ancestor upstream/main HEAD
```
