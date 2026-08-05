# FDR-031: Client–Server Compatibility Discovery

**Status:** Experimental
**Last reviewed:** 2026-08-03

## Overview

The multi-server client compares each registered Chatto server's software
version with the releases that introduced the features it uses, shows the
server's current version, and warns when the client and server cannot provide
the expected experience. This gives people useful upgrade guidance while
Chatto's pre-1.0 API remains experimental.

## Behavior

- A registered server's context menu shows the software version reported by
  that server's latest discovery response.
- A warning marker appears when the server predates the oldest version
  supported by the current client. The 0.5 client classifies pre-0.5 servers as
  unsupported because they do not provide the required server-projection
  stream.
- Servers with non-standard or unparseable versions remain explicitly unknown.
- An unreachable server remains registered and is reported as unreachable
  rather than being assigned a healthy or compatible state.
- Third-party clients own and test their own minimum supported server release.
- The `chatto.realtime.v1` protobuf namespace implements only behavioural
  protocol version 2 in 0.5. Servers reject version 0, version 1, and unknown
  handshakes.
- This distribution additionally advertises `ServerCompatibility` capability
  keys for protocol features no upstream release carries, which release-version
  comparison alone cannot express. `chatto.role-colors.v1` advertises additive
  role-colour mutations and the derived public user colour field. Newer clients
  omit colour controls and mutations when it is absent; older clients ignore
  the additive fields.
- A server that sends no `ServerCompatibility` — including every upstream
  build — is read as declaring no capabilities, so capability-gated UI stays
  off instead of failing at write time.

## Design Decisions

### 1. The bundled client records minimum server versions per feature

**Decision:** Features that vary across releases use one internal table mapping
the feature to the first server version that supports it.
**Why:** The 0.5 release is a clean compatibility baseline, and exposing
implementation-level protocol flags would turn internal rollout details into a
public contract. An explicit table keeps version knowledge in one place.
**Tradeoff:** Forks and builds with non-standard version strings cannot declare
support independently; the client treats them conservatively as unknown or
unsupported for gated features.

### 2. The client owns compatibility policy

**Decision:** Unauthenticated discovery reports the server software version.
Each client owns its minimum supported server release and compares that policy
with the discovered version before connecting.
**Why:** Future clients know which older server contracts they still implement;
the server cannot predict the requirements of clients that do not exist yet.
This also avoids turning client release policy into public server metadata.
**Tradeoff:** A client update must keep its minimum-version table accurate and
cannot rely on a server to reject it on the client's behalf.

### 3. Registration data does not cache compatibility conclusions

**Decision:** The client keeps version and compatibility results in live
per-server state and refreshes them from discovery instead of persisting them
with the registered server and its credentials.
**Why:** Persisted compatibility information would become stale across server
and client upgrades. The registry should retain connection identity, while the
server state owns current discovery facts.
**Tradeoff:** Compatibility is unknown until discovery completes after the
client starts.

### 4. Pre-1.0 compatibility remains advisory

**Decision:** Compatibility discovery informs feature gating and warnings but
does not turn the experimental `v1` packages into a stability guarantee.
**Why:** Chatto still needs room to reshape its public API in response to early
feedback. ADR-045 requires intentional review and migration guidance for
breaks without prematurely freezing the API.
**Tradeoff:** Integrators must still pin server versions and read release notes.

### 5. `ServerCompatibility` is numbered outside upstream's tag space

**Decision:** `GetServerResponse.compatibility` uses field 1000, and
`ServerCompatibility.minimum_web_client_version` is removed with its tag and
name reserved.
**Why:** Upstream vacated field 3 without reserving it, so a future upstream
field would land on the tag this distribution still populates — a wire
collision surfacing in a file that conflicts on most upstream merges. The
removed minimum-version field was never populated or read, and ADR-045 records
that the server reports its software version rather than declaring client
requirements.
**Tradeoff:** A client generated from an older schema reads no capabilities
from a current server and falls back to version gating. Every such server
predates the 0.5 baseline and is already reported unsupported, so no gated
feature changes state. Moving the message into `compatibility.proto` also moves
its generated TypeScript export to `discovery/v1/compatibility_pb`, which is
wire-safe but a compile break for third-party TypeScript consumers. Generated
Go is unaffected, since both files share one package.

## Related

- **ADRs:** ADR-025 (multi-instance client architecture), ADR-042 (protobuf-first public API), ADR-045 (public API stability tiers), ADR-051 (server-scoped resumable client projection), ADR-063 (Deno Desktop and CEF packaging)
- **FDRs:** FDR-023 (Authentication & Sessions), FDR-027 (PWA & Service Worker), FDR-034 (Chatto Desktop)
