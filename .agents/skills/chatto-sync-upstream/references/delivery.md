# Server and Native Delivery

## Contents

- Prove the server artifact
- Production approval and promotion
- Production verification and recovery
- Server-before-native gate
- Synchronize main into main-native
- Prove native publication
- Stop, resume, and report

## Prove the server artifact

Set the **selected deployment SHA** initially to the exact recorded `main`
merge commit. Refresh `origin/main` before artifact qualification. If it
advanced, stop and present:

- the recorded merge commit;
- the new head;
- their delta; and
- the choice between retaining the recorded cutoff or selecting and
  requalifying the newer head.

If the user selects the newer head, review its complete delta, rerun every
affected specialist review and verification layer, recompute its advertised
version and native compatibility, and reclassify persistence, migration, and
rollback safety. Record that full SHA as the new selected deployment SHA.
Never silently call an older artifact “latest” or treat an unreviewed newer
head as selected.

A green integration PR does not publish the production image. Find the `main`
push CI run whose `headSha` is the exact selected deployment SHA.

1. Inspect the current workflow to determine which jobs are required for a
   `main` push and which conditional skips are expected.
2. Require the full applicable run to complete successfully.
3. Require every workflow-defined production image publisher to succeed.
4. Verify the full-commit GHCR tag identifies the exact selected deployment
   SHA.
5. Resolve that tag to an immutable digest and record both.
6. Confirm the image version metadata matches the compatibility forecast.

Do not infer signatures, attestations, platforms, smoke writes, or assets that
the current workflow does not promise.

Refresh `origin/main` again before deployment. Any new movement repeats the
same stop and explicit selection process. Every artifact, compatibility,
rollback, approval, and promotion field below refers to the final exact
selected deployment SHA.

## Production approval and promotion

Locate the configured private production operator bundle through repository
instructions or private `.context` documentation. Read its README, current
image-promotion runbook, preflight, promotion, rollback, and verification
entry points completely. The bundle must explicitly identify itself as
authoritative for this Chatto production environment. Stop on no match or
multiple plausible matches; do not guess. Those private files are authoritative
for host access and commands. Do not copy their secrets, addresses,
credentials, provider-specific details, or private configuration into tracked
skill files, the run journal, or normal output.

If the operator bundle or required access is unavailable, stop at the
production gate and report exactly what the operator must provide.

Before asking for approval:

1. inspect current public health and discovery;
2. run the documented operator preflight;
3. record current commit, version, immutable digest, deployment state, and
   recovery target;
4. confirm the candidate tag and digest;
5. revalidate every prerequisite and environment check defined by the current
   operator bundle;
6. confirm the candidate's rollback classification is safe for the promotion
   entry point's automatic failure behavior; and
7. confirm the promotion entry point can bind the production mutation to the
   approved digest before changing deployment state; and
8. state the expected service interruption.

If rollback is conditional or unsafe, do not invoke a promotion mechanism that
can automatically restore the old binary. Obtain an approved forward-recovery
or maintenance plan first.

The full-commit registry tag is still a mutable pointer. The promotion entry
point must either accept the approved digest directly or resolve the tag and
fail closed when it differs from that digest before changing production. If
the current runbook cannot enforce that binding, stop and improve the runbook
through a separate reviewed change. Do not compensate with an unreviewed
manual production edit.

Ask for explicit approval naming:

- exact selected deployment SHA;
- candidate immutable digest and advertised version;
- current production digest and version;
- compatibility and migration conclusion;
- automatic and manual recovery behavior; and
- expected interruption.

After approval, invoke only the documented promotion entry point with the
exact approved commit and digest. Immediately before mutation, re-resolve the
tag and recheck the digest and preflight state. Any drift invalidates approval.
Do not bypass the documented entry point with improvised production mutations.

## Production verification and recovery

Run every check defined by the authoritative production verification entry
point. Derive service, supporting-system, endpoint, listener, exposure,
storage, restart, and operational-log checks from the current operator bundle
rather than freezing that private topology in this public skill.

Then independently verify the stable cross-environment invariants:

- public readiness and HTTPS behavior required by discovery;
- discovery's advertised version and protocol capabilities;
- the running commit and immutable digest match the approved artifact; and
- failures and recent fatal indicators are reviewed through the bundle's
  redacted procedure without printing PII or raw sensitive logs.

Compare public discovery with the forecast; a deployment reporting generic
health while advertising an unexpected version is a failed promotion.

If promotion or verification fails:

1. stop the downstream/native phase;
2. determine whether the promotion entry point already performed the exact
   pre-reviewed automatic recovery;
3. verify the resulting public and on-host state;
4. do not initiate a manual rollback unless that exact action/failure was
   authorized and remains persistence-safe; and
5. if persisted-write compatibility is unresolved, escalate to the approved
   recovery plan rather than guessing.

Record the actual recovery outcome. Do not describe `main-native` as a service
to quarantine or stop.

## Server-before-native gate

Before creating or merging the downstream PR, query production discovery
freshly and prove:

- its advertised server version satisfies the prospective native minimum;
- required protocol capabilities are present;
- the deployed commit and digest match the reviewed server artifact; and
- public readiness remains healthy.

Record the UTC observation time, selected deployment SHA, immutable digest,
advertised version, required capabilities, and evidence source as the
production compatibility-gate event.

If any comparison fails, the production phase is incomplete. Do not merge
`main` into `main-native` and do not publish a native client that depends on
the candidate server.

This is a chronological gate, not only an eventual-state comparison. The
downstream merge and publication that satisfy this run must occur after this
gate passes for the same deployed `main` SHA. An existing native artifact
published while production was still incompatible can guide incident recovery,
but a later server promotion does not retroactively make that artifact complete
the ordered run. Perform a new downstream integration and publication after
production passes.

## Synchronize main into main-native

Resolve the current `origin/main-native` to a full SHA and record it. Create a
separate branch from that exact baseline and merge the exact **deployed**
`main` SHA with a normal merge commit. Do not silently substitute a later
`main`.

If the deployed `main` SHA is already an ancestor of the baseline because it
entered `main-native` before the production gate passed, do not fabricate an
empty merge, rewrite ancestry, or reuse the pre-gate publication. Stop and
identify the repository's reviewed, workflow-supported mechanism for creating
a genuine post-gate source/release revision. That mechanism must go through a
ready PR, exact-head CI, the downstream merge approval gate, and a new native
publication. If no such mechanism exists, report the run blocked and request a
separate product/release decision.

Preserve native-only ancestry and functionality. Review conflicts and adjacent
clean merges in:

- native host and renderer contracts;
- generated clients and protocol/version gates;
- platform permissions and lifecycle behavior;
- installer/version/channel metadata; and
- CI/release ownership.

When upstream supplies another desktop implementation, treat it and the fork's
native release line as independent until a reviewed product decision says
otherwise.

Run the affected native, frontend, compatibility, and repository checks. Push
without force and create a ready PR to `main-native`. Its body must include:

- pre-merge `main-native` SHA;
- exact deployed `main` SHA;
- production version/digest/discovery evidence;
- conflict and ownership decisions;
- prospective native compatibility;
- exact tests; and
- expected publication contract from the current workflow.

Read the stored PR back with `gh`, apply `chatto-pr-checklist`, and require its
exact-head CI. Immediately before merge, recheck both branch heads, checks,
and production discovery. Present the PR number, exact head and base SHAs, and
merge plan for explicit approval. After approval, repeat those checks
immediately before mutation; any drift invalidates approval. When unchanged,
use a merge commit and verify both parents and the new `origin/main-native`
head. Record GitHub's downstream PR `mergedAt` timestamp alongside that merge
SHA.

## Prove native publication

Find the `main-native` push CI run whose `headSha` is the exact downstream
merge commit.

1. Inspect current workflow conditions to identify every required native
   verification and publication job.
2. Require every workflow-defined native test and build job, including the
   Windows executable build required by this release line.
3. Require the native publisher to run successfully; a skipped required
   publisher is a blocker.
4. Derive every publication object from current workflows and native
   update-channel code: immutable and rolling tags, releases, manifests,
   metadata, signatures, installer assets, checksums, or their current
   equivalents. Do not require an object the repository does not publish.
5. Use `gh` to prove the tag targets the exact merge SHA.
6. Prove each discovered publication object is present and bound through the
   chain to the exact source SHA and release.
7. Prove the public client-consumed update channel resolves to that exact
   source-bound release and artifact rather than an older or unrelated one.
8. Download that exact client-consumed Windows artifact, compute a
   cryptographic digest from its bytes, and record the algorithm and value.
   If the artifact cannot be downloaded or tied to the resolved update
   channel, phase 9 is incomplete.
9. Additionally validate workflow-published checksums or signatures when the
   current contract provides them.
10. Query production discovery again and compare its version/capabilities
    with the published client's requirements.

Record the authoritative workflow completion and release publication
timestamps. Prove and journal this ordering for the same selected deployment
SHA and native release:

```text
production compatibility gate passed
  < downstream PR mergedAt
  < native release publishedAt
```

If any timestamp, identity binding, or ordering cannot be proved, phases 7–9
remain incomplete. Mark every pre-gate native artifact permanently ineligible
as completion evidence for this run.

Do not invent a signature, notarization, platform, or smoke-test requirement
that the repository does not currently promise. Report useful manual client
testing as outstanding unless it was actually performed.

## Stop, resume, and report

Stop on:

- unexpected remotes or ambiguous ancestry;
- a competing integration PR;
- moving reviewed heads;
- unexplained conflict resolutions;
- generated drift;
- unresolved API, persistence, migration, or rollback compatibility;
- failed or unexpectedly skipped required CI;
- missing workflow-defined server image or native publication object;
- production preflight or verification failure;
- incompatible production discovery; or
- missing operator access.

On cancellation or interruption, update the journal with the last completed
phase, exact current state, approvals already granted, blocker, and next safe
read-only action. Do not undo merged history, deployments, releases, or user
work unless explicitly authorized.

At the start of a possible resume:

1. list unfinished upstream-sync journals and identify the one whose recorded
   candidate, branches, and PRs match the user's requested run;
2. stop on no unique match rather than combining runs;
3. load its schema, phase checklist, approval ledger, and last safe action;
4. refresh and compare every recorded remote SHA, PR head/base and state, CI
   run, image tag/digest, production commit/version/digest/discovery result,
   and native release/update-channel object;
5. record all drift and invalidate any approval whose exact object or reviewed
   recovery conditions changed; and
6. reconstruct the production-gate observation, downstream PR `mergedAt`, and
   native workflow/release publication timestamps and verify their identities
   and strict chronological ordering; and
7. resume only from the first incomplete phase whose prerequisites still hold.

Current compatible state cannot replace historical ordering evidence. If the
recorded production gate cannot be proved to precede both the downstream merge
and native publication for the same selected deployment SHA, phases 7–9 are
incomplete on resume.

For a genuinely new run, create a unique journal. Never overwrite or co-mingle
an interrupted run merely because both runs occur on the same date.

Final reporting must distinguish complete and partial phases. A full success
claim requires:

- upstream candidate and both merge SHAs;
- both PR links and CI runs;
- production version and immutable digest;
- production verification evidence;
- the complete workflow-discovered native publication and update-channel
  provenance; and
- the computed cryptographic digest of the exact client-consumed Windows
  artifact; and
- the final production-versus-native compatibility result.

If any item is missing, report the completed phases and blocker; do not call
the end-to-end sync complete.
