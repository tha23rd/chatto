# FDR-033: Soundboard

**Status:** Active
**Last reviewed:** 2026-07-19

## Overview

A soundboard lets members play short, server-curated audio clips into a room's
active voice call so that everyone connected to that call hears them, matching
Discord's soundboard. Administrators curate a server-wide catalog of named
sounds (each with an optional emoji icon and a default volume); any member
connected to a call can trigger a sound from a panel in the call UI. The
soundboard is a feature of voice calls (FDR-016): it exists only while a call is
running and only for the participants who have joined that call. It reuses the
custom-emoji model (FDR-030) for the catalog and the existing LiveKit publish
path for playback, so it adds no new media infrastructure.

## Behavior

- The sound catalog is server-wide and shared by every member. There are no
  per-user or per-room sound sets.
- Administrators upload sounds from a dedicated admin page (alongside custom
  emoji). Each sound has a name, an optional emoji icon, and a default volume.
- Uploaded audio is validated against file-size and format limits. A server
  accepts MP3, Ogg, WAV, and WebM clips up to 512 KB; the final clip must be at
  most 5 seconds. Size/format are enforced by the server; the 5-second limit is
  applied to the region the admin keeps, client-side, before upload. Clips within
  the limit are stored as-is and decoded by clients for playback.
- Before uploading, an admin can trim the clip on a waveform editor: two
  draggable handles set the kept start and end, and a preview button plays only
  the selected region. Trimming is optional for clips already within the limit —
  an untouched short clip uploads unchanged.
- A clip longer than 5 seconds is not rejected: it opens in the editor with a
  5-second window that the admin slides and adjusts to pick the part to keep, so
  a longer recording can be cut down to a usable sound rather than being turned
  away.
- A server has a fixed maximum of 48 custom sounds. There are no paid "boost"
  tiers; Chatto is self-hosted, so the cap is a plain ceiling.
- The soundboard surface only appears when LiveKit is configured and the viewer
  has joined the current room's active call, and only when the catalog is
  non-empty. With no call joined (or LiveKit unconfigured), there is no
  soundboard control or panel.
- A member opens the soundboard panel from the call UI, sees the catalog, and
  clicks a sound to play it. The clip is mixed into the call and every joined
  participant who is not deafened hears it; the triggering member hears it too.
- Members who can see that a call is active but have not joined it do not hear
  soundboard sounds, consistent with all other LiveKit-carried call media.
- Playing a sound is rate-limited per member (a minimum gap between triggers and
  a rolling per-window cap) to prevent audio spam. Throttled triggers are
  refused with brief feedback in the panel rather than queued.
- Deleting a sound removes it from the catalog and panel for everyone.
  Already-triggered playback is unaffected. Sounds are immutable once created;
  changing a sound means deleting it and uploading a new one.
- Playing or managing sounds does not post anything to the room timeline.

## Design Decisions

### 1. Playback is a client-published LiveKit audio track, never server-injected

**Decision:** When a member triggers a sound, their browser fetches the clip,
decodes it through the Web Audio API, and publishes it into the LiveKit room as
a short-lived, separately-named audio track (distinct from the microphone
track). Other joined clients receive it through the existing
`RoomEvent.TrackSubscribed` / `track.attach()` path (FDR-016 decision 4) and
hear it as ordinary call audio. The triggering client also plays the clip
locally, because LiveKit does not loop a participant's own published audio back
to them. The track is unpublished when the clip finishes.

**Why:** Call media is end-to-end encrypted with a per-call key that lives only
on joined clients (FDR-016 decision 10); Chatto's server never holds decryptable
media and cannot mix audio into the stream. Publishing from the triggering
client keeps the clip inside the same E2EE path as microphone audio, requires no
new server-side media plane, and reuses the attach/detach logic calls already
depend on. It is the audio analogue of how the frontend already manipulates
outbound tracks for noise suppression (FDR-031).

**Tradeoff:** Only participants who have joined the LiveKit call hear the sound;
roster-only observers do not, exactly like microphone audio. Playback fidelity
depends on the triggering client's uplink, and each concurrent sound is an extra
published track.

### 2. Soundboard is scoped to an active call, and plays leave no durable fact

**Decision:** The soundboard is only usable by a member who has joined the
current room's active call, and the trigger itself carries no durable fact — it
is ephemeral in-call action, fanned out purely by the LiveKit track in decision
1. No "sound played" event is written to EVT.

**Why:** A soundboard sound is meaningless outside a live call, so gating it on
call participation matches the product model that calls always happen inside a
room (FDR-016 decision 1). Individual plays are transient with no audit or replay
value, like mute and deafen (FDR-016 decision 11), so routing them through
durable events and realtime fan-out would add cost for state nobody needs to
persist.

**Tradeoff:** There is no server-side record of who played what, so a future
"soundboard usage log" or moderation audit would need a new, deliberate durable
fact. The per-member rate limit is therefore enforced client-side.

### 3. Server-scoped, event-sourced catalog, mirroring custom emoji

**Decision:** The sound catalog is durable, event-sourced server state. Create
and delete write events to a single server-scoped `soundboard` aggregate
(`SoundboardSoundCreatedEvent`, `SoundboardSoundDeletedEvent`) on
`evt.soundboard.server.*`, with current catalog state derived by an in-memory
`SoundboardProjection`.

**Why:** Like the custom-emoji catalog (FDR-030 decision 3), the sound catalog is
server-wide, low-cardinality, admin-edited, and shared by every member, so a
single server-scoped aggregate matches the data's ownership and keeps
create/delete ordering explicit and replayable (ADR-033, ADR-034), guarded by
per-filter optimistic concurrency. Per-aggregate migration (ADR-035) isolates
its evolution from other domains.

**Tradeoff:** A single aggregate serialises catalog writes, which is fine for an
admin-only, infrequently edited list. Sounds are immutable (create/delete only,
no update event) to keep the aggregate minimal; editing is a delete-and-recreate.

### 4. Reuse the server-asset pipeline for storage and serving

**Decision:** Validated sound clips are stored in the existing server-asset
object store (NATS ObjectStore or S3) under the public asset namespace and served
over HTTP at a dedicated `/assets/sound/` path, the same infrastructure that
backs avatars, server branding, link previews, and custom emoji. The projection
positively declares each live sound's asset public so the route fails closed once
a sound is deleted.

**Why:** Sound clips are small, public, server-scoped binaries with the same
lifecycle needs as other server assets, so reusing the pipeline avoids a parallel
storage/serving path (FDR-030 decision 4). Clients need the clip bytes to publish
them (decision 1), which a plain public HTTP asset URL provides.

**Tradeoff:** Sound clips are public once their URL is known, like other
server-scoped assets; they are not access-ticket gated the way room attachments
are.

### 5. Store clips as-is; validate rather than transcode

**Decision:** The server validates content type (MP3/Ogg/WAV/WebM) and size
(≤512 KB) and stores the uploaded bytes unchanged. Clip duration (≤5 s) is
measured client-side by decoding the file before upload. Playback relies on the
browser's Web Audio decoder, so no server-side transcoding is performed.

**Why:** Every target browser can decode these formats and the LiveKit publish
path is browser-side anyway (decision 1), so a server transcoder would add a
heavy dependency for no compatibility gain. Bounding length and size caps the
spam blast radius and keeps clips cheap to store and fetch.

**Tradeoff:** A malformed clip that passes the content-type check but fails to
decode surfaces only at play time on the client, rather than being rejected at
upload. Duration is enforced only client-side, so the server's durable guarantee
is size and format, not length.

### 6. Public read API, admin-gated write API

**Decision:** Listing the catalog is a public authenticated read
(`chatto.api.v1.SoundboardService.ListSounds`) available to any signed-in member
for the panel. Creating and deleting sounds live on a separate administrative
service (`chatto.admin.v1.AdminSoundboardService`) gated on `soundboard.manage`.

**Why:** Every member needs to read the catalog, but only administrators should
change it. Splitting a broad read service from an admin write service follows the
public API conventions in ADR-042 and ADR-044 and keeps the authorization
boundary obvious, exactly as custom emoji do (FDR-030 decision 5).

**Tradeoff:** Two services describe one resource, but each has a single clear
audience. Unlike Discord, non-admin members cannot add their own sounds in this
version (see open questions).

### 7. Only `soundboard.manage`; playing is gated on call membership

**Decision:** Curating the catalog is gated on a dedicated `soundboard.manage`
permission, which is also satisfied by the broad `server.manage` and is
auto-granted to the admin/owner default roles (FDR-030 decision 7). There is no
separate "use" permission: playing a sound is gated only on having joined the
room's active call, the same gate voice calling itself uses (FDR-016).

**Why:** A dedicated manage permission lets an operator delegate sound curation
without handing over the whole server-settings surface. A separate everyone-scope
"use" permission was deliberately not added: voice itself has no permission gate,
and introducing a new everyone-granted permission carries on-upgrade role-seeding
risk. The per-member rate limit (decision 2) covers the spam concern that a
"use" permission would otherwise address.

**Tradeoff:** Operators cannot yet disable the soundboard for a specific role
without removing voice access. A `soundboard.use` permission remains a clean
future addition (see open questions), mirroring FDR-016's own open question about
a `voice.join` permission.

### 8. Graceful degradation when LiveKit isn't configured

**Decision:** When LiveKit credentials are absent, the soundboard surface is
hidden entirely, matching how the rest of the voice UI degrades (FDR-016
decision 3). The admin management page is likewise gated behind the voice
feature being available.

**Why:** The soundboard is unusable without a working call, so a self-hoster who
has not configured LiveKit should not see dead affordances or manage a catalog
that can never play anything.

**Tradeoff:** An operator cannot pre-load sounds before turning voice on. This is
acceptable because sounds cannot be auditioned without a call anyway.

### 9. Trimming happens client-side; only a trimmed clip is re-encoded

**Decision:** The upload form decodes the selected clip with the Web Audio API,
renders its waveform, and lets the admin drag start/end handles to keep a
sub-region. A clip within the 5-second limit opens with the whole clip selected;
a longer clip opens with a 5-second window (the handles are constrained so the
kept region can never exceed the limit, letting the admin slide that window over
the recording). If the admin leaves a short clip's selection at the full clip,
the original bytes are uploaded untouched (decision 5). Otherwise the browser
slices the decoded samples to the selection, mixes them to mono, and re-encodes a
16-bit PCM WAV — one of the already-accepted formats — which is uploaded in place
of the original. No server-side audio editing or transcoding is added.

**Why:** The duration limit is a property of the *final* sound, not the source
file, so rejecting a long recording outright would be user-hostile when the tool
to fix it is right there. Trimming to a fixed-length window makes an over-length
clip usable and removing leading/trailing silence is the most common edit a
5-second cap demands; the clip is already decoded client-side, so the samples
needed to trim are in hand. Re-encoding only when the selection differs from a
short clip's full length avoids inflating an untouched small MP3 into a larger
WAV. Mono keeps a maximum-length trimmed clip comfortably under the 512 KB size
limit and matches how a soundboard clip is heard in a call.

**Tradeoff:** A trimmed clip is stored as uncompressed PCM WAV, larger per second
than the source codec (bounded by the length and size caps), and downmixed to
mono, so any stereo image in the original is lost. Trimming depends on the
browser successfully decoding the source; a clip that only fails to decode at
this stage cannot be trimmed and must be uploaded whole.

## Permissions

- `soundboard.manage` — upload and delete server soundboard sounds. Held by the
  owner and admin roles by default, and grantable on its own to a narrower
  "soundboard manager" role. `server.manage` holders retain access too, so
  existing server managers are unaffected. Reading the catalog requires only
  authentication; playing a sound requires having joined the room's voice call.

## Related

- **ADRs:** ADR-009 (webhook-driven voice call state), ADR-012 (two-tier
  real-time events), ADR-022 (NanoID with entity prefixes), ADR-033 (event-sourced
  state with projections), ADR-034 (single event stream), ADR-035 (per-aggregate
  migration), ADR-040 (permission-only RBAC with owner override), ADR-042
  (protobuf-first public API), ADR-044 (ConnectRPC service conventions)
- **FDRs:** FDR-001 (Roles & Permissions), FDR-008 (File Attachments & Video
  Processing), FDR-016 (Voice Calls), FDR-020 (Server Branding & Configuration),
  FDR-021 (Admin Dashboard & System Monitoring), FDR-030 (Custom Emoji), FDR-031
  (Microphone Noise Suppression)

## Open Questions

- **Member-contributed sounds.** Discord lets non-admins with a "Create
  Expressions" permission add their own sounds and manage only those. This version
  is admin-curated like custom emoji; a future version could add a member-scoped
  create/own-manage permission split.
- **A dedicated `soundboard.use` permission** would let operators disable the
  soundboard for a role without removing voice access (see decision 7).
- **Built-in default sounds.** Discord ships universal default sounds that do not
  consume server slots. Chatto bundles none today.
- **Persisted per-sound duration.** Duration is measured client-side and not
  persisted server-side, so `duration_ms` is currently unset; a future version
  could probe and store it at upload.
- **Entrance sounds and external/cross-server sounds** (Discord Nitro features)
  are out of scope; Chatto has no premium tiering and no cross-server sound
  sharing model.
