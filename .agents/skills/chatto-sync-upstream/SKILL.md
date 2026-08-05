---
name: chatto-sync-upstream
description: Use when incorporating new chattocorp/chatto commits into the tha23rd/chatto fork, reconciling upstream/main with fork main or main-native, or coordinating the resulting production server and Windows nightly rollout.
---

# Sync Chatto Upstream

## Core invariant

One run owns this entire ordered delivery chain:

```text
chattocorp/main
  -> tha23rd/main
  -> production server
  -> tha23rd/main-native
  -> Windows nightly
```

Do not redefine “sync complete” as source integration alone. Production must
advertise a server compatible with the prospective native client before
merging that server into `main-native`.

`main-native` is a source and release branch. It is never a production
service, replica, or durable-state writer.

## Before any action

Read these files completely:

- [references/integration.md](references/integration.md)
- [references/delivery.md](references/delivery.md)
- [references/journal-template.md](references/journal-template.md)

Then:

1. Read the repository root and every affected path's `AGENTS.md`.
2. Create a turn plan containing all nine phases below.
3. Search for unfinished upstream-sync journals. Resume the exact matching run
   when that is the user's intent; otherwise create
   `.context/upstream-sync-<UTC-timestamp>-<run-id>.md` from the template.
4. On resume, reconcile every recorded SHA, PR, CI run, digest, production
   observation, and native publication object with current reality before any
   mutation. Drift invalidates affected approvals.
5. Record full SHAs, not moving branch names, at each phase boundary.

The journal is ignored operational state. Never put credentials, tokens, host
addresses, private configuration, PII, or raw production logs in it or normal
output.

## Approval gates

Pause for explicit approval immediately before:

1. merging the ready upstream-integration PR into `main`;
2. promoting the exact immutable server image to production;
3. merging the ready downstream PR into `main-native`; and
4. a manual rollback not already authorized for that exact reviewed failure
   condition.

Merge approval must identify the PR number plus exact head and base SHAs.
Production approval must identify the exact commit, image digest, and reviewed
recovery path. Revalidate these coordinates immediately before mutation; any
drift invalidates the approval. Broad instructions such as “finish,” “sync
everything,” “deploy latest,” or “do not stop” do not waive these gates.

## Progress checklist

Copy this checklist into the task plan and journal:

```text
- [ ] 1. Establish remotes, ancestry, exact baselines, and candidate SHA
- [ ] 2. Merge the exact upstream candidate on an integration branch
- [ ] 3. Route reviews, resolve conflicts, and prove compatibility
- [ ] 4. Validate, approve, and merge the ready main PR
- [ ] 5. Prove the exact selected main image and rollback safety
- [ ] 6. Approve, promote, and verify production
- [ ] 7. Merge the deployed main SHA on a main-native integration branch
- [ ] 8. Validate, approve, and merge the ready main-native PR
- [ ] 9. Prove native publication and final client/server compatibility
```

Do not advance a phase while its evidence or approval is missing. Update the
journal after every remote mutation, CI decision, approval, deployment action,
and verification result.

## Non-negotiable rules

- Use `gh` for every GitHub operation.
- Preserve real merge ancestry. Never squash, rebase, cherry-pick, or
  force-push as a shortcut around the two integration merges.
- Review the merge result, not just textual conflicts or upstream CI.
- Qualify the exact current head the user selects. Never silently substitute a
  newer or older SHA when a remote moves.
- Require the selected and qualified `main` SHA's own push CI and exact
  workflow-defined production image. A green source branch or PR run for
  another SHA is insufficient.
- Discover current repository workflow contracts. Do not invent signing,
  attestation, smoke-write, platform, or artifact requirements.
- Classify binary rollback safety before invoking a promotion mechanism that
  can automatically roll back. If persisted-write compatibility is unresolved,
  do not promote.
- If production fails, do not proceed to `main-native`.
- Do not count a native merge or publication that preceded the compatible
  production gate as completing this run. Later server repair does not make
  the required ordering retroactively true.
- A skipped required native publisher is not success.
- Full native provenance requires downloading the exact client-consumed
  Windows artifact and recording its cryptographic digest. If the bytes cannot
  be obtained and identified immutably, phase 9 is incomplete.
- Never claim completion without exact production and native artifact
  provenance plus a passing compatibility comparison.

## Required specialist routing

Invoke existing skills rather than duplicating their domain rules:

- **REQUIRED SUB-SKILL:** Use `chatto-api-compatibility` for affected
  Chatto-owned public APIs, discovery, auth, realtime, public behavior, or
  generated clients.
- **REQUIRED SUB-SKILL:** Use `chatto-event-sourcing` for affected
  Chatto-owned persisted events, projections, replay, OCC, read-your-writes, or
  live delivery.
- **REQUIRED SUB-SKILL:** Use `chatto-architecture-inventory` when Chatto
  runtime inventory changes.
- **REQUIRED SUB-SKILL:** Use `svelte-code-writer` and
  `svelte-core-bestpractices` for affected Svelte files.
- Route Authling-owned and shared-framework impacts only through their owning
  instructions and applicable Authling or global skills; do not substitute a
  Chatto workflow because its name sounds generic.
- Apply `chatto-pr-checklist` to both integration PRs.
- Use `superpowers:verification-before-completion` before any success claim.

## Red flags

Stop if reasoning includes any of these:

- “Production is a separate follow-up.”
- “The branch can keep serving while we roll back.”
- “Roll back first; check persisted compatibility afterward.”
- “The nightly already exists, so deploying its server later completes the
  ordered sync.”
- “The PR was green, so the image must be ready.”
- “Use whichever `main` is latest when the command runs.”
- “The publisher was skipped, but the build passed.”
- “The owner said finish, so another approval is unnecessary.”

Follow the stop, resume, and final-report rules in
[references/delivery.md](references/delivery.md).
