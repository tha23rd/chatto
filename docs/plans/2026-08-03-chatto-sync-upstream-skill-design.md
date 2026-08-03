# End-to-End Upstream Synchronization Skill Design

**Date:** 2026-08-03
**Status:** Approved
**Scope:** Repository-wide maintainer workflow

## Problem

This downstream distribution has three ordered delivery stages:

```text
chattocorp/main
      |
      v
tha23rd/main ----------> production server
      |
      v
tha23rd/main-native ---> Windows nightly
```

An upstream merge is not complete when the commits reach the fork's `main`.
The exact merged commit must pass fork CI, publish an immutable server image,
be promoted and verified in production, and only then flow into
`main-native`. Otherwise a newly published native client can require a newer
server protocol than production advertises.

The repository has no GitHub branch protections or rulesets for `main` or
`main-native`. The workflow therefore needs explicit maintainer-side gates for
reviewed ancestry, complete CI, artifact provenance, production approval, and
native publication.

Upstream integration also requires judgment. Upstream changes can conflict
with fork-owned functionality, public APIs, persisted event schemas, Authling,
shared framework modules, native host contracts, deployment behavior, and
release automation. A blind merge script cannot safely resolve those concerns.

## Decision

Add a repository-local `chatto-sync-upstream` skill under
`.agents/skills/chatto-sync-upstream/`. Use one end-to-end orchestration skill
instead of separate merge, deployment, and native-sync skills.

The skill owns the full sequence and treats these as explicit approval gates:

1. merging the upstream integration PR into fork `main`;
2. promoting the exact resulting server image to production;
3. merging the downstream synchronization PR into `main-native`; and
4. performing a rollback when rollback is not already an automatic,
   pre-reviewed part of the production promotion.

The skill may prepare branches, resolve conflicts, run tests, push reviewed
branches, create ready-for-review PRs, wait for CI, and gather read-only
production evidence as normal workflow steps. It must not infer approval for a
merge, deployment, or manual rollback.

## Alternatives

### Separate skills for each delivery stage

Separate upstream-merge, production-promotion, and native-sync skills would be
smaller. They would also make it easy to stop after one successful phase and
omit the next. That handoff risk is the failure this design is intended to
prevent.

### One deterministic synchronization script

A script could standardize Git and GitHub commands, but it could not safely
decide how to preserve fork behavior, classify API and persistence changes, or
determine rollback safety. Existing deterministic production scripts remain
authoritative for image promotion and rollback; the new skill provides the
judgment and orchestration around them.

## Run Journal

Create a unique ignored
`.context/upstream-sync-<UTC-timestamp>-<run-id>.md` journal for each new run.
On resume, select the unique matching unfinished journal and reconcile its
recorded objects with current reality before any mutation. Never overwrite or
co-mingle same-day runs. Record enough provenance to resume safely in a later
session:

- last integrated and candidate upstream SHAs;
- fork `main` and `main-native` baseline SHAs;
- integration and downstream branch names and PR numbers;
- upstream commit range and affected product boundaries;
- compatibility, migration, and rollback-safety conclusions;
- CI run URLs and their exact head SHAs;
- published image tag and resolved immutable digest;
- previous and promoted production commits, versions, and digests;
- production preflight and verification results;
- native merge SHA, CI run, and every workflow/update-channel publication
  object tied to that SHA; and
- canonical phase number and name, approval state, and unresolved blockers.

The journal is operational state, not product documentation, and must remain
untracked.

## Phase 1: Establish Provenance

1. Read repository and path-specific instructions before changing files.
2. Verify the configured remotes identify `chattocorp/chatto` as fetch-only
   `upstream` and `tha23rd/chatto` as `origin`.
3. Fetch both remotes and resolve `upstream/main`, `origin/main`, and
   `origin/main-native` to full SHAs.
4. Identify the upstream parent of the most recent completed upstream merge.
5. Stop on rewritten or ambiguous ancestry, unexpected remotes, dirty tracked
   changes, or a competing open upstream-sync PR.
6. Inventory commits and paths from the last integrated upstream parent
   through the candidate upstream SHA.

Never merge a moving symbolic ref after review. Record and merge the exact
candidate SHA.

## Phase 2: Integrate Upstream into Fork Main

Create a dedicated integration branch from the latest exact `origin/main`
commit. Merge the reviewed upstream SHA with normal merge ancestry. Do not
squash, rebase, flatten, or force-push upstream history.

Resolve conflicts by recovering the intent of both sides. Audit fork-owned
surfaces even when Git reports no textual conflict:

- server compatibility discovery and release-version gates;
- public ConnectRPC, protobuf, and realtime contracts;
- persisted core events and projection snapshots;
- native renderer and host contracts;
- voice, LiveKit, soundboard, custom emoji, role colours, and webhooks;
- complete translation catalogs;
- fork CI, GHCR, and native release publication;
- license boundaries and `NOTICE`; and
- private production configuration assumptions.

Re-run the affected-path inventory after conflict resolution.

## Phase 3: Route Reviews, Resolve Conflicts, and Prove Compatibility

Classify the resolved merge as Chatto, Authling, shared-framework, or
repository-wide work. Apply all relevant nested instructions.

Use existing repository skills rather than duplicating their guidance:

- `chatto-api-compatibility` for public protobufs, ConnectRPC, discovery,
  realtime, public auth/error/visibility behavior, and generated clients;
- `chatto-event-sourcing` for persisted events, projections, replay, OCC,
  read-your-writes, and live delivery;
- `chatto-architecture-inventory` when runtime topology changes;
- the applicable Authling workflows for Authling-owned changes; and
- every shared module's boundary and verification rules when its paths change.

Record compatibility in both directions: older client with newer server and
newer client with older server. Distinguish release-version gates, protocol
capabilities, server configuration, and viewer permissions.

Before either downstream artifact is considered ready:

1. derive the version the merged `main` image will advertise;
2. determine the minimum server version and capabilities required by the
   prospective `main-native` client;
3. prove the new server will satisfy that client;
4. compare both with current production discovery; and
5. identify persistence or migration changes that affect rollback.

If the prospective native client requires the candidate server, production
must successfully run that server before the native sync PR is merged.

Classify rollback as:

- **safe** — the previous binary can read every durable write the new binary
  may produce;
- **conditionally safe** — rollback requires a documented maintenance or
  migration action; or
- **unsafe/unresolved** — do not deploy until a recovery plan is approved.

## Phase 4: Validate, Approve, and Merge the Main PR

Run the lowest verification layer that can catch each affected risk, without
stopping below the layer where the merge could fail. Create a ready-for-review
PR whose body includes:

- exact upstream and fork ranges;
- upstream highlights;
- retained fork behavior and conflict decisions;
- product-boundary classification;
- public API and persistence compatibility;
- server/native version forecast;
- deployment and rollback assessment; and
- exact test evidence and remaining manual checks.

Wait for the complete PR CI matrix. Re-read the stored PR body and head SHA.
Pause for explicit merge approval. After approval, merge through GitHub and
verify the resulting merge commit, parents, and `origin/main` head.

## Phase 5: Prove the Server Artifact and Rollback Safety

Set the selected deployment SHA to the exact merge commit. If `origin/main`
advanced, stop and let the user retain that cutoff or select the newer full
SHA. A newer selection must receive its own complete delta review, specialist
routing, verification, compatibility forecast, persistence/rollback
classification, `main` push CI, and workflow-defined image. Thereafter every
artifact, approval, and promotion object uses that exact selected SHA.

Require all applicable checks and every workflow-defined production image
publisher to succeed. Discover current jobs, platforms, and artifacts rather
than inventing requirements. A green PR run or image for another SHA is not
evidence that the selected deployment artifact exists. Resolve its full-commit
GHCR tag to an immutable digest.

## Phase 6: Approve, Promote, and Verify Production

Locate the configured private production operator bundle through repository
instructions or private context documentation. Read its current runbooks and
entry points before acting; stop on no match or ambiguity. Do not copy host
addresses, credentials, provider details, or private configuration into the
public skill.

1. Inspect current production discovery and health.
2. Run the documented preflight and record the current image and rollback
   state.
3. Present the exact candidate SHA, digest, version, expected interruption,
   compatibility conclusion, and rollback plan.
4. Pause for explicit production approval.
5. Re-resolve the image and require the documented promotion entry point to
   accept the approved digest or fail closed if the commit tag no longer
   resolves to it.
6. Run the complete production verification script.
7. Run every service, endpoint, supporting-system, exposure, storage, restart,
   and redacted-log check defined by the current operator bundle.
8. Independently verify stable public readiness, discovery version and
   capabilities, plus the approved commit and digest.

Use the existing automatic health rollback only after the pre-deployment
compatibility review establishes that it is a valid recovery path. A manual
rollback requires explicit approval unless the user already authorized it for
this exact failure condition. If durable writes make binary rollback unsafe,
stop and follow the approved recovery plan.

Do not proceed to native synchronization until public discovery advertises a
version compatible with the prospective native client.

## Phase 7: Integrate the Deployed Main into Main-Native

Create a separate branch from the latest exact `origin/main-native` SHA and
merge the exact deployed `main` commit. Preserve the long-lived topology:
native-only work flows into `main-native`, while `main` remains the
web/server-focused downstream of upstream.

Review upstream desktop changes explicitly because upstream and the fork now
have independent desktop implementations and release paths. Verify native host
contracts, renderer integration, native-specific capabilities, and release
workflow ownership.

The server-before-native gate is chronological. The downstream merge that
satisfies this run must occur after production passes for the same deployed
`main` SHA; a later server repair does not retroactively qualify an earlier
native publication. Record the production-gate observation timestamp and
commit/digest, the downstream PR `mergedAt`, and the native release
`publishedAt`; require their identities and strict ordering to remain provable
on resume.

If that deployed SHA already entered `main-native` before the gate, do not
fabricate an empty merge or reuse the earlier publication. Use a reviewed,
workflow-supported post-gate source/release revision through a ready PR and
exact-head CI. Stop for a separate product/release decision when the repository
defines no such mechanism.

## Phase 8: Validate, Approve, and Merge the Main-Native PR

Create a ready-for-review PR containing the deployed server evidence, exact
merged SHA, native compatibility assessment, conflict decisions, and tests.
Wait for the full PR CI matrix and pause for explicit merge approval.

## Phase 9: Prove Native Publication

After the native PR merge:

1. verify the exact `main-native` merge SHA;
2. wait for its complete push CI;
3. inspect current workflow and update-channel code to discover every required
   verification, publication, and Windows release object;
4. require every applicable native test, build, and publisher job;
5. verify each discovered tag, release, installer, manifest, checksum,
   signature, or current equivalent is tied to that SHA;
6. prove the public update channel resolves to that exact release and artifact;
7. download the exact client-consumed Windows artifact and record a
   cryptographic digest of its bytes;
8. validate any additional workflow-published integrity data; and
9. compare the published client's minimum server version with current
   production discovery.

Report the run complete only when the production server and native release are
both tied to the recorded, reviewed SHAs and the compatibility comparison
passes.

## Stop Conditions

Stop and report the exact blocker when:

- a reviewed branch or remote head moves;
- ancestry or merge provenance is ambiguous;
- conflict resolutions are unexplained;
- required generated artifacts drift;
- API, persistence, migration, or rollback compatibility is unresolved;
- a required CI job fails or is skipped unexpectedly;
- the exact immutable image is unavailable;
- production preflight or verification fails;
- production discovery is incompatible with the prospective native client;
- the private operator bundle is unavailable; or
- a workflow-defined native publication or update-channel object cannot be
  tied to the exact merged SHA.

Do not reinterpret "finish," "sync everything," or similar persistence
language as authorization to bypass these gates.

## Skill Validation

Develop the skill with documentation TDD:

1. Run baseline agents without the skill against dry-run scenarios covering:
   - a large upstream merge with fork-specific conflicts;
   - a server/native version skew;
   - a `main` head race after image publication;
   - a production failure with uncertain rollback safety; and
   - a conflicting native merge followed by installer publication.
2. Record missing gates, unsafe assumptions, and premature completion claims.
3. Write the minimum skill and supporting references that correct those
   failures.
4. Run the same scenarios with the skill and verify exact-SHA provenance,
   review routing, approval pauses, server-before-native ordering, and safe
   refusal behavior.
5. Validate skill metadata and run repository license and formatting checks.

Validation scenarios must remain read-only and must not create PRs, merge
branches, publish artifacts, deploy production, or roll back production.

## Consequences

The end-to-end workflow takes longer than a mechanical merge and requires
several human approvals. In exchange, it makes delivery state explicit,
preserves fork intent across large upstream changes, keeps server and native
compatibility ordered, and provides enough provenance to recover or resume
without guessing.
