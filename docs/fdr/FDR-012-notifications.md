# FDR-012: Notifications

**Status:** Active
**Last reviewed:** 2026-07-22

## Overview

Chatto has a persistent notification system surfaced through a bell icon and notification center. Notifications represent things the user should pay attention to: DMs, @mentions of users/roles/virtual groups, replies to their own messages, reactions to their own messages, new posts in threads they follow, voice calls started by another room member, and (optionally) all messages in rooms they've subscribed to. Notification levels are configurable per space and per room.

## Behavior

- A bell icon shows an unread count and opens the notification center listing recent notifications.
- A notification appears for: a DM message, a mention that resolves to the user, a reply to one of the user's messages, an emoji reaction on one of the user's messages, a new reply in a thread the user follows, a voice call started by another member, or any root message in a room set to ALL_MESSAGES.
- All reactions on one message collapse into a single pending notification per author. It names the most recent reactor and emoji and counts how many reactions have been folded in; it does not name every reactor. Reacting to your own message never notifies you.
- The first member to join a new call session notifies every other current room member whose effective notification level is not MUTED. Later participants joining the same call do not create another call-start notification, and the starter is not notified about their own action.
- Mention notifications may come from direct `@username`, role `@role`, `@all`, or `@here` mentions. The bundled composer asks for confirmation before sending role, `@all`, or `@here` mentions, while API callers can post authorized messages directly.
- Notifications auto-expire after 90 days.
- Dismissing a notification removes it everywhere — across all the user's open tabs and devices.
- A notification sound plays and the in-app and installed PWA notification badges update in real time as new notifications arrive.
- While the installed PWA is visible, its app-icon badge shows the exact pending DM count when known. Other pending notifications, or an incomplete notification page that cannot provide an exact DM count, show a non-numeric attention flag. Ordinary unread rooms stay in the in-app sidebar unless the user has configured them to create notifications.
- Users can choose and locally shape the notification sound on each browser with volume, tone, and effect controls.
- Sidebar orange dots for mentions, replies, DMs, and all-message subscriptions derive from pending notification records.
- A recipient's Do Not Disturb presence still stores new notifications and updates counts, but those creation events are silent: no notification sound and no web push while DND is active.

## Notification Levels

Per space and per room, the user picks one of four levels:

- **DEFAULT** — inherit from the parent (room → space → system default of NORMAL).
- **MUTED** — suppress everything for this scope, including @mentions. The room doesn't even show as unread in the sidebar.
- **NORMAL** — notifications for mentions, DMs, thread replies, reactions to your own messages, and voice calls started in the room. Default behavior.
- **ALL_MESSAGES** — like NORMAL plus every root message in the room.

## Thread Follow

- Posting a reply in a thread automatically subscribes the user to that thread's reply notifications.
- A direct `@username` mention in a thread subscribes the mentioned user if they have never followed or explicitly unfollowed that thread before. Role mentions, `@all`, and `@here` notify according to mention rules but do not subscribe recipients.
- Thread followers can manually unfollow, and non-posters can manually follow.
- Followers receive a notification for new replies in the thread (skipping their own).
- Thread notifications respect room mute: a muted room produces no thread notifications even for followed threads.

## Design Decisions

### 1. Persistent notification model with live-event sync

**Decision:** Notifications are persistent objects stored per user in `RUNTIME_STATE` (`notification.{userId}.{notificationId}`), with a 90-day per-key TTL. Live events fire on create and dismiss to keep all the user's connected sessions in sync.
**Why:** Notifications need to survive a tab close (so the badge count is right when you come back tomorrow), and they need to be the same across devices. They are pending user-runtime state, not reconstructable content history, so `RUNTIME_STATE` is the right home. See ADR-012, ADR-028, and ADR-036.
**Tradeoff:** A notification dismissal anywhere clears it everywhere, even if the user wanted to dismiss only locally. The simpler model wins here — "I've seen it" is not device-specific.

### 2. Mute suppresses notifications AND unread

**Decision:** MUTED is stronger than "no pings": a muted room doesn't appear unread in the sidebar either.
**Why:** "Quiet" in chat apps often means "ignore this room completely". A user who mutes a room wants it out of their face, not just out of their alerts.
**Tradeoff:** Users who want "quiet but I still want to see if there's new stuff" don't have a third state. The two main modes (engage / ignore) cover the dominant use cases.

### 3. Mute trumps mentions

**Decision:** Mentioning a user in a muted room produces no notification. The mention text still highlights in the body if the user opens the room.
**Why:** Mute is the strongest "I don't want pings" signal. Allowing mentions through would defeat the muscle-memory of "mute the room to stop the spam".
**Tradeoff:** Coordinators can't reliably ping someone in a muted room. The mention still renders, so eventual visibility is preserved.

### 4. Thread auto-follow on post and direct mention

**Decision:** Posting in a thread automatically follows it, even if the poster previously unfollowed. A delivered direct `@username` mention inside a thread also follows the thread for that recipient, unless they explicitly unfollowed it before. Follow and unfollow state is represented by durable room-aggregate `ThreadFollowedEvent` and `ThreadUnfollowedEvent` facts, with a projection used for notification fanout and My Threads.
**Why:** People who participate in a thread almost always want to see the replies, and a direct mention makes the thread relevant to the recipient. Manual unfollow handles both the "I posted once and don't care any more" case and the "do not put this mentioned thread back in My Threads" case.
**Tradeoff:** A user who posts in many threads or is directly mentioned in many threads accumulates followed-thread subscriptions over time. The 90-day TTL on notifications limits the blast radius; the thread follow state itself is cheap to store.

### 5. Broadcast mentions are sender-controlled with bundled-client friction

**Decision:** `@all`, `@here`, and role mentions are allowed. The bundled
composer asks for confirmation before sending them, and muted recipients still
do not receive notifications. The server does not require a confirmation token
from API callers.
**Why:** Chatto needs explicit operational pings for small teams and rooms, but broad pings should be deliberate in the main client. Keeping the safeguard in the client avoids making the integration API carry a client-shaped confirmation token that does not provide meaningful abuse protection.
**Tradeoff:** Operators and integrations can force attention in a room unless recipients have muted it. This is acceptable because mute remains authoritative and integrations can add their own policy or UX friction where appropriate.

### 6. ALL_MESSAGES is a per-room subscription, not a per-message setting

**Decision:** "Notify me for every message" is configured per room by the user, not per message by the poster.
**Why:** Receiver-controlled subscription puts the ongoing ambient-notification choice with the person who has to live with the noise. Sender-controlled broadcasts are reserved for explicit mentions; the bundled client adds confirmation friction for role and room-wide mentions.
**Tradeoff:** Users who want every message still need to opt into ALL_MESSAGES; senders should use mentions only for attention events.

### 7. Push notifications piggyback on persistent notifications

**Decision:** A push notification fires when a persistent notification is created. If no persistent notification is created (because the room is muted, etc.), no push is sent either.
**Why:** Pushes and in-app notifications are the same logical event presented in two surfaces. Sharing the gating logic ensures they can't diverge. See FDR-013.
**Tradeoff:** No way to receive a push without also generating a persistent notification. Considered desirable: a push you can't find later in the app would be annoying.

### 8. No parallel mention-status flag

**Decision:** @mention orange dots are derived from pending mention notifications. Chatto does not maintain a separate `room_mention_status.*` flag.
**Why:** The separate flag duplicated notification state and had to be cleared in lockstep with notification dismissals and room reads. A single pending-notification model gives one source of truth for mention, reply, DM, and all-message attention indicators.
**Tradeoff:** Pending mention dots now have the same retention and dismissal semantics as notifications. This is deliberate: a mention that is no longer a pending notification is no longer pending attention.

### 9. Notification sound choice and shaping are local

**Decision:** Notification sound selection and sound-shaping controls are stored in browser-local preferences.
**Why:** They are playback-device preferences, not server behavior. Keeping them local matches the existing sound picker and avoids adding durable compatibility surface for an annoyance/subtlety control.
**Tradeoff:** A user who signs in on a new browser reconfigures sound taste there. Server-synced display settings remain separate.

### 10. Do Not Disturb silences alert delivery

**Decision:** Do Not Disturb is checked at notification creation time. While the recipient has live DND presence, Chatto still creates the persistent notification and publishes a silent live sync event, but it suppresses legacy attention live events, notification sounds, and web push delivery.
**Why:** DND means "do not interrupt me now", not "discard things I should review later". Storing the notification preserves missed activity in the notification center and sidebar counts, while the silent marker lets clients update state without making noise.
**Tradeoff:** A user may see badge/sidebar changes while actively viewing Chatto in DND. That is less disruptive than sound or push, and it avoids losing important mentions or DMs.

### 11. Installed-client badges share one pending-notification intent

**Decision:** The foreground client derives one installed-app badge intent from its authoritative pending-notification state and publishes it to every supported installed-client surface. A PWA can show a direct-message count or a generic flag; a native shell can adapt the same intent to the attention indicator its operating system supports.
**Why:** Reusing the notification model keeps the app icon, native taskbar, notification center, and sidebar from inventing separate attention state or clearing on different schedules.
**Tradeoff:** Some operating systems expose only a generic dot or overlay rather than an exact count. The notification center remains the exhaustive source for what needs attention.

### 12. Call-start notifications are scoped to the call session

**Decision:** The explicit user join that creates a new call session also creates one persistent notification for every other current non-muted room member. Later joins, LiveKit webhook confirmations, and reconciliation do not fan out another notification. DND recipients keep the pending notification but receive neither sound nor Web Push. The persisted row stores call details alongside a legacy-compatible room-message payload, so an older server replica can still list, count, navigate to, and dismiss it during a rolling upgrade.
**Why:** A call starting is a room-wide invitation worth surfacing at the normal notification level, while every participant join would create noisy duplicates. Tying fanout to the same successful transition that records `CallStartedEvent` makes the call session the idempotency boundary.
**Tradeoff:** Every non-muted room member is notified even if they rarely participate in calls. Members who do not want call-start attention from a room must mute that room, which also suppresses its other notifications. An older server/client pair degrades the new row to generic room activity until upgraded, while upgraded clients receive the precise call-start presentation.

### 13. Reaction notifications collapse per message

**Decision:** Adding a reaction to someone else's message notifies its author, gated only by room mute and by the author still being a room member. All reactions on one message collapse into a single pending notification: the first reaction creates the row, and each later reaction rewrites it in place with the newest reactor as actor, the newest emoji, and an incremented `reaction_count`. The rewrite deletes and re-creates the same key so the 90-day per-key TTL survives, then republishes the creation event; a concurrent write is detected by revision and retried from a fresh read. Push notifications for one message share a tag so the collapsed row replaces the earlier push instead of stacking.

**Why:** Reactions are the cheapest thing to send in the product, so one bell row per reactor would drown the notification centre on any popular message — but a reaction to your own message is still worth surfacing. Collapsing keeps the signal without the volume, and reusing the existing create/replace live-event path means every connected session re-renders through the normal authoritative notification replacement.

**Tradeoff:** The row names only the most recent reactor, so earlier reactors are visible only by opening the message. `reaction_count` counts notification-worthy activity rather than current reaction state: removing a reaction does not decrement it, and dismissing the notification restarts the count. Because collapse is a delete followed by a create rather than one atomic write, a concurrent reaction on another replica can lose a count increment; the notification itself still appears, which is what matters. There is no per-user opt-out, so a member who finds reaction notifications noisy must mute the room, which also suppresses its other notifications.

## Permissions

Notification preferences are user-scoped and don't require special permissions to manage. There's no permission gating the ability to mute or change levels.

## Related

- **ADRs:** ADR-012 (two-tier real-time events), ADR-028 (event-ID-keyed read state), ADR-036 (runtime state in `RUNTIME_STATE`), ADR-038 (room-owned thread state)
- **FDRs:** FDR-005 (Reactions), FDR-006 (@Mentions), FDR-007 (Direct Messages), FDR-013 (Web Push Notifications), FDR-016 (Voice Calls)
