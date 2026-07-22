package core

import (
	"context"

	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

// notifyVoiceCallStarted creates one pending notification for every other
// non-muted room member when the first participant starts a call session.
// Notification derivation is best-effort, matching message notifications: the
// durable call start remains committed if a recipient record cannot be stored.
func (c *ChattoCore) notifyVoiceCallStarted(ctx context.Context, kind RoomKind, roomID, actorID, callID string) {
	members, err := c.GetRoomMembersList(ctx, kind, roomID)
	if err != nil {
		c.logger.Warn("Failed to get room members for call-start notifications",
			"kind", kind, "room_id", roomID, "error", err)
		return
	}

	notifiedCount := 0
	for _, member := range members {
		recipientID := member.GetUserId()
		if recipientID == "" || recipientID == actorID {
			continue
		}

		level, err := c.GetEffectiveNotificationLevel(ctx, recipientID, roomID)
		if err != nil {
			c.logger.Warn("Failed to get notification level for call-start notification",
				"recipient_id", recipientID, "room_id", roomID, "error", err)
			continue
		}
		if level == corev1.NotificationLevel_NOTIFICATION_LEVEL_MUTED {
			continue
		}

		created, err := c.CreateNotification(ctx, recipientID, actorID, &corev1.Notification{
			// Keep a room-message payload as the compatibility carrier so an
			// older replica can still list and dismiss this row during rollout.
			Notification: &corev1.Notification_RoomMessage{
				RoomMessage: &corev1.RoomMessageNotification{RoomId: roomID},
			},
			VoiceCallStartedDetails: &corev1.VoiceCallStartedNotification{
				RoomId: roomID,
				CallId: callID,
			},
		})
		if err != nil {
			c.logger.Warn("Failed to create call-start notification",
				"recipient_id", recipientID, "actor_id", actorID,
				"kind", kind, "room_id", roomID, "call_id", callID, "error", err)
			continue
		}
		if created != nil {
			notifiedCount++
		}
	}

	if notifiedCount > 0 {
		c.logger.Debug("Created call-start notifications",
			"kind", kind, "room_id", roomID, "call_id", callID, "count", notifiedCount)
	}
}
