# Upstream Integration

## Contents

- Provenance preflight
- Integration branch and merge
- Semantic review and specialist routing
- Compatibility forecast
- Verification
- Main pull request

## Provenance preflight

1. Confirm the repository and remotes before fetching:
   - `origin` must identify the intended `tha23rd/chatto` fork for fetch and
     push.
   - `upstream` must identify `chattocorp/chatto` for fetch and must not be a
     usable push target.
2. Preserve unrelated user changes. Stop on dirty tracked files that overlap
   the sync; do not stash, discard, or rewrite them without approval.
3. Fetch `origin` and `upstream` separately with pruning.
4. Use `gh pr list` to find competing open upstream-to-main or
   main-to-main-native synchronization PRs.
5. Resolve and journal:
   - current `upstream/main`;
   - last upstream parent already integrated into `origin/main`;
   - pre-merge `origin/main`;
   - current `origin/main-native`;
   - current production commit, version, and digest when available; and
   - latest native release commit and tag when available.
6. Prove the candidate is a descendant of the last integrated upstream parent.
   Stop on rewritten, missing, or ambiguous ancestry.
7. Inventory the full upstream commit and path range before merging.

Treat the recorded candidate SHA as immutable. If `upstream/main`,
`origin/main`, or a competing PR moves, journal the drift and stop. Present the
reviewed SHA and new SHA; either requalify the new head or obtain an explicit
cutoff. Never change the candidate silently.

## Integration branch and merge

Create a dedicated branch from the exact recorded `origin/main` baseline.
Merge the exact upstream candidate SHA with a normal merge commit. Do not
flatten upstream history through squash, rebase, cherry-pick, or a synthetic
tree replacement.

For every conflict:

1. inspect base, fork, and upstream versions;
2. recover both sides' intent;
3. document material decisions in the journal and PR;
4. regenerate derived output with repository tooling; and
5. inspect the completed merge against both parents.

Audit adjacent cleanly merged code and these common fork-owned surfaces even
when Git reports no conflict:

- discovery compatibility and version gates;
- ConnectRPC, protobuf, realtime, and persisted core messages;
- native renderer and host contracts;
- voice, LiveKit, soundboard, custom emoji, role colours, and webhooks;
- complete translation catalogs;
- fork GHCR and native release workflows;
- licensing and `NOTICE`; and
- deployment and configuration assumptions.

When upstream and fork desktop implementations overlap, preserve their
independent implementation and release-line ownership unless the user approves
a material architecture change.

## Semantic review and specialist routing

Recompute the changed-path inventory after conflict resolution. Classify every
affected path as Chatto, Authling, shared framework, or repository-wide.

- For `authling/`, read `authling/AGENTS.md` completely and keep Authling
  behavior, architecture, vocabulary, and docs under `authling/`.
- For `pkg/events`, `pkg/natsruntime`, `pkg/datacrypto`, or `pkg/appconfig`,
  read `cli/AGENTS.md`, `authling/AGENTS.md`, the module `AGENTS.md`, ADR-057,
  and the module ADR required by root instructions. Prove the shared module
  remains product-neutral.
- For Chatto-owned public protobufs, ConnectRPC, discovery, realtime, auth,
  errors, pagination, visibility, or generated clients, use
  `chatto-api-compatibility`.
- For Chatto-owned durable facts, stored protobufs, projections, snapshots,
  replay, OCC, read-your-writes, or live delivery, use
  `chatto-event-sourcing`.
- For Chatto runtime components, NATS resources, subjects, state, effects,
  interfaces, or realtime topology, use `chatto-architecture-inventory`.
- For `.svelte` or `.svelte.ts`/`.svelte.js`, read frontend instructions and
  use both required Svelte skills.

Do not apply the Chatto-prefixed specialists to Authling-owned or
shared-framework behavior. Those boundaries follow their own instructions and
applicable `authling-*` or global skills.

Classify public changes as additive, behavioral, deprecated, or breaking.
State older-client/newer-server and newer-client/older-server impact. Keep
release version, protocol capability, server configuration, and viewer
permission decisions separate.

### Published-wire collision audit

Treat the exact currently published server and every client release line as
compatibility baselines, including development and nightly artifacts whose
software version did not change. For every public protobuf message that differs
across the base, upstream candidate, merge result, or a published artifact:

1. compare the base, upstream candidate, merge result, and published client and
   server descriptors by fully qualified message, field number, wire type, and
   semantic meaning;
2. preserve any field number already consumed by a published fork artifact;
3. cross-decode representative values in every applicable old/new producer and
   consumer direction, including requests, responses, and events;
4. fail the integration if either decoder populates a different known field,
   silently drops a required request, or corrupts unrelated state; and
5. when additive numbering cannot solve the collision, design and test an
   explicit protocol version or negotiated capability before merging.

Do not accept a claim that discovery or version gating makes a break safe
unless the gate exists in both producer and consumer code, distinguishes the
actual artifacts being rolled out, and has a mixed-version test.

### Retry and documentation audits

- Inspect every OCC/conflict retry loop in an affected operation. Authorization
  and every mutable projection, KV, or domain precondition must be evaluated
  inside each attempt after its boundary is refreshed. When such a precondition
  exists, add a test that forces one conflict and changes it before the retry.
- Search active maintenance, release, generated-output, and operator docs for
  removed commands, paths, generators, package names, architectures, and
  upstream-only claims. Validate each surviving instruction against the
  resolved fork tree; upstream documentation is not automatically correct for
  the fork.

## Compatibility forecast

Before the main PR can be ready:

1. derive the server version the candidate `main` image will advertise from
   the current build workflow and version configuration;
2. locate the prospective native client's minimum server version and required
   protocol capabilities in the merged tree;
3. prove the candidate server satisfies that native contract;
4. compare the candidate with current production discovery; and
5. review every persisted or migration change for downgrade safety.

Record rollback as:

- **safe:** the previous binary can read all durable writes the candidate may
  make;
- **conditionally safe:** recovery requires a documented maintenance or
  migration action; or
- **unsafe/unresolved:** deployment is blocked.

This classification must precede any promotion mechanism that can
automatically restore the previous binary. Do not plan to “roll back first and
inspect compatibility afterward.”

## Verification

Select checks from the resolved changed paths and their instructions. Start
with targeted tests, but do not stop below the layer where the integration can
fail. Common required layers include:

- generation and generated-diff checks;
- storage and public protobuf compatibility;
- affected shared-module and Authling tests;
- targeted and full Chatto backend tests;
- frontend catalog, Svelte, lint, type, unit, and build checks;
- realtime and browser E2E when behavior crosses those boundaries;
- native host, renderer, type, and packaging checks;
- REUSE/license validation; and
- `git diff --check`.

Source upstream CI is evidence for the upstream parent only. Local checks and
fork PR CI must validate the resolved merge result.

## Main pull request

Push the reviewed integration branch without force and create a
ready-for-review PR to `main`. Use a Markdown body file with:

- exact upstream range and fork baseline;
- upstream highlights;
- conflict and clean-merge audit decisions;
- retained fork functionality;
- product-boundary routing;
- API, persistence, migration, and rollback classifications;
- server/native version forecast;
- exact local verification; and
- remaining manual checks.

For visible UI changes, capture the rendered states required by
`chatto-pr-checklist` and require their uploaded GitHub attachments before
either integration PR is called ready. Refresh stored body claims after every
head change and terminal CI transition, read each body back, and recapture UI
evidence when a later commit changes the rendered state.

Use `gh` to read the stored body, base, head SHA, and issue-closing references
back after creation. Apply `chatto-pr-checklist`.

Require the complete PR CI for its exact head. Diagnose failures; do not rerun
until green without evidence of an infrastructure or known-flaky failure.
Immediately before merge:

1. refresh remote and PR state;
2. confirm base and head still match the reviewed SHAs;
3. confirm required checks are successful; and
4. present the PR number, exact head SHA, exact base SHA, and merge plan for
   explicit approval.

After approval, refresh the PR and remote once more immediately before
mutation. Any head, base, checks, or mergeability drift invalidates approval;
stop and re-review. When unchanged, use GitHub's merge-commit strategy. Verify
the stored merge commit, both parents, inclusion of the upstream candidate,
and the new `origin/main` head. Record them in the journal.
