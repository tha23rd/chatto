package connectapi

import (
	"testing"

	"connectrpc.com/connect"

	apiv1 "hmans.de/chatto/internal/pb/chatto/api/v1"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

func TestNotificationServiceMapsVoiceCallStarted(t *testing.T) {
	env := newConnectAPITestEnv(t)
	ctx := withCaller(env.ctx, env.viewer)
	room := env.createJoinedRoom("voice-call-notification-room")
	actor, err := env.core.CreateUser(env.ctx, env.viewer.Id, "voice-call-notification-actor", "Call Starter", "password")
	if err != nil {
		t.Fatalf("CreateUser(actor): %v", err)
	}
	notification, err := env.core.CreateNotification(env.ctx, env.viewer.Id, actor.Id, &corev1.Notification{
		Notification: &corev1.Notification_RoomMessage{
			RoomMessage: &corev1.RoomMessageNotification{RoomId: room.Id},
		},
		VoiceCallStartedDetails: &corev1.VoiceCallStartedNotification{
			RoomId: room.Id,
			CallId: "call-123",
		},
	})
	if err != nil {
		t.Fatalf("CreateNotification: %v", err)
	}

	response, err := env.notifications.GetNotification(ctx, connect.NewRequest(&apiv1.GetNotificationRequest{
		NotificationId: notification.Id,
	}))
	if err != nil {
		t.Fatalf("GetNotification: %v", err)
	}
	item := response.Msg.GetNotification()
	started := item.GetVoiceCallStarted()
	if started.GetRoom().GetId() != room.Id || started.GetRoom().GetName() != room.Name || started.GetCallId() != "call-123" {
		t.Fatalf("voice call notification = %+v, want hydrated room and call ID", started)
	}
	if item.GetActor().GetId() != actor.Id {
		t.Fatalf("notification actor = %+v, want %s", item.GetActor(), actor.Id)
	}
}
