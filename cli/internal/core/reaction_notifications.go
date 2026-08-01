package core

import (
	"context"
	"errors"

	"google.golang.org/protobuf/proto"

	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

// maxReactionNotificationCollapseRetries bounds how often the fanout re-reads
// the recipient's pending notifications after another replica collapsed into
// the same row first. Reaction notifications are best-effort, so exhausting the
// retries drops the notification rather than failing the reaction.
const maxReactionNotificationCollapseRetries = 3

// notifyMessageReaction creates or updates the pending notification telling a
// message author that someone reacted to their message.
//
// Reactions on one message collapse into a single pending notification per
// author: the first reaction creates the row, and later reactions rewrite it
// with the newest reactor and emoji and an incremented count. Without the
// collapse a popular message would push one bell row per reactor.
//
// messageEventID must already be canonical (see canonicalReactionMessageEventID)
// so a reaction on a channel echo collapses into the same row as one on the
// original thread reply.
//
// Notification derivation is best-effort, matching message and call-start
// notifications: the durable reaction stays committed if the recipient record
// cannot be written.
func (c *ChattoCore) notifyMessageReaction(ctx context.Context, kind RoomKind, roomID, messageEventID, emoji, reactorID string) {
	event, err := c.GetRoomEventByEventID(ctx, kind, roomID, messageEventID)
	if err != nil || event == nil {
		c.logger.Warn("Failed to get reacted-to message for notification",
			"kind", kind, "room_id", roomID, "message_event_id", messageEventID, "error", err)
		return
	}

	posted := event.GetMessagePosted()
	if posted == nil {
		return
	}
	authorID := event.GetActorId()
	if authorID == "" || authorID == reactorID {
		return
	}

	// A reaction must not reopen a room the author has since lost access to.
	isMember, err := c.RoomMembershipExists(ctx, kind, authorID, roomID)
	if err != nil {
		c.logger.Warn("Failed to check membership for reaction notification",
			"recipient_id", authorID, "kind", kind, "room_id", roomID, "error", err)
		return
	}
	if !isMember {
		return
	}

	level, err := c.GetEffectiveNotificationLevel(ctx, authorID, roomID)
	if err != nil {
		c.logger.Warn("Failed to get notification level for reaction notification, continuing",
			"recipient_id", authorID, "room_id", roomID, "error", err)
	} else if level == corev1.NotificationLevel_NOTIFICATION_LEVEL_MUTED {
		return
	}

	inThread := posted.GetInThread()
	for attempt := 0; attempt < maxReactionNotificationCollapseRetries; attempt++ {
		existing, err := c.findPendingNotification(ctx, authorID, func(notification *corev1.Notification) bool {
			payload := notification.GetReaction()
			return payload != nil &&
				payload.GetRoomId() == roomID &&
				payload.GetEventId() == messageEventID
		})
		if err != nil {
			c.logger.Warn("Failed to look up pending reaction notification",
				"recipient_id", authorID, "kind", kind, "room_id", roomID,
				"message_event_id", messageEventID, "error", err)
			return
		}

		if existing == nil {
			if _, err := c.CreateNotification(ctx, authorID, reactorID, &corev1.Notification{
				Notification: &corev1.Notification_Reaction{
					Reaction: &corev1.ReactionNotification{
						RoomId:        roomID,
						EventId:       messageEventID,
						Emoji:         emoji,
						InThread:      inThread,
						ReactionCount: 1,
					},
				},
			}); err != nil {
				c.logger.Warn("Failed to create reaction notification",
					"recipient_id", authorID, "actor_id", reactorID, "kind", kind,
					"room_id", roomID, "message_event_id", messageEventID, "error", err)
			}
			return
		}

		collapsed, ok := proto.Clone(existing.Notification).(*corev1.Notification)
		if !ok {
			return
		}
		payload := collapsed.GetReaction()
		payload.Emoji = emoji
		payload.InThread = inThread
		payload.ReactionCount++
		collapsed.ActorId = reactorID

		err = c.ReplacePendingNotification(ctx, collapsed, existing.Revision)
		if errors.Is(err, errNotificationRevisionConflict) {
			// Another replica collapsed into the same row first. Re-read so this
			// reaction is counted on top of theirs instead of overwriting it.
			continue
		}
		if err != nil {
			c.logger.Warn("Failed to collapse reaction notification",
				"recipient_id", authorID, "actor_id", reactorID, "kind", kind,
				"room_id", roomID, "message_event_id", messageEventID, "error", err)
		}
		return
	}

	c.logger.Warn("Gave up collapsing reaction notification after repeated conflicts",
		"recipient_id", authorID, "kind", kind, "room_id", roomID,
		"message_event_id", messageEventID)
}
