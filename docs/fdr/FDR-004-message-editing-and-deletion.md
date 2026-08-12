# FDR-004: Message Editing & Deletion

**Status:** Active
**Last reviewed:** 2026-08-12

## Overview

Authors can edit and delete their own messages; users with `message.manage` can edit and delete others' messages. Edits replace the message body; deletes remove the message's content and controls. A placeholder remains only when surviving conversation context depends on the deleted row.

## Behavior

- Authors can edit their own messages at any time; there is no time limit. `Server.messageEditWindowSeconds` reports `0`, which means "no limit", and clients must treat any value `<= 0` that way rather than as "already expired".
- Only the message body text can be edited. Attachments aren't editable as text but can be removed individually.
- Edited message bodies are capped at the same 10,000-byte limit as newly posted message bodies.
- Deletions remove the message body, attachments, link preview, and author-defined actions.
- A deleted message disappears immediately when it has no current attachments or link preview, reactions, or replies in its thread.
- A "Message deleted" placeholder remains when reactions or thread replies need the deleted row for context.
- Being a reply, a message inside a thread, or a channel echo does not by itself keep a deleted-message placeholder visible.
- Deleting an already-deleted message is a no-op.
- Editing a message does not re-resolve mentions. Mentions and mention notifications remain tied to the original posted message.
- Editing or deleting a thread reply that was echoed to the channel propagates to both visible artifacts automatically through the echo's `echoOfEventId` link.
- Deleting the echo artifact itself hides only the room-timeline echo. The original thread reply remains readable inside the thread.
- Individual attachments and link previews can be removed from a message by the author without deleting the whole message.
- ConnectRPC `MessageService.UpdateMessage`, `DeleteMessage`, `DeleteAttachment`, and `DeleteLinkPreview` expose message-management behavior through the shared core `MessageModel`.

## Design Decisions

### 1. No time limit on author edits

**Decision:** Authors can edit their own messages indefinitely. There is no server-enforced edit window, and no `core.MessageEditWindow` constant. `Server.messageEditWindowSeconds` is retained in the public API and reports `0` to advertise "no limit"; a positive value from an older server still means a real window, so clients gate on `> 0`.
**Why:** Chatto originally copied a short window (3 hours) to protect the integrity of the conversation log, but in practice the window mostly punished authors who spotted a mistake late: a typo in a pinned instruction or a wrong link stayed wrong unless a moderator stepped in. Edits are already visible as edits, so readers can see that a message changed. Removing the timer also removes the countdown-timer UI and the "why can't I edit this?" support question.
**Tradeoff:** An old message can be rewritten long after people responded to it. The edit marker and the durable event log are the mitigation: prior bodies remain distinct facts in `EVT`, and moderators keep `message.manage`. Operators who want a window back would need a config field and enforcement re-added.

### 2. Edit/delete changes are durable facts

**Decision:** Edits and deletions append durable message facts. The room timeline projection exposes the latest body or a retracted row after deletion; clients decide whether surviving context requires a placeholder.
**Why:** Message state is now event-sourced, so connected clients and rebuilt projections consume the same committed facts. This keeps edit/delete behavior consistent with the room event log. See ADR-033 and ADR-034.
**Tradeoff:** The user-facing timeline still exposes only the latest visible state. Showing prior versions would require a separate product decision and careful privacy handling.

### 3. Optimistic concurrency for edits

**Decision:** Edit mutations carry a revision token and fail if two edits race. The client must retry.
**Why:** A non-OCC update would risk silently overwriting concurrent edits — particularly bad when a moderator and the author both edit a message at once. See ADR-016.
**Tradeoff:** Clients need retry logic. In practice, conflicts are rare enough that a single retry almost always succeeds.

### 4. Edits don't re-resolve mentions

**Decision:** Editing a message changes the visible body but does not add, remove, dismiss, or re-send mention notifications.
**Why:** Mentions are post-time attention facts, not mutable properties of the latest body. This prevents retroactive pings and keeps edit replay independent from mutable usernames and private body payload retention. See FDR-006.
**Tradeoff:** If an author needs to notify someone they forgot, they must send a new message. If they remove an `@name` while editing, the original notification still reflects that the mention happened.

### 5. Echo propagation

**Decision:** Thread replies and their channel echoes are separate message events linked by `echoOfEventId`. An edit or delete targeting the original reply is applied to both visible artifacts by the read model. A delete targeting the echo's own event ID hides only the echo artifact from the room timeline.
**Why:** Message identity belongs to the EVT envelope, and `MessagePostedEvent` remains payload-only. The link preserves the user-facing "same reply shown twice" behavior without duplicating envelope metadata into payload fields. See FDR-003.
**Tradeoff:** Frontend has to distinguish direct echo deletes from original-reply deletes: direct echo deletes remove the echo row, while original deletes tombstone any loaded echoes.

### 6. Delete physically removes the body payload, not just hides it

**Decision:** Message body content is stored in private body payload events separate from public post/edit facts. Delete appends the public retraction fact, removes attachments from storage, and securely deletes body payload events where the storage backend supports it. Only context needed to render a retained placeholder remains.
**Why:** GDPR. Soft-delete leaves user-generated content in the database, which is the wrong default for an open-source chat app where users expect "delete" to mean delete. Separating public message facts from body payloads preserves the conversation audit trail while allowing body material to be removed. See ADR-007.
**Tradeoff:** No undo. Moderators can't restore a deleted message. Older embedded-body EVT histories remain readable for compatibility but cannot be physically shredded at body granularity.

### 7. Only contextual tombstones remain visible

**Decision:** The client immediately removes deleted rows that no longer carry visible attachments, previews, reactions, or thread replies. The same rule applies to deleted replies, thread messages, and channel echoes.
**Why:** A placeholder is useful when surviving interaction depends on it, but otherwise adds noise and makes short-lived interactive messages look active after deletion.
**Tradeoff:** A deletion can create an immediate visual gap. Older clients can display more tombstones than newer clients during mixed-version rollouts. Replies that merely point at a deleted message do not retain its placeholder unless they are represented by the message's existing thread summary.

## Permissions

- `message.manage` — edit and delete *other* users' messages.
- (No separate permission for editing/deleting one's own messages — that's gated by authorship only.)
- Attachment and link-preview removal is author-only; `message.manage` does not grant cross-user removal for those partial message edits.

## Related

- **ADRs:** ADR-007 (per-user encryption with crypto-shredding), ADR-011 (message body/event split), ADR-016 (OCC for message publishing), ADR-033 (event-sourced state), ADR-034 (single event stream), ADR-038 (room-owned thread state)
- **FDRs:** FDR-002 (Replies & Threads), FDR-003 (Thread Reply Echo), FDR-006 (@Mentions)
