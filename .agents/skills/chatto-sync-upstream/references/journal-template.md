# Upstream Synchronization Journal Template

Create `.context/upstream-sync-<UTC-timestamp>-<run-id>.md` from this structure
for a new run. The file must remain ignored. On resume, load the unique
matching unfinished journal and reconcile its recorded state instead of
creating or overwriting a file.

Do not record credentials, tokens, host addresses, private configuration, PII,
raw production logs, or full query strings. Use commit SHAs, immutable digests,
public URLs, CI/PR identifiers, timestamps, pass/fail results, and concise
redacted observations.

```markdown
# Chatto Upstream Synchronization — <YYYY-MM-DD>

## Status

- Journal schema: `chatto-sync-upstream/v1`
- Run ID: <unique non-secret identifier>
- Created: <UTC timestamp>
- Overall: planning | integrating-main | awaiting-main-approval |
  awaiting-main-ci | awaiting-production-approval | verifying-production |
  integrating-native | awaiting-native-approval | awaiting-native-ci |
  complete | blocked
- Current phase: <number — stable phase name>
- Last updated: <UTC timestamp>
- Blocker: <none or concise blocker>
- Next safe read-only action: <action>

## Phase checklist

- [ ] 1. Establish remotes, ancestry, exact baselines, and candidate SHA
- [ ] 2. Merge the exact upstream candidate on an integration branch
- [ ] 3. Route reviews, resolve conflicts, and prove compatibility
- [ ] 4. Validate, approve, and merge the ready main PR
- [ ] 5. Prove the exact selected main image and rollback safety
- [ ] 6. Approve, promote, and verify production
- [ ] 7. Merge the deployed main SHA on a main-native integration branch
- [ ] 8. Validate, approve, and merge the ready main-native PR
- [ ] 9. Prove native publication and final client/server compatibility

## Approval ledger

| Gate | Exact object | Requested | Approved | Approval-message reference |
|---|---|---:|---:|---|
| Merge main PR | PR <number>, head <full SHA>, base <full SHA> | | | |
| Promote production | approval object below | | | |
| Manual rollback | failure <description>, target <digest> | | | |
| Merge main-native PR | PR <number>, head <full SHA>, base <full SHA> | | | |

### Production approval object

- Candidate: commit <full SHA>, digest <sha256>, version <version>
- Current production: digest <sha256>, version <version>
- Compatibility and migration conclusion: <summary>
- Persistence/rollback classification: safe | conditionally safe |
  unsafe/unresolved
- Reviewed recovery plan: <reference>
- Automatic/manual recovery behavior: <summary>
- Expected interruption: <duration/impact>
- Approval: <UTC timestamp and message reference>

## Baselines and candidate

- Upstream remote URL: <public URL>
- Origin remote URL: <public URL>
- Last integrated upstream parent: <full SHA>
- Candidate upstream/main: <full SHA>
- Origin/main before merge: <full SHA>
- Origin/main-native before downstream merge: <full SHA>
- Production before: commit <full SHA>, version <version>, digest <sha256>
- Native release before: commit <full SHA>, tag <tag>
- Competing sync PRs: <none or links>

## Change and review classification

- Upstream range: <old>..<candidate>
- Commit count: <count>
- Affected boundaries: Chatto | Authling | shared framework | repository
- Specialist skills used: <names>
- Conflict decisions: <summary or references>
- Clean-merge fork surfaces audited: <summary>
- Generated output: <status>
- Documentation impact: <status>

## Compatibility and recovery

- Public API classification: <none/additive/behavioral/deprecated/breaking>
- Older client / newer server: <impact>
- Newer client / older server: <impact>
- Candidate advertised server version: <version and evidence>
- Prospective native minimum: <version and evidence>
- Required capabilities: <keys and evidence>
- Persistence/migration impact: <summary>
- Binary rollback: safe | conditionally safe | unsafe/unresolved
- Recovery plan: <summary/reference>

## Main integration

- Branch: <name>
- Merge commit before PR: <full SHA and parents>
- Local verification: <commands and results>
- PR: <number/url>
- Stored PR head/base: <full SHAs>
- PR CI: <run URL, conclusion>
- Approved merge: <message reference>
- Origin/main after merge: <full SHA and parents>

## Server artifact

- Selected deployment SHA: <full SHA and selection/requalification evidence>
- Main push CI: <run URL, full head SHA, conclusion>
- Required jobs: <results>
- Commit image tag: <tag>
- Approved immutable digest: <sha256>
- Pre-mutation digest binding: <pass/fail and evidence>
- Image version: <version>
- Main-head race check: <checked timestamp and result>

## Production

- Preflight: <timestamp and result>
- Promotion approval: <message reference>
- Promotion result: <result>
- Production after: commit <full SHA>, version <version>, digest <sha256>
- Runbook-defined service and supporting-system checks: <results>
- Runbook-defined endpoint/readiness checks: <results>
- Discovery version/capabilities and runbook-required fields: <result>
- Runbook-defined exposure/storage/runtime checks: <results>
- Redacted failure/fatal review: <result>
- Recovery action: <none/automatic/manual/forward recovery plus evidence>

## Native integration

- Production compatibility-gate event: <UTC observation time, selected
  deployment full SHA, immutable digest, version, capabilities, evidence>
- Branch: <name>
- Main-native baseline: <full SHA>
- Selected deployment SHA merged: <full SHA>
- Merge commit before PR: <full SHA and parents>
- Conflict/desktop ownership decisions: <summary>
- Local verification: <commands and results>
- PR: <number/url>
- Stored PR head/base: <full SHAs>
- PR CI: <run URL, conclusion>
- Approved merge: <message reference>
- Origin/main-native after merge: <full SHA and parents>
- Downstream PR mergedAt: <authoritative UTC timestamp>

## Native publication

- Main-native push CI: <run URL, full head SHA, conclusion>
- Native workflow completedAt: <authoritative UTC timestamp>
- Required native jobs: <results>
- Publisher: <result>
- Discovered publication objects: <workflow/update-channel evidence>
- Release identifier and tag target: <release/run ID, tag, full SHA,
  mutability>
- Native release publishedAt: <authoritative UTC timestamp>
- Rolling/public update channel: <object, resolved release and artifact>
- Manifests/metadata/signatures: <objects/results or not published>
- Installer asset: <name and release identifier>
- Installer cryptographic digest: <algorithm/value; required for completion>
- Checksum/signature asset: <name/value/result or not published>
- Client-consumed artifact download and digest: <pass/fail>
- Published integrity verification: <pass/not published/not run with reason>
- Chronology proof: <production gate time> < <downstream mergedAt> <
  <native publishedAt>, bound to <selected deployment SHA/native release>
- Pre-gate native artifacts: <identifiers marked ineligible or none>
- Final production compatibility: <version/capability comparison>
- Manual client verification: <result or outstanding>

## Final evidence or blocker

- Completed phases: <list>
- Incomplete phases: <list>
- Exact blocker: <none or blocker>
- Next safe action: <none or action>
```
