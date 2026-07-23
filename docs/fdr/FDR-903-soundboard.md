# FDR-903: Soundboard

**Status:** Active
**Last reviewed:** 2026-07-21

## Overview

A soundboard lets members play short, server-curated audio clips into a room's
active voice call so that everyone connected to that call hears them, matching
Discord's soundboard. Administrators curate a server-wide catalog of named
sounds (each with an optional emoji icon and a default volume); any member
connected to a call can trigger a sound from a panel in the call UI. The
soundboard is a feature of voice calls (FDR-016): it exists only while a call is
running and only for the participants who have joined that call. It reuses the
custom-emoji model (FDR-900) for the catalog and the existing LiveKit publish
path for playback, so it adds no new media infrastructure.

## Behavior

- The sound catalog is server-wide and shared by every member. There are no
  per-user or per-room sound sets.
- Administrators upload sounds from a dedicated admin page (alongside custom
  emoji). Each sound has a name, an optional emoji icon, and a default volume.
  The icon is chosen from the shared emoji picker rather than typed, and the
  picker is restricted to unicode glyphs because a sound's icon is rendered as
  text everywhere it appears.
- Uploaded audio is validated against file-size and format limits. A server
  accepts MP3, Ogg, WAV, and WebM clips up to 20 MB; the final clip must be at
  most 10 seconds. The byte cap is deliberately much larger than a 10-second clip
  needs so an admin can drop in a full-quality source file and trim the seconds
  they want in the browser. Size/format are enforced by the server; the 10-second limit is
  applied to the region the admin keeps, client-side, before upload. Clips within
  the limit are stored as-is and decoded by clients for playback.
- Before uploading, an admin can trim the clip on a waveform editor: two
  draggable handles set the kept start and end, the band between them is
  draggable so an established window slides over the clip as a unit, and a
  preview button plays only the selected region at the pending default volume so
  the level can be judged before saving. Trimming is optional for clips already
  within the limit — an untouched short clip uploads unchanged.
- A clip longer than 10 seconds is not rejected: it opens in the editor with a
  10-second window that the admin slides and adjusts to pick the part to keep, so
  a longer recording can be cut down to a usable sound rather than being turned
  away. Sliding the window past either end of the clip parks it flush against
  that edge rather than shrinking it.
- A server has a fixed maximum of 48 custom sounds. There are no paid "boost"
  tiers; Chatto is self-hosted, so the cap is a plain ceiling.
- The soundboard surface only appears when LiveKit is configured and the viewer
  has joined the current room's active call, and only when the catalog is
  non-empty. With no call joined (or LiveKit unconfigured), there is no
  soundboard control or panel.
- A member opens the soundboard panel from the call UI, sees the catalog, and
  clicks a sound to play it. The clip is mixed into the call and every joined
  participant who is not deafened hears it; the triggering member hears it too.
- While a member is playing a clip, their call tile lights up with the same ring
  used for speaking, so everyone can see who triggered a sound even if that
  member is not otherwise talking (or has their microphone muted).
- Each listener has a personal soundboard playback control in preferences: a
  volume level and a full mute for other members' soundboard sounds. It is a
  per-device preference, independent of the sound's own configured volume and of
  who is playing, and takes effect immediately. Locally muting or deafening a
  participant also silences that participant's soundboard sounds.
- Members who can see that a call is active but have not joined it do not hear
  soundboard sounds, consistent with all other LiveKit-carried call media.
- Playing a sound is rate-limited per member (a minimum gap between triggers and
  a rolling per-window cap) to prevent audio spam. Throttled triggers are
  refused with brief feedback in the panel rather than queued.
- Triggering a sound replaces that member's own currently-playing sound instead
  of layering the two: their previous clip stops for them and for every
  listener. Triggering the same sound again restarts it. One member can never
  cut off another member's sound, and a trigger refused by the rate limiter
  leaves the previous sound playing.
- Deleting a sound removes it from the catalog and panel for everyone.
  Already-triggered playback is unaffected. Sounds are immutable once created;
  changing a sound means deleting it and uploading a new one.
- Adding or deleting a sound reaches connected members immediately, including
  members who are already in a voice call; no rejoin or reload is needed.
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
outbound tracks for noise suppression (FDR-901).

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

**Why:** Like the custom-emoji catalog (FDR-900 decision 3), the sound catalog is
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
storage/serving path (FDR-900 decision 4). Clients need the clip bytes to publish
them (decision 1), which a plain public HTTP asset URL provides.

**Tradeoff:** Sound clips are public once their URL is known, like other
server-scoped assets; they are not access-ticket gated the way room attachments
are.

### 5. Store clips as-is; validate rather than transcode

**Decision:** The server validates content type (MP3/Ogg/WAV/WebM) and size
(≤20 MB, and never above the assets max upload size that bounds the Connect
request carrying the audio) and stores the uploaded bytes unchanged. Clip duration (≤5 s) is
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
boundary obvious, exactly as custom emoji do (FDR-900 decision 5).

**Tradeoff:** Two services describe one resource, but each has a single clear
audience. Unlike Discord, non-admin members cannot add their own sounds in this
version (see open questions).

### 7. Only `soundboard.manage`; playing is gated on call membership

**Decision:** Curating the catalog is gated on a dedicated `soundboard.manage`
permission, which is also satisfied by the broad `server.manage` and is
auto-granted to the admin/owner default roles (FDR-900 decision 7). There is no
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
renders its waveform, and lets the admin drag start/end handles — or the whole
selection band — to keep a sub-region. A clip within the 10-second limit opens
with the whole clip selected; a longer clip opens with a 10-second window (the
handles are constrained so the kept region can never exceed the limit, and
dragging the band slides that window over the recording without resizing it). If
the admin leaves a short clip's selection at the full clip,
the original bytes are uploaded untouched (decision 5). Otherwise the browser
slices the decoded samples to the selection, mixes them to mono, and re-encodes a
16-bit PCM WAV — one of the already-accepted formats — which is uploaded in place
of the original. No server-side audio editing or transcoding is added.

**Why:** The duration limit is a property of the *final* sound, not the source
file, so rejecting a long recording outright would be user-hostile when the tool
to fix it is right there. Trimming to a fixed-length window makes an over-length
clip usable and removing leading/trailing silence is the most common edit a
10-second cap demands; the clip is already decoded client-side, so the samples
needed to trim are in hand. Re-encoding only when the selection differs from a
short clip's full length avoids inflating an untouched small MP3 into a larger
WAV. Mono keeps a maximum-length trimmed clip small — far under the size limit —
and matches how a soundboard clip is heard in a call.

**Tradeoff:** A trimmed clip is stored as uncompressed PCM WAV, larger per second
than the source codec (bounded by the length and size caps), and downmixed to
mono, so any stereo image in the original is lost. Trimming depends on the
browser successfully decoding the source; a clip that only fails to decode at
this stage cannot be trimmed and must be uploaded whole.

### 10. Listener-side volume/mute is a per-device preference applied per track

**Decision:** Each listener has their own soundboard playback volume and a full
mute, stored as a local (per-device) preference alongside theme and notification
settings. It is applied on the receiving side to the incoming soundboard audio
track specifically — soundboard clips are published under a distinct track name,
so a receiver can tell them apart from the microphone and scale only them. Deafen
and a per-participant local mute still silence a participant's soundboard too.

**Why:** Playback loudness is a personal, device-specific concern (headphones vs
speakers), so it belongs with the other local preferences, not synced server
state. Targeting the soundboard track directly means the control is global across
all players and never fights the per-participant voice volume, which LiveKit
scopes to the microphone source. Applying it as a listener-side gain needs no new
API and no change to how a sound is published.

**Tradeoff:** Because it is per-device, the setting does not follow a user to
another browser. A mid-clip change only fully applies to sounds that start after
it, though the ≤5 s clip length makes that imperceptible.

### 11. The "who's playing" highlight rides an ephemeral data signal, not audio detection

**Decision:** When a member plays a clip, their tile lights up with the speaking
ring on every client. This is driven by an ephemeral LiveKit data-channel message
("started"/"stopped") the player broadcasts, plus a direct local highlight for
the player's own tile — not by audio-level/active-speaker detection. The highlight
auto-expires if a stop signal is lost, and carries no durable state.

**Why:** Reusing speaking-indicator audio detection would be unreliable: it would
miss a player whose microphone is muted, and would not light the player's own
tile (whose level is read from the local mic, not the published clip). An explicit
signal is deterministic and matches the "plays leave no durable fact" model
(decision 2) — it is in-call, best-effort, and never written to EVT.

**Tradeoff:** It introduces the first use of the LiveKit data channel in the app.
A dropped "stopped" packet could briefly over-light a tile, which the auto-expiry
bounds; a dropped "started" packet simply skips one highlight.

### 12. A trigger supersedes the triggering member's own previous clip

**Decision:** A member has at most one soundboard clip in the air. A successful
trigger stops whatever that member was already playing — locally and, by
unpublishing and stopping the track, for every listener — before starting the
new clip. Re-triggering the same sound restarts it rather than toggling it off.
The scope is deliberately per-player, not global.

**Why:** Layering was the original behaviour and made the panel a spam surface:
holding down clicks stacked several clips into the call at once, and the rate
limiter only bounded how fast that could happen, not how many sounds could
overlap. Replacement matches how members expect a soundboard to behave and makes
"stop that" reachable by triggering something else. Per-player scope is required
for fairness: a global "stop previous" would let any member silence another
member's clip, which is a griefing tool rather than a fix. Restart-over-toggle
keeps a single click predictable — the button always produces sound — and the
minimum-gap limiter already prevents rapid re-trigger abuse.

**Tradeoff:** Deliberate self-layering (playing two of your own clips together)
is no longer possible, and there is no explicit "stop" control; stopping early
means triggering another clip or letting it finish. The "playing" highlight is
held across the handover so it does not flicker between two clips.

### 13. Catalog changes propagate through authenticated server state

**Decision:** The complete soundboard catalog is carried inside the realtime
projection's authenticated server state, and the durable
`soundboard_sound_created`/`soundboard_sound_deleted` facts are fanned out to
every authenticated session, each mapping to one full server-state replacement.
The catalog is not delivered by a dedicated projection operation.

**Why:** The catalog was previously fetched once per client through
`SoundboardService.ListSounds` with no live channel at all, so an upload or
deletion was invisible to members who were already connected — most visibly to
anyone already in a voice call, who had to rejoin or reload before the new clip
appeared. The durable facts already existed; only live delivery was missing.
Riding on existing server state reuses the reducer and bridge that MOTD and
runtime settings already use, and keeps the change additive: an unknown
projection operation is fatal for a client's subscription, whereas an unknown
protobuf field is ignored, so older clients keep working and simply do not
converge live. The catalog is readable by every authenticated member, so it
needs no viewer-scoped authorization and no per-session visibility decision.

The catalog is a nested message rather than a bare repeated field so that it has
field presence. A client must be able to tell "this server sends no catalog"
(leave the locally loaded one alone) from "this server's catalog is empty"
(clear it, because the last sound was deleted). A bare repeated field decodes
identically in both cases, which would silently empty the soundboard of any
newer client talking to an older server.

**Tradeoff:** The whole catalog (capped at 48 small metadata rows) is re-sent on
every server-state upsert, including ones unrelated to soundboard, and a
soundboard change re-sends unrelated server state. Both are cheap. Clients
still perform the initial `ListSounds` read, so a projection replacement that
lands during an in-flight list response has to win explicitly; the store
versions its catalog so the older response cannot restore a deleted sound.

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
  FDR-021 (Admin Dashboard & System Monitoring), FDR-900 (Custom Emoji), FDR-901
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
